// Tables shared by the AI tooling: team house rules, app settings (approved
// model upgrades, review dates) and daily usage/cost totals.
//
// `store` is a small async adapter so the same code works on Turso (editorial
// assistant) and better-sqlite3 (podcast assistant):
//   { all(sql, args) -> rows, get(sql, args) -> row|null, run(sql, args) }

let store = null;

async function initStorage(s) {
  store = s;
  await store.run(`CREATE TABLE IF NOT EXISTS house_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    rule TEXT NOT NULL,
    proposed_text TEXT,
    context TEXT,
    submitted_by TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    review_note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    decided_at TEXT,
    decided_by TEXT
  )`);
  await store.run(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  await store.run(`CREATE TABLE IF NOT EXISTS ai_usage_daily (
    day TEXT NOT NULL,
    task TEXT NOT NULL,
    model TEXT NOT NULL,
    calls INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    searches INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    PRIMARY KEY (day, task, model)
  )`);
}

function getStore() { return store; }

async function getSetting(key, fallback = null) {
  if (!store) return fallback;
  const row = await store.get(`SELECT value FROM app_settings WHERE key = ?`, [key]);
  if (!row || row.value == null) return fallback;
  try { return JSON.parse(row.value); } catch (_) { return row.value; }
}

async function setSetting(key, value) {
  if (!store) return;
  await store.run(`INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(value)]);
}

async function recordUsage({ task, model, usage, cost }) {
  if (!store) return;
  const day = new Date().toISOString().slice(0, 10);
  await store.run(`INSERT INTO ai_usage_daily (day, task, model, calls, input_tokens, output_tokens, searches, cost)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(day, task, model) DO UPDATE SET
      calls = calls + 1,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      searches = searches + excluded.searches,
      cost = cost + excluded.cost`,
    [day, task, model, usage.input_tokens || 0, usage.output_tokens || 0, usage.server_tool_use?.web_search_requests || 0, cost || 0]);
}

async function usageSummary(days = 30) {
  if (!store) return { byTask: [], byDay: [], total: 0 };
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const byTask = await store.all(`SELECT task, model, SUM(calls) AS calls, SUM(searches) AS searches, SUM(cost) AS cost
    FROM ai_usage_daily WHERE day >= ? GROUP BY task, model ORDER BY cost DESC`, [since]);
  const byDay = await store.all(`SELECT day, SUM(cost) AS cost, SUM(calls) AS calls FROM ai_usage_daily WHERE day >= ? GROUP BY day ORDER BY day`, [since]);
  const total = byDay.reduce((s, r) => s + Number(r.cost || 0), 0);
  return { byTask, byDay, total };
}

module.exports = { initStorage, getStore, getSetting, setSetting, recordUsage, usageSummary };
