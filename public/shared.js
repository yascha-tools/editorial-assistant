// Shared front-end pieces: API helper, document renderer with highlights,
// option cards with pin / feedback / regenerate, and the house-rule modal.
(function () {
  const Shared = {};

  Shared.escapeHtml = function (text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  const esc = Shared.escapeHtml;

  Shared.api = async function (url, body, method) {
    const res = await fetch(url, {
      method: method || (body ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (res.status === 401 && !url.includes('/admin')) { window.location.href = '/login'; throw new Error('Not logged in'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  // Server-sent events over POST. onEvent receives each parsed message.
  Shared.stream = async function (url, body, onEvent) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '));
        if (line) onEvent(JSON.parse(line.slice(6)));
      }
    }
  };

  Shared.copy = function (text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1200);
    });
  };

  // Render a parsed document ({text, marks}) with highlight ranges:
  // highlights = [{start, end, cls, id, title}]
  Shared.renderDoc = function (doc, highlights) {
    const text = doc.text;
    const hls = (highlights || []).filter(h => h.start != null && h.end > h.start);
    const points = new Set([0, text.length]);
    for (const m of doc.marks) { points.add(m.start); points.add(m.end); }
    for (const h of hls) { points.add(h.start); points.add(h.end); }
    const paras = [];
    let p = 0;
    while (p <= text.length) {
      const brk = text.indexOf('\n\n', p);
      const end = brk === -1 ? text.length : brk;
      paras.push([p, end]);
      if (brk === -1) break;
      p = brk + 2;
    }
    const sorted = [...points].sort((a, b) => a - b);
    const endsAt = new Map();
    for (const h of hls) {
      if (!endsAt.has(h.end)) endsAt.set(h.end, []);
      endsAt.get(h.end).push(h);
    }
    let html = '';
    for (const [ps, pe] of paras) {
      const block = doc.marks.find(m => (m.type === 'h' || m.type === 'q') && m.start <= ps && m.end >= pe && pe > ps);
      const tag = block ? (block.type === 'h' ? 'h3' : 'blockquote') : 'p';
      let inner = '';
      const bounds = [ps, ...sorted.filter(x => x > ps && x < pe), pe];
      for (let i = 0; i < bounds.length - 1; i++) {
        const s = bounds[i], e = bounds[i + 1];
        if (e <= s) continue;
        let seg = esc(text.slice(s, e));
        const marks = doc.marks.filter(m => m.start <= s && m.end >= e);
        if (marks.some(m => m.type === 'b')) seg = `<strong>${seg}</strong>`;
        if (marks.some(m => m.type === 'i')) seg = `<em>${seg}</em>`;
        const link = marks.find(m => m.type === 'a');
        if (link) seg = `<a href="${esc(link.href)}" target="_blank" rel="noopener" class="doc-link">${seg}</a>`;
        const active = hls.filter(h => h.start <= s && h.end >= e);
        if (active.length) {
          const cls = active.map(h => h.cls).join(' ');
          const ids = active.map(h => h.id).join(' ');
          const title = active.map(h => h.title).filter(Boolean).join('\n\n');
          seg = `<mark class="hl ${esc(cls)}" data-ids="${esc(ids)}" title="${esc(title)}">${seg}</mark>`;
        }
        inner += seg;
        for (const h of endsAt.get(e) || []) {
          if (h.label != null) inner += `<sup class="hl-num ${esc(h.cls)}" data-ids="${esc(h.id)}">${esc(h.label)}</sup>`;
        }
      }
      html += `<${tag}>${inner || '&nbsp;'}</${tag}>`;
    }
    return html;
  };

  // ---------- Option cards with pin / feedback / regenerate ----------
  class OptionsPanel {
    constructor(opts) {
      Object.assign(this, opts); // root, endpoint, scope, payload(), extra, renderOption(o), copyItems(o), describe(o)
      this.rounds = [];
      this.pinned = [];
      this.loading = false;
      this.error = '';
      this.root.addEventListener('click', e => this.onClick(e));
      this.render();
    }

    reset() { this.rounds = []; this.pinned = []; this.error = ''; this.render(); }

    async generate({ feedback = '', variantOf = null } = {}) {
      this.loading = true;
      this.error = '';
      this.render();
      try {
        const body = {
          ...this.payload(),
          ...(this.extra || {}),
          history: this.rounds.map(r => ({ options: r.options, feedback: r.feedback })),
          pinned: this.pinned,
          feedback,
          variantOf,
        };
        const res = await Shared.api(this.endpoint, body);
        if (feedback && this.rounds.length) this.rounds[this.rounds.length - 1].feedback = feedback;
        this.rounds.push({ options: res.options || [], feedback: null, variantOf, meta: res });
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.render();
      }
    }

    current() { return this.rounds.length ? this.rounds[this.rounds.length - 1] : null; }

    card(o, where, idx) {
      const copies = this.copyItems(o).map((c, i) => `<button class="mini-btn" data-act="copy" data-where="${where}" data-idx="${idx}" data-copy="${i}">${esc(c.label)}</button>`).join('');
      const pin = where === 'pinned'
        ? `<button class="mini-btn" data-act="unpin" data-idx="${idx}">Unpin</button>`
        : `<button class="mini-btn" data-act="pin" data-where="${where}" data-idx="${idx}">📌 Pin</button>`;
      const more = `<button class="mini-btn" data-act="more" data-where="${where}" data-idx="${idx}">More like this</button>`;
      return `<div class="option-card ${where === 'pinned' ? 'pinned' : ''}">${this.renderOption(o)}<div class="option-actions">${copies}${pin}${more}</div></div>`;
    }

    findOption(where, idx) {
      if (where === 'pinned') return this.pinned[idx];
      if (where === 'current') return this.current()?.options[idx];
      const [r, i] = String(idx).split('-').map(Number);
      return this.rounds[r]?.options[i];
    }

    render() {
      const cur = this.current();
      let html = '';
      if (this.pinned.length) {
        html += `<div class="pinned-block"><div class="block-label">Pinned</div>${this.pinned.map((o, i) => this.card(o, 'pinned', i)).join('')}</div>`;
      }
      if (cur) {
        if (cur.variantOf) html += `<div class="block-label">Variations on “${esc(this.describe(cur.variantOf)).slice(0, 80)}”</div>`;
        html += cur.options.length ? cur.options.map((o, i) => this.card(o, 'current', i)).join('') : '<p class="muted">No new options came back — try different feedback.</p>';
      }
      if (this.loading) html += `<div class="inline-loading"><span class="spin-inline"></span> Generating…</div>`;
      if (this.error) html += `<div class="inline-error">${esc(this.error)}</div>`;
      if (cur || this.error) {
        html += `<div class="feedback-box">
          <textarea class="feedback-input" placeholder="Feedback for the next round (e.g. “less wonky”, “lean into the Europe angle”, “shorter deks”)"></textarea>
          <div class="feedback-actions">
            <button class="secondary-btn" data-act="regen" ${this.loading ? 'disabled' : ''}>Regenerate with feedback</button>
            <button class="link-btn" data-act="save-rule">Save feedback as a standing rule…</button>
          </div>
        </div>`;
      }
      const older = this.rounds.slice(0, -1);
      if (older.length) {
        html += `<details class="previous-rounds"><summary>Previous rounds (${older.length})</summary>${older.map((r, ri) =>
          `<div class="round"><div class="block-label">Round ${ri + 1}${r.feedback ? ` — your feedback: “${esc(r.feedback)}”` : ''}</div>${r.options.map((o, i) => this.card(o, 'old', `${ri}-${i}`)).join('')}</div>`).join('')}</details>`;
      }
      this.root.innerHTML = html;
    }

    onClick(e) {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'regen') {
        const fb = this.root.querySelector('.feedback-input')?.value || '';
        this.generate({ feedback: fb });
      } else if (act === 'save-rule') {
        const fb = this.root.querySelector('.feedback-input')?.value || '';
        Shared.openRuleModal({ scope: this.scope, text: fb, context: this.rounds.length ? `Options at the time:\n${this.current().options.map(o => '- ' + this.describe(o)).join('\n')}` : '' });
      } else {
        const o = this.findOption(btn.dataset.where, btn.dataset.idx);
        if (!o) return;
        if (act === 'copy') Shared.copy(this.copyItems(o)[Number(btn.dataset.copy)].text, btn);
        if (act === 'pin') { if (!this.pinned.includes(o)) this.pinned.push(o); this.render(); }
        if (act === 'unpin') { this.pinned.splice(Number(btn.dataset.idx), 1); this.render(); }
        if (act === 'more') this.generate({ variantOf: o });
      }
    }
  }
  Shared.OptionsPanel = OptionsPanel;

  // ---------- Single output with feedback / revise (intro copy, clips...) ----------
  // endpoint receives { ...payload(), history: [{result, feedback}], feedback }
  // and returns { result }. summarize(result) turns a result into text for history.
  class RevisionPanel {
    constructor(opts) {
      Object.assign(this, opts); // root, endpoint, scope, payload(), render(result), summarize(result), copyText(result)
      this.versions = [];
      this.loading = false;
      this.error = '';
      this.root.addEventListener('click', e => this.onClick(e));
      this.render();
    }

    reset() { this.versions = []; this.error = ''; this.render(); }
    current() { return this.versions.length ? this.versions[this.versions.length - 1] : null; }

    async generate({ feedback = '' } = {}) {
      this.loading = true;
      this.error = '';
      this.render();
      try {
        const body = {
          ...this.payload(),
          history: this.versions.map(v => ({ result: this.summarize(v.result), feedback: v.feedback })),
          feedback,
        };
        const res = await Shared.api(this.endpoint, body);
        if (feedback && this.versions.length) this.versions[this.versions.length - 1].feedback = feedback;
        this.versions.push({ result: res.result, feedback: null });
        if (this.onResult) this.onResult(res.result);
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.render();
      }
    }

    render() {
      const cur = this.current();
      let html = '';
      if (cur) {
        html += `<div class="revision-current">${this.render_(cur.result)}</div>`;
        if (this.copyText) html += `<div class="option-actions"><button class="mini-btn" data-act="copy-current">Copy</button></div>`;
      }
      if (this.loading) html += `<div class="inline-loading"><span class="spin-inline"></span> ${cur ? 'Revising' : 'Generating'}…</div>`;
      if (this.error) html += `<div class="inline-error">${esc(this.error)}</div>`;
      if (cur || this.error) {
        html += `<div class="feedback-box">
          <textarea class="feedback-input" placeholder="Feedback for the next version (e.g. “mention his new book”, “the third topic should be about China”)"></textarea>
          <div class="feedback-actions">
            <button class="secondary-btn btn-secondary" data-act="regen" ${this.loading ? 'disabled' : ''}>Regenerate with feedback</button>
            <button class="link-btn" data-act="save-rule">Save feedback as a standing rule…</button>
          </div>
        </div>`;
      }
      const older = this.versions.slice(0, -1);
      if (older.length) {
        html += `<details class="previous-rounds"><summary>Previous versions (${older.length})</summary>${older.map((v, i) =>
          `<div class="round"><div class="block-label">Version ${i + 1}${v.feedback ? ` — your feedback: “${esc(v.feedback)}”` : ''}</div><div class="revision-old">${this.render_(v.result)}</div></div>`).join('')}</details>`;
      }
      this.root.innerHTML = html;
    }

    render_(result) { return this.renderResult(result); }

    onClick(e) {
      const btn = e.target.closest('[data-act]');
      if (!btn || !this.root.contains(btn)) return;
      const act = btn.dataset.act;
      if (act === 'regen') this.generate({ feedback: this.root.querySelector('.feedback-input')?.value || '' });
      if (act === 'save-rule') {
        const fb = this.root.querySelector('.feedback-input')?.value || '';
        Shared.openRuleModal({ scope: this.scope, text: fb, context: this.current() ? this.summarize(this.current().result).slice(0, 1500) : '' });
      }
      if (act === 'copy-current' && this.current()) Shared.copy(this.copyText(this.current().result), btn);
      if (this.onAction) this.onAction(act, btn, this);
    }
  }
  Shared.RevisionPanel = RevisionPanel;

  // ---------- House-rule modal ----------
  let scopesCache = null;
  Shared.openRuleModal = async function ({ scope = '', text = '', context = '' } = {}) {
    document.getElementById('rule-modal')?.remove();
    if (!scopesCache) {
      try { scopesCache = (await Shared.api('/api/rules')).scopes; } catch (e) { scopesCache = []; }
    }
    let name = '';
    try { name = localStorage.getItem('pa_editor_name') || ''; } catch (_) { /* ignore */ }
    const modal = document.createElement('div');
    modal.id = 'rule-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `<div class="modal">
      <h3>Save a standing rule</h3>
      <p class="muted">Rules apply to everyone's future runs. A reviewer model checks each one; clear, narrow rules go live right away, and anything questionable goes to Yascha for approval.</p>
      <label>Tool</label>
      <select class="rule-scope">${scopesCache.map(s => `<option value="${esc(s.key)}" ${s.key === scope ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
      <label>Rule</label>
      <textarea class="rule-text" placeholder="e.g. Don't flag “toward” vs “towards”; never use the word “delve”">${esc(text)}</textarea>
      <label>Your name</label>
      <input class="rule-name" value="${esc(name)}" placeholder="So we know who suggested it">
      <div class="modal-result"></div>
      <div class="modal-buttons"><button class="secondary-btn rule-cancel">Close</button><button class="rule-submit">Submit rule</button></div>
    </div>`;
    document.body.appendChild(modal);
    const $ = sel => modal.querySelector(sel);
    $('.rule-cancel').onclick = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    $('.rule-submit').onclick = async () => {
      const btn = $('.rule-submit');
      const result = $('.modal-result');
      const submittedBy = $('.rule-name').value.trim();
      try { localStorage.setItem('pa_editor_name', submittedBy); } catch (_) { /* ignore */ }
      btn.disabled = true;
      btn.textContent = 'Reviewing…';
      result.className = 'modal-result';
      result.textContent = '';
      try {
        const r = await Shared.api('/api/rules', { scope: $('.rule-scope').value, text: $('.rule-text').value, submittedBy, context });
        if (r.status === 'active') {
          result.className = 'modal-result ok';
          result.innerHTML = `<strong>Saved — this is now a house rule:</strong> ${esc(r.rule)}`;
        } else if (r.status === 'pending') {
          result.className = 'modal-result pending';
          result.innerHTML = `<strong>Sent to Yascha for approval.</strong> ${esc(r.reason)}`;
        } else {
          result.className = 'modal-result pending';
          result.innerHTML = `<strong>Already covered by an existing rule.</strong> ${esc(r.reason)}`;
        }
        btn.textContent = 'Submitted';
      } catch (e) {
        result.className = 'modal-result err';
        result.textContent = e.message;
        btn.disabled = false;
        btn.textContent = 'Submit rule';
      }
    };
  };

  // ---------- Footer: which models are in use ----------
  Shared.loadFooter = async function (el) {
    if (!el) return;
    try {
      const meta = await Shared.api('/api/meta');
      el.innerHTML = `Models: ${Object.entries(meta.models).map(([t, m]) => `<code>${esc(m)}</code> (${esc(t)})`).join(' · ')}
        · <a href="/rules">House rules</a>${meta.pendingRules ? ` <span class="badge-pending">${meta.pendingRules} awaiting approval</span>` : ''} · <a href="/admin">Admin</a>`;
      return meta;
    } catch (_) { return null; }
  };

  window.Shared = Shared;
})();
