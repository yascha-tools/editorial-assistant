// Shared wrapper around the Anthropic API.
//
// Every model call in the app goes through callClaude(). It:
//   - picks the model for a tier ("top" / "standard" / "fast"), honouring any
//     upgrade an admin has approved (see lib/modelcheck.js)
//   - streams the response (required for long outputs) and reads text blocks by
//     type, since current models can open with a thinking block
//   - supports JSON structured outputs, server tools (web search / fetch) and
//     resumes "pause_turn" responses from long tool runs
//   - falls back to the pinned default if an approved model is unavailable
//   - logs token usage so the admin page can show what things cost

const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'models.config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const client = new Anthropic({ maxRetries: 4, timeout: 15 * 60 * 1000 });

let overrides = {};          // tier -> model id (approved upgrades, loaded from DB)
let usageSink = null;        // async fn(record) to persist usage
const unsupported = new Set(); // `${model}:effort` / `${model}:thinking` learned at runtime

function setModelOverrides(o) { overrides = { ...(o || {}) }; }
function setUsageSink(fn) { usageSink = fn; }
function defaultModelFor(tier) { return (config.tiers[tier] || config.tiers.standard).model; }
function modelFor(tier) { return overrides[tier] || defaultModelFor(tier); }
function tierInfo() {
  return Object.fromEntries(Object.entries(config.tiers).map(([tier, t]) => [tier, {
    ...t, model: modelFor(tier), defaultModel: t.model, overridden: !!overrides[tier]
  }]));
}

function estimateCost(model, usage) {
  const p = config.pricingPerMillionTokens[model] || config.pricingPerMillionTokens[defaultModelFor('standard')];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (input * p.input + (usage.output_tokens || 0) * p.output) / 1e6 + searches * config.webSearchCostPerThousand / 1000;
}

function todayLong() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

// Context every prompt gets, so the model never treats recent events as "future".
function dateContext() {
  return `Today's date is ${todayLong()}. Your training data may end some time before today, so the text can refer to real events you have not heard of. Never treat a date or event as wrong or "in the future" merely because you don't recognize it.`;
}

function isParamError(err, word) {
  return err?.status === 400 && String(err?.message || '').toLowerCase().includes(word);
}
function isModelUnavailable(err) {
  return err?.status === 404 || (err?.status === 400 && /model/i.test(String(err?.message || '')) && /not.*(found|exist|support)/i.test(String(err?.message || '')));
}

/**
 * @param {object} o
 * @param {string} o.task       label for usage logging (e.g. "copy-edit")
 * @param {string} [o.tier]     "top" | "standard" | "fast"  (default "standard")
 * @param {string} [o.effort]   "low" | "medium" | "high" | "xhigh" | "max"
 * @param {string|Array} [o.system]
 * @param {Array} [o.messages]  full message list, or use o.prompt for a single user turn
 * @param {string} [o.prompt]
 * @param {object} [o.schema]   JSON schema -> structured output; result.json is parsed
 * @param {Array} [o.tools]     e.g. webTools()
 * @param {number} [o.maxTokens]
 * @param {number} [o.maxContinuations] for pause_turn with server tools
 */
async function callClaude(o) {
  const tier = o.tier || 'standard';
  let model = modelFor(tier);
  const messages = o.messages ? [...o.messages] : [{ role: 'user', content: o.prompt }];
  const allBlocks = [];
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } };
  let continuations = 0;
  let final;

  while (true) {
    const params = {
      model,
      max_tokens: o.maxTokens || 16000,
      messages,
    };
    if (o.system) params.system = o.system;
    if (o.tools) params.tools = o.tools;
    if (!unsupported.has(`${model}:thinking`)) params.thinking = { type: 'adaptive' };
    const outputConfig = {};
    if (o.effort && !unsupported.has(`${model}:effort`)) outputConfig.effort = o.effort;
    if (o.schema) outputConfig.format = { type: 'json_schema', schema: o.schema };
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;

    let msg;
    try {
      msg = await client.messages.stream(params).finalMessage();
    } catch (err) {
      if (isParamError(err, 'effort') && !unsupported.has(`${model}:effort`)) { unsupported.add(`${model}:effort`); continue; }
      if (isParamError(err, 'thinking') && !unsupported.has(`${model}:thinking`)) { unsupported.add(`${model}:thinking`); continue; }
      if (overrides[tier] && model !== defaultModelFor(tier) && isModelUnavailable(err)) {
        console.error(`[claude] ${model} unavailable (${err.message}); falling back to ${defaultModelFor(tier)}`);
        model = defaultModelFor(tier);
        continue;
      }
      throw err;
    }

    allBlocks.push(...msg.content);
    const u = msg.usage || {};
    totalUsage.input_tokens += u.input_tokens || 0;
    totalUsage.output_tokens += u.output_tokens || 0;
    totalUsage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    totalUsage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    totalUsage.server_tool_use.web_search_requests += u.server_tool_use?.web_search_requests || 0;
    totalUsage.server_tool_use.web_fetch_requests += u.server_tool_use?.web_fetch_requests || 0;

    if (msg.stop_reason === 'pause_turn' && continuations < (o.maxContinuations ?? 6)) {
      continuations++;
      messages.push({ role: 'assistant', content: msg.content });
      continue;
    }
    final = msg;
    break;
  }

  const cost = estimateCost(model, totalUsage);
  console.log(`[claude] ${o.task || 'call'} model=${model} in=${totalUsage.input_tokens} out=${totalUsage.output_tokens} searches=${totalUsage.server_tool_use.web_search_requests} ~$${cost.toFixed(3)}`);
  if (usageSink) {
    usageSink({ task: o.task || 'call', model, usage: totalUsage, cost }).catch(e => console.error('usage log failed:', e.message));
  }

  if (final.stop_reason === 'refusal') throw new Error('The model declined to process this request.');
  const text = final.content.filter(b => b.type === 'text').map(b => b.text).join('');

  let json;
  if (o.schema) {
    if (final.stop_reason === 'max_tokens') throw new Error('The response was too long and got cut off. Try a shorter text.');
    json = JSON.parse(text);
  }
  return { text, json, model, usage: totalUsage, cost, blocks: allBlocks, stopReason: final.stop_reason };
}

// Pull JSON out of free text (used where structured outputs can't be combined
// with tools). Accepts a ```json fence or the outermost {...}/[...] span.
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const firstObj = text.indexOf('{'), lastObj = text.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) candidates.push(text.slice(firstObj, lastObj + 1));
  const firstArr = text.indexOf('['), lastArr = text.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) candidates.push(text.slice(firstArr, lastArr + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (_) { /* try next */ }
  }
  return null;
}

function webTools({ searches = 8, fetches = 6 } = {}) {
  return [
    { type: 'web_search_20250305', name: 'web_search', max_uses: searches },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: fetches, max_content_tokens: 30000 },
  ];
}

// Every URL the model actually saw via search/fetch, so cited sources can be
// checked against what was really retrieved.
function retrievedSources(blocks) {
  const map = new Map();
  for (const b of blocks || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) map.set(normalizeUrl(r.url), { url: r.url, title: r.title || r.url });
    }
    if (b.type === 'web_fetch_tool_result' && b.content?.url) {
      map.set(normalizeUrl(b.content.url), { url: b.content.url, title: b.content.content?.title || b.content.url });
    }
  }
  return map;
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString().replace(/\/$/, '');
    return s.replace(/^https?:\/\/(www\.)?/, '');
  } catch (_) { return String(u).trim(); }
}

module.exports = {
  callClaude, extractJson, webTools, retrievedSources, normalizeUrl,
  modelFor, defaultModelFor, tierInfo, setModelOverrides, setUsageSink,
  dateContext, todayLong, config, client,
};
