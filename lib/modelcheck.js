// Semi-automatic model upgrades.
//
// Once a day the app asks Anthropic's Models API which models exist. If a newer
// model is available in the same family as one of our tiers (e.g. a new Opus),
// and the last review was at least `reviewIntervalDays` ago (90 by default),
// the admin is alerted (banner on /admin, plus email if configured) and can
// approve the upgrade with one click. Nothing changes without that approval.

const { client, config, tierInfo, setModelOverrides } = require('./claude');
const { getSetting, setSetting } = require('./storage');
const { notifyAdmin, appUrl } = require('./notify');

function lineOf(m) {
  if (m.line) return String(m.line).toLowerCase();
  const match = String(m.id).match(/^claude-([a-z]+)/);
  return match ? match[1] : null;
}

async function loadOverrides() {
  const o = await getSetting('model_overrides', {});
  setModelOverrides(o || {});
  return o;
}

async function listModels() {
  const out = [];
  for await (const m of client.models.list({ limit: 100 })) out.push(m);
  return out;
}

async function checkForUpgrades() {
  const models = await listModels();
  const active = models.filter(m => !m.lifecycle || m.lifecycle === 'active');
  const tiers = tierInfo();
  const candidates = {};
  for (const [tier, t] of Object.entries(tiers)) {
    const current = models.find(m => m.id === t.model);
    const line = current ? lineOf(current) : t.line;
    const currentDate = current ? new Date(current.created_at).getTime() : 0;
    const newer = active
      .filter(m => lineOf(m) === line && m.id !== t.model && new Date(m.created_at).getTime() > currentDate)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    if (newer.length) {
      candidates[tier] = { id: newer[0].id, name: newer[0].display_name || newer[0].id, created_at: newer[0].created_at };
    }
    if (current?.retires_at) {
      candidates[tier] = { ...(candidates[tier] || {}), currentRetiresAt: current.retires_at };
    }
  }
  const knownLines = new Set(Object.values(tiers).map(t => t.line));
  const newestTierDate = Math.max(...Object.values(tiers).map(t => {
    const m = models.find(x => x.id === t.model);
    return m ? new Date(m.created_at).getTime() : 0;
  }));
  const otherNew = active
    .filter(m => !knownLines.has(lineOf(m)) && new Date(m.created_at).getTime() > newestTierDate)
    .map(m => ({ id: m.id, name: m.display_name || m.id, created_at: m.created_at }));

  const result = { checkedAt: new Date().toISOString(), candidates, otherNew };
  await setSetting('model_check', result);
  return result;
}

async function lastReviewed() {
  return (await getSetting('models_last_reviewed', null)) || config.lastReviewed;
}

async function status() {
  const reviewed = await lastReviewed();
  const next = new Date(new Date(reviewed).getTime() + config.reviewIntervalDays * 864e5);
  const check = await getSetting('model_check', null);
  const upgradeable = check ? Object.values(check.candidates || {}).some(c => c.id) || (check.otherNew || []).length > 0 : false;
  return {
    tiers: tierInfo(),
    lastReviewed: reviewed,
    nextReview: next.toISOString().slice(0, 10),
    due: Date.now() >= next.getTime(),
    check,
    actionNeeded: Date.now() >= next.getTime() && upgradeable,
  };
}

async function approveUpgrade(tier, modelId) {
  const check = await getSetting('model_check', null);
  const allowed = check?.candidates?.[tier]?.id === modelId;
  if (!allowed) throw new Error('That model is not a current upgrade candidate for this tier. Run a fresh check first.');
  const overrides = (await getSetting('model_overrides', {})) || {};
  overrides[tier] = modelId;
  await setSetting('model_overrides', overrides);
  setModelOverrides(overrides);
  delete check.candidates[tier];
  await setSetting('model_check', check);
  await setSetting('models_last_reviewed', new Date().toISOString().slice(0, 10));
}

async function revertTier(tier) {
  const overrides = (await getSetting('model_overrides', {})) || {};
  delete overrides[tier];
  await setSetting('model_overrides', overrides);
  setModelOverrides(overrides);
}

async function snooze() {
  await setSetting('models_last_reviewed', new Date().toISOString().slice(0, 10));
}

async function dailyCheck() {
  try {
    await checkForUpgrades();
    const s = await status();
    if (!s.actionNeeded) return;
    const key = JSON.stringify([s.check.candidates, s.check.otherNew]);
    if ((await getSetting('model_alert_sent_for', null)) === key) return;
    const lines = Object.entries(s.check.candidates).filter(([, c]) => c.id)
      .map(([tier, c]) => `- ${s.tiers[tier].label} tier: ${s.tiers[tier].model} → ${c.name} (${c.id})`);
    for (const m of s.check.otherNew || []) lines.push(`- New model family: ${m.name} (${m.id})`);
    await notifyAdmin('[Persuasion tools] Quarterly model review: upgrades available',
      `Newer Claude models are available:\n\n${lines.join('\n')}\n\nReview and approve (or snooze for another quarter): ${appUrl('/admin')}`);
    await setSetting('model_alert_sent_for', key);
  } catch (e) {
    console.error('[modelcheck] check failed:', e.message);
  }
}

function startModelChecks() {
  setTimeout(dailyCheck, 60 * 1000);
  setInterval(dailyCheck, 24 * 3600 * 1000);
}

module.exports = { loadOverrides, checkForUpgrades, status, approveUpgrade, revertTier, snooze, startModelChecks };
