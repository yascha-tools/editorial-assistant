// Admin page: approve pending house rules, review model upgrades, see usage.
(function () {
  const { api, escapeHtml: esc } = window.Shared;
  const $ = id => document.getElementById(id);
  let state = null;

  async function load() {
    try {
      state = await api('/api/admin/state');
      $('login').classList.add('hidden');
      $('admin').classList.remove('hidden');
      render();
    } catch (e) {
      $('admin').classList.add('hidden');
      $('login').classList.remove('hidden');
    }
  }

  const scopeLabel = key => (state.scopes.find(s => s.key === key) || {}).label || key;

  function render() {
    const pending = state.rules.filter(r => r.status === 'pending');
    const active = state.rules.filter(r => r.status === 'active');
    const rejected = state.rules.filter(r => r.status === 'rejected');
    const m = state.models;

    let alerts = '';
    if (m.actionNeeded) alerts += `<div class="alert">Quarterly model review: newer models are available — see <strong>Models</strong> below.</div>`;
    if (pending.length) alerts += `<div class="alert">${pending.length} rule${pending.length === 1 ? '' : 's'} waiting for your approval.</div>`;
    if (!state.notificationsConfigured) alerts += `<div class="alert subtle">Email alerts are off. To get an email when a rule needs approval or a model review is due, set SMTP_URL and ADMIN_EMAIL on Render.</div>`;
    $('alerts').innerHTML = alerts;

    $('pending-rules').innerHTML = pending.length ? pending.map(r => `
      <div class="rule-row" data-id="${r.id}">
        <div class="rule-meta"><span class="cat">${esc(scopeLabel(r.scope))}</span> proposed by ${esc(r.submitted_by || 'unknown')} · ${esc((r.created_at || '').slice(0, 10))}</div>
        <div class="muted small">As submitted: “${esc(r.proposed_text || '')}”</div>
        <textarea class="rule-edit">${esc(r.rule)}</textarea>
        <div class="muted small">Reviewer's note: ${esc(r.review_note || '')}</div>
        ${r.context ? `<details class="small"><summary>Where it came up</summary><pre>${esc(r.context)}</pre></details>` : ''}
        <div class="item-actions"><button data-act="approve">Approve</button><button class="secondary-btn" data-act="reject">Reject</button></div>
      </div>`).join('') : '<p class="muted">Nothing waiting.</p>';

    $('active-rules').innerHTML = active.length ? state.scopes.map(s => {
      const rs = active.filter(r => r.scope === s.key);
      if (!rs.length) return '';
      return `<h3>${esc(s.label)}</h3>${rs.map(r => `
        <div class="rule-row" data-id="${r.id}">
          <textarea class="rule-edit">${esc(r.rule)}</textarea>
          <div class="rule-meta small">by ${esc(r.submitted_by || 'unknown')} · ${r.decided_by === 'auto-review' ? 'auto-approved' : 'approved by admin'}</div>
          <div class="item-actions"><button class="mini-btn" data-act="save">Save edit</button><button class="mini-btn" data-act="delete">Delete</button></div>
        </div>`).join('')}`;
    }).join('') : '<p class="muted">No house rules yet.</p>';

    $('rejected-rules').innerHTML = rejected.length ? rejected.map(r => `<div class="rule-row" data-id="${r.id}"><span class="cat">${esc(scopeLabel(r.scope))}</span> ${esc(r.rule)} <span class="muted small">(by ${esc(r.submitted_by || 'unknown')})</span> <button class="mini-btn" data-act="delete">Delete</button></div>`).join('') : '<p class="muted">None.</p>';

    const candidates = (m.check && m.check.candidates) || {};
    $('models').innerHTML = `
      <p class="muted">Last reviewed ${esc(m.lastReviewed)} · next review due ${esc(m.nextReview)}${m.check ? ` · last checked ${esc(m.check.checkedAt.slice(0, 16).replace('T', ' '))} UTC` : ''}</p>
      <table class="data-table"><thead><tr><th>Tier</th><th>Used for</th><th>Model in use</th><th>Newer model available</th><th></th></tr></thead><tbody>
      ${Object.entries(m.tiers).map(([tier, t]) => {
        const c = candidates[tier];
        return `<tr data-tier="${tier}">
          <td>${esc(t.label)}</td>
          <td class="small">${esc(t.usedFor || '')}</td>
          <td><code>${esc(t.model)}</code>${t.overridden ? ` <span class="muted small">(upgraded from ${esc(t.defaultModel)})</span>` : ''}${c && c.currentRetiresAt ? `<div class="small warn-text">Retires ${esc(c.currentRetiresAt.slice(0, 10))}</div>` : ''}</td>
          <td>${c && c.id ? `<code>${esc(c.id)}</code><div class="small muted">${esc(c.name)} · released ${esc((c.created_at || '').slice(0, 10))}</div>` : '<span class="muted">—</span>'}</td>
          <td>${c && c.id ? `<button class="mini-btn" data-act="approve-model" data-model="${esc(c.id)}">Approve upgrade</button>` : ''}${t.overridden ? `<button class="mini-btn" data-act="revert-model">Revert</button>` : ''}</td>
        </tr>`;
      }).join('')}
      </tbody></table>
      ${(m.check && m.check.otherNew && m.check.otherNew.length) ? `<p class="small">Also new: ${m.check.otherNew.map(x => `<code>${esc(x.id)}</code>`).join(', ')} (a model family the tools don't use yet).</p>` : ''}
      ${m.due ? `<p><button class="secondary-btn" data-act="snooze">Mark reviewed — ask again next quarter</button></p>` : ''}
      <p class="muted small">Upgrades take effect immediately for everyone. If an approved model ever fails, the tool falls back to the default automatically.</p>`;

    const u = state.usage;
    $('usage').innerHTML = `<p><strong>$${Number(u.total || 0).toFixed(2)}</strong> estimated over the last 30 days.</p>
      ${u.byTask.length ? `<table class="data-table"><thead><tr><th>Task</th><th>Model</th><th>Calls</th><th>Web searches</th><th>Est. cost</th></tr></thead><tbody>
      ${u.byTask.map(r => `<tr><td>${esc(r.task)}</td><td><code>${esc(r.model)}</code></td><td>${r.calls}</td><td>${r.searches || 0}</td><td>$${Number(r.cost || 0).toFixed(2)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No usage recorded yet.</p>'}`;
  }

  document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const row = btn.closest('.rule-row');
    const tierRow = btn.closest('tr[data-tier]');
    btn.disabled = true;
    try {
      if (act === 'approve' || act === 'reject') {
        await api(`/api/admin/rules/${row.dataset.id}/decide`, { approve: act === 'approve', rule: row.querySelector('.rule-edit').value });
      } else if (act === 'save') {
        await api(`/api/admin/rules/${row.dataset.id}`, { rule: row.querySelector('.rule-edit').value }, 'PUT');
      } else if (act === 'delete') {
        if (!confirm('Delete this rule?')) { btn.disabled = false; return; }
        await api(`/api/admin/rules/${row.dataset.id}`, null, 'DELETE');
      } else if (act === 'approve-model') {
        if (!confirm(`Switch the ${tierRow.dataset.tier} tier to ${btn.dataset.model} for everyone?`)) { btn.disabled = false; return; }
        await api('/api/admin/models/approve', { tier: tierRow.dataset.tier, model: btn.dataset.model });
      } else if (act === 'revert-model') {
        await api('/api/admin/models/revert', { tier: tierRow.dataset.tier });
      } else if (act === 'snooze') {
        await api('/api/admin/models/snooze', {});
      }
      await load();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  $('check-models').addEventListener('click', async () => {
    const b = $('check-models');
    b.disabled = true;
    b.textContent = 'Checking…';
    try { await api('/api/admin/models/check', {}); await load(); }
    catch (e) { alert(e.message); }
    b.disabled = false;
    b.textContent = 'Check for new models now';
  });

  async function login() {
    $('login-error').textContent = '';
    try {
      await api('/api/admin/login', { password: $('admin-password').value });
      await load();
    } catch (e) { $('login-error').textContent = e.message; }
  }
  $('admin-login-btn').addEventListener('click', login);
  $('admin-password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('admin-logout').addEventListener('click', async () => { await api('/api/admin/logout', {}); load(); });

  load();
})();
