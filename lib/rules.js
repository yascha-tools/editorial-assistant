// Team "house rules": standing feedback anyone can save (e.g. "don't flag
// 'toward'", "never use 'delve' in deks"). Each proposed rule is reviewed by a
// model against the style guide and existing rules. Clear, narrow rules go live
// immediately; anything questionable waits for the admin's approval.

const { callClaude } = require('./claude');
const { getStore } = require('./storage');
const { notifyAdmin, appUrl } = require('./notify');

let scopes = {}; // key -> { label, guide: () => string }

function registerScopes(s) { scopes = s; }
function scopeList() { return Object.entries(scopes).map(([key, v]) => ({ key, label: v.label })); }

async function activeRules(scope) {
  const store = getStore();
  if (!store) return [];
  return store.all(`SELECT id, scope, rule FROM house_rules WHERE status = 'active' AND scope = ? ORDER BY id`, [scope]);
}

// Text block appended to prompts. Team rules win over the general guide.
async function rulesForPrompt(scope) {
  const rules = await activeRules(scope);
  if (!rules.length) return '';
  return `\n\n<house_rules>\nStanding rules from the Persuasion team. They override the general guide where the two conflict:\n${rules.map(r => `- ${r.rule}`).join('\n')}\n</house_rules>\n`;
}

async function listRules({ includeRejected = false } = {}) {
  const store = getStore();
  if (!store) return [];
  const where = includeRejected ? '' : `WHERE status != 'rejected'`;
  return store.all(`SELECT * FROM house_rules ${where} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, scope, id DESC`);
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['accept', 'needs_approval', 'duplicate'] },
    rule: { type: 'string', description: 'The rule rewritten as one clear, specific, imperative instruction for the AI tool. Keep the submitter\'s intent and scope; do not broaden it.' },
    reason: { type: 'string', description: 'One or two sentences explaining the decision, addressed to the editor who submitted it.' },
  },
  required: ['decision', 'rule', 'reason'],
  additionalProperties: false,
};

async function submitRule({ scope, text, submittedBy, context }) {
  const store = getStore();
  if (!store) throw new Error('Rules need the database, which is not configured.');
  if (!scopes[scope]) throw new Error('Unknown section for this rule.');
  const proposed = String(text || '').trim();
  if (!proposed) throw new Error('The rule is empty.');

  const existing = await activeRules(scope);
  const prompt = `You maintain the house rules for an AI editorial tool used by the staff of Persuasion, a magazine of liberal democratic ideas. A team member wants to add a standing rule to the "${scopes[scope].label}" tool. Decide whether it can go live immediately or needs the editor-in-chief's approval.

<style_guide>
${scopes[scope].guide() || '(none)'}
</style_guide>

<existing_rules>
${existing.length ? existing.map(r => `- ${r.rule}`).join('\n') : '(none)'}
</existing_rules>

<proposed_rule submitted_by="${(submittedBy || 'unknown').replace(/"/g, '')}">
${proposed}
</proposed_rule>
${context ? `\n<context_where_it_came_up>\n${String(context).slice(0, 2000)}\n</context_where_it_came_up>\n` : ''}
Choose "accept" only if the rule is clear, specific, consistent with the style guide and existing rules, and plainly an improvement — for example, stopping a recurring false positive, or recording a narrow house preference.

Choose "needs_approval" if any of these apply:
- it contradicts the style guide or an existing rule, or changes an established house convention
- it is broad enough to switch off a whole class of checks (e.g. "stop flagging grammar", "don't check quotes")
- it would weaken fact-checking, accuracy, or legal-risk flags
- it reflects a political or ideological slant, or concerns how specific people or groups are treated
- it is vague, looks like a misunderstanding or a one-off preference for a single article, or you are unsure

Choose "duplicate" if an existing rule already covers it.

When in doubt, choose "needs_approval".`;

  const { json } = await callClaude({ task: 'rule-review', tier: 'standard', effort: 'medium', prompt, schema: REVIEW_SCHEMA, maxTokens: 4000 });
  const decision = String(json.decision).toLowerCase();

  if (decision === 'duplicate') {
    return { status: 'duplicate', rule: json.rule, reason: json.reason };
  }
  const status = decision === 'accept' ? 'active' : 'pending';
  await store.run(`INSERT INTO house_rules (scope, rule, proposed_text, context, submitted_by, status, review_note, decided_at, decided_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [scope, json.rule, proposed, context ? String(context).slice(0, 2000) : null, submittedBy || null, status, json.reason,
     status === 'active' ? new Date().toISOString() : null, status === 'active' ? 'auto-review' : null]);

  if (status === 'pending') {
    notifyAdmin(`[Persuasion tools] Rule awaiting your approval (${scopes[scope].label})`,
      `${submittedBy || 'Someone'} proposed a house rule for ${scopes[scope].label}:\n\n"${proposed}"\n\nReviewer's note: ${json.reason}\n\nApprove or reject it here: ${appUrl('/admin')}`);
  }
  return { status, rule: json.rule, reason: json.reason };
}

async function decideRule(id, { approve, editedRule, by }) {
  const store = getStore();
  const row = await store.get(`SELECT * FROM house_rules WHERE id = ?`, [id]);
  if (!row) throw new Error('Rule not found');
  await store.run(`UPDATE house_rules SET status = ?, rule = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
    [approve ? 'active' : 'rejected', (editedRule && editedRule.trim()) || row.rule, new Date().toISOString(), by || 'admin', id]);
}

async function updateRule(id, text) {
  await getStore().run(`UPDATE house_rules SET rule = ? WHERE id = ?`, [text, id]);
}

async function deleteRule(id) {
  await getStore().run(`DELETE FROM house_rules WHERE id = ?`, [id]);
}

async function pendingCount() {
  const store = getStore();
  if (!store) return 0;
  const row = await store.get(`SELECT COUNT(*) AS n FROM house_rules WHERE status = 'pending'`);
  return Number(row?.n || 0);
}

module.exports = { registerScopes, scopeList, rulesForPrompt, listRules, submitRule, decideRule, updateRule, deleteRule, pendingCount };
