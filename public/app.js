// Persuasion Editorial Assistant — front end
const { api, stream, escapeHtml: esc, renderDoc, OptionsPanel, openRuleModal, copy } = window.Shared;
const $ = id => document.getElementById(id);

const PLATFORMS = {
  substack: { label: 'Substack Notes', limit: 1500 },
  twitter: { label: 'X', limit: 256 },
  linkedin: { label: 'LinkedIn', limit: 1300 },
  instagram: { label: 'Instagram', limit: 2200 },
};

// Cmd/Ctrl+A inside a result box selects just that box
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    const el = document.activeElement;
    if (el && el.classList.contains('output-box')) {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
});

// ---------------- Style guides ----------------
const guideEls = { headlines: $('headlines-guide'), socialMedia: $('social-guide'), copyEdit: $('copyedit-guide'), factCheck: $('factcheck-guide') };
const originalGuides = {};
(async function loadStyleGuides() {
  try {
    const data = await api('/api/style-guides');
    for (const k of Object.keys(guideEls)) { guideEls[k].value = data[k] || ''; originalGuides[k] = data[k] || ''; }
  } catch (err) { console.error('Failed to load style guides:', err); }
})();
// Only send a guide when the editor changed it this session
function guideOverride(key) {
  const v = guideEls[key].value;
  return v !== originalGuides[key] ? v : undefined;
}
$('toggle-style-guides').addEventListener('click', () => {
  $('style-guides-panel').classList.toggle('hidden');
  $('toggle-style-guides').classList.toggle('active');
});
$('propose-rule-link').addEventListener('click', e => { e.preventDefault(); openRuleModal({}); });

// ---------------- Article input ----------------
const articleText = $('article-text');
const titleInput = $('current-title');
const dekInput = $('current-dek');
let formattingSource = 'plain';
let titleTouched = false;
titleInput.addEventListener('input', () => { titleTouched = true; });

function hasMarkup(text) {
  return /(^|[^*\w])\*[^*\s][^*\n]*\*(?!\w)/.test(text) || /\[[^\]]+\]\(https?:\/\//.test(text);
}
function formattingFor(text) {
  return formattingSource === 'rich' || hasMarkup(text) ? 'rich' : 'plain';
}
function guessTitle(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return '';
  const first = lines[0].replace(/^#+\s*/, '').replace(/[*_]/g, '');
  return /^#\s/.test(lines[0]) || (first.split(/\s+/).length <= 20 && !/[.:;,]$/.test(first)) ? first : '';
}
function maybeFillTitle(title, dek) {
  if (!titleTouched && !titleInput.value.trim() && title) titleInput.value = title;
  if (dek && !dekInput.value.trim()) dekInput.value = dek;
}

$('fetch-doc-btn').addEventListener('click', async () => {
  const url = $('doc-url').value.trim();
  const status = $('doc-status');
  if (!url) { status.textContent = 'Please enter a URL'; status.className = 'doc-status error'; return; }
  status.textContent = 'Fetching document…';
  status.className = 'doc-status';
  $('fetch-doc-btn').disabled = true;
  try {
    const data = await api('/api/fetch-doc', { url });
    articleText.value = data.content;
    formattingSource = 'rich';
    titleTouched = false;
    titleInput.value = data.title || '';
    dekInput.value = data.subtitle || '';
    status.textContent = 'Document loaded — italics and links preserved.';
    status.className = 'doc-status success';
  } catch (err) {
    status.textContent = err.message;
    status.className = 'doc-status error';
  } finally {
    $('fetch-doc-btn').disabled = false;
  }
});

// Paste: convert rich clipboard content (Google Docs, Word, web pages) so
// italics and links survive as *asterisks* and [text](url).
articleText.addEventListener('paste', async (e) => {
  const html = e.clipboardData?.getData('text/html');
  if (!html) return;
  e.preventDefault();
  const plain = e.clipboardData.getData('text/plain');
  const start = articleText.selectionStart, end = articleText.selectionEnd;
  const wasEmpty = !articleText.value.trim();
  let insert = plain;
  try {
    const data = await api('/api/convert-html', { html });
    if (data.text && data.text.trim()) {
      insert = data.text;
      formattingSource = 'rich';
      if (wasEmpty) maybeFillTitle(data.title || guessTitle(data.text));
    }
  } catch (_) { /* fall back to plain text */ }
  articleText.setRangeText(insert, start, end, 'end');
  articleText.dispatchEvent(new Event('input'));
});
articleText.addEventListener('input', () => {
  if (!articleText.value.trim()) { formattingSource = 'plain'; return; }
  maybeFillTitle(guessTitle(articleText.value));
});

function basePayload() {
  return {
    article: articleText.value.trim(),
    currentTitle: titleInput.value.trim(),
    currentDek: dekInput.value.trim(),
    guidance: $('guidance').value.trim(),
  };
}

// ---------------- Headlines ----------------
const headlinesPanel = new OptionsPanel({
  root: $('headlines-panel'),
  endpoint: '/api/headlines',
  scope: 'headlines',
  payload: () => ({ ...basePayload(), styleGuide: guideOverride('headlines') }),
  renderOption: o => `<span class="headline-style">${esc(o.style)}</span><h3>${esc(o.headline)}</h3><p>${esc(o.dek)}</p>`,
  copyItems: o => [{ label: 'Copy headline', text: o.headline }, { label: 'Copy dek', text: o.dek }, { label: 'Copy both', text: `${o.headline}\n\n${o.dek}` }],
  describe: o => `${o.headline} — ${o.dek}`,
});

// ---------------- Social ----------------
const socialPanels = {};
let currentPlatform = 'substack';
$('social-tabs').innerHTML = Object.entries(PLATFORMS).map(([k, p]) =>
  `<button class="tab-btn ${k === currentPlatform ? 'active' : ''}" data-platform="${k}">${esc(p.label)}</button>`).join('');
$('social-panels').innerHTML = Object.keys(PLATFORMS).map(k =>
  `<div class="social-panel ${k === currentPlatform ? '' : 'hidden'}" id="social-panel-${k}"></div>`).join('');
for (const [k, p] of Object.entries(PLATFORMS)) {
  socialPanels[k] = new OptionsPanel({
    root: $(`social-panel-${k}`),
    endpoint: '/api/social',
    scope: 'social',
    extra: { platform: k },
    payload: () => ({ ...basePayload(), styleGuide: guideOverride('socialMedia') }),
    renderOption: o => `<p class="social-text">${esc(o.text).replace(/\n/g, '<br>')}</p><div class="char-count ${o.text.length > p.limit ? 'over' : ''}">${o.text.length} / ${p.limit} characters${k === 'twitter' ? ' (leaves room for the link)' : ''}</div>`,
    copyItems: o => [{ label: 'Copy', text: o.text }],
    describe: o => o.text,
  });
}
$('social-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  currentPlatform = btn.dataset.platform;
  document.querySelectorAll('#social-tabs .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.social-panel').forEach(el => el.classList.toggle('hidden', el.id !== `social-panel-${currentPlatform}`));
});

// ---------------- Copy-edit ----------------
let copyEdit = null; // { doc, issues, dismissed:Set }

function renderCopyEdit() {
  const { doc, issues, dismissed } = copyEdit;
  const visible = issues.filter(i => !dismissed.has(i.id));
  const highlights = visible.filter(i => i.start != null).map(i => ({
    start: i.start, end: i.end, id: `ce${i.id}`, label: i.id,
    cls: i.severity === 'error' ? 'ce-error' : 'ce-suggestion',
    title: `${i.id}. “${i.quote}” → “${i.replacement}”\n${i.explanation}`,
  }));
  $('copyedit-doc').innerHTML = renderDoc(doc, highlights);
  const item = i => `<li class="issue-item ${dismissed.has(i.id) ? 'dismissed' : ''}" id="ce-item-${i.id}" data-id="${i.id}">
      <div class="issue-head"><span class="num">${i.id}</span><span class="cat">${esc(i.category.replace('_', ' '))}</span>${i.start == null ? '<span class="cat warn">not found in text</span>' : ''}</div>
      <div class="issue-change"><span class="q">${esc(i.quote)}</span> → <span class="fix">${esc(i.replacement) || '<em>(delete)</em>'}</span></div>
      <div class="expl">${esc(i.explanation)}</div>
      <div class="item-actions">
        <button class="mini-btn" data-act="copyfix">Copy fix</button>
        <button class="mini-btn" data-act="dismiss">${dismissed.has(i.id) ? 'Restore' : 'Dismiss'}</button>
        <button class="mini-btn" data-act="rule">Don't flag this again…</button>
      </div></li>`;
  const errors = issues.filter(i => i.severity === 'error');
  const suggestions = issues.filter(i => i.severity !== 'error');
  $('copyedit-errors').innerHTML = errors.map(item).join('') || '<li class="muted">No errors found.</li>';
  $('copyedit-suggestions').innerHTML = suggestions.map(item).join('') || '<li class="muted">None.</li>';
  $('copyedit-suggestion-count').textContent = `(${suggestions.length})`;
  const nErr = errors.filter(i => !dismissed.has(i.id)).length;
  $('copyedit-summary').textContent = `${nErr} error${nErr === 1 ? '' : 's'} and ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}. Highlights are on your original text — hover or click one to see the note.`;
}

async function runCopyEdit() {
  $('copyedit-section').classList.remove('hidden');
  $('copyedit-body').classList.add('hidden');
  $('copyedit-status').innerHTML = '<span class="spinner"></span> Copy-editing…';
  try {
    const p = basePayload();
    const data = await api('/api/copy-edit', { article: p.article, guidance: p.guidance, formatting: formattingFor(p.article), styleGuide: guideOverride('copyEdit') });
    copyEdit = { ...data, dismissed: new Set() };
    $('copyedit-status').textContent = formattingFor(p.article) === 'plain' ? 'Note: this text was pasted without formatting, so italics weren’t checked.' : '';
    $('copyedit-body').classList.remove('hidden');
    renderCopyEdit();
  } catch (e) {
    $('copyedit-status').innerHTML = `<span class="inline-error">Copy-edit failed: ${esc(e.message)}</span>`;
  }
}

$('copyedit-section').addEventListener('click', e => {
  const mark = e.target.closest('mark.hl, sup.hl-num');
  if (mark) {
    const id = mark.dataset.ids.split(' ')[0].replace('ce', '');
    const li = $(`ce-item-${id}`);
    if (li) { li.scrollIntoView({ behavior: 'smooth', block: 'center' }); li.classList.add('flash'); setTimeout(() => li.classList.remove('flash'), 1200); }
    return;
  }
  const btn = e.target.closest('[data-act]');
  const li = e.target.closest('.issue-item');
  if (!btn || !li || !copyEdit) return;
  const issue = copyEdit.issues.find(i => i.id === Number(li.dataset.id));
  if (btn.dataset.act === 'copyfix') copy(issue.replacement, btn);
  if (btn.dataset.act === 'dismiss') {
    copyEdit.dismissed.has(issue.id) ? copyEdit.dismissed.delete(issue.id) : copyEdit.dismissed.add(issue.id);
    renderCopyEdit();
  }
  if (btn.dataset.act === 'rule') {
    openRuleModal({
      scope: 'copyEdit',
      text: `Don't flag ${issue.category.replace('_', ' ')} issues like “${issue.quote}” → “${issue.replacement}”: `,
      context: `Flag the editor disagreed with: “${issue.quote}” → “${issue.replacement}” (${issue.explanation})`,
    });
  }
});
$('show-suggestions').addEventListener('change', e => $('copyedit-section').classList.toggle('hide-suggestions', !e.target.checked));

// ---------------- Fact-check ----------------
let fc = null; // { doc, claims: Map, results: Map, final }
const SEVERITY = { incorrect: 0, imprecise: 1, unsupported: 2 };
const VERDICT_LABEL = { incorrect: 'Incorrect', imprecise: 'Imprecise', unsupported: 'Unsupported', correct: 'Correct', opinion: 'Opinion' };

function fcItem(c, r, { compact = false } = {}) {
  const verdict = r ? r.verdict : 'pending';
  const legal = (r && r.legal_sensitivity) || c.legal_sensitivity;
  const sources = r && r.sources && r.sources.length
    ? `<div class="sources">${r.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join(' · ')}</div>` : '';
  return `<li class="issue-item fc-item" id="fc-item-${c.id}" data-id="${c.id}">
    <div class="issue-head"><span class="badge v-${verdict}">${esc(VERDICT_LABEL[verdict] || 'Checking…')}</span>${legal ? '<span class="badge legal">Legal</span>' : ''}${c.start == null ? '<span class="cat warn">not found in text</span>' : ''}</div>
    <div class="claim-quote">“${esc(c.quote)}”</div>
    ${compact ? '' : `<div class="claim-restated">${esc(c.claim)}</div>`}
    ${r ? `<div class="expl">${esc(r.explanation)}</div>` : ''}
    ${r && r.correction ? `<div class="correction"><strong>Accurate version:</strong> ${esc(r.correction)}</div>` : ''}
    ${sources}
    ${!compact && r && SEVERITY[verdict] != null ? `<div class="item-actions"><button class="mini-btn" data-act="fc-rule">Don't flag this kind of thing again…</button></div>` : ''}
  </li>`;
}

function renderFactCheck() {
  const claims = [...fc.claims.values()];
  const highlights = [];
  for (const c of claims) {
    if (c.start == null) continue;
    const r = fc.results.get(c.id);
    if (r && r.verdict === 'opinion') continue;
    const legal = (r && r.legal_sensitivity) || c.legal_sensitivity;
    highlights.push({
      start: c.start, end: c.end, id: `fc${c.id}`,
      cls: `v-${r ? r.verdict : 'pending'}${legal ? ' legal' : ''}`,
      label: r && SEVERITY[r.verdict] != null ? '!' : null,
      title: r ? `${VERDICT_LABEL[r.verdict]}: ${r.explanation}` : 'Being checked…',
    });
  }
  $('factcheck-doc').innerHTML = renderDoc(fc.doc, highlights);

  const attention = claims.filter(c => SEVERITY[fc.results.get(c.id)?.verdict] != null)
    .sort((a, b) => SEVERITY[fc.results.get(a.id).verdict] - SEVERITY[fc.results.get(b.id).verdict] || (a.start ?? 1e9) - (b.start ?? 1e9));
  const legal = claims.filter(c => fc.results.get(c.id)?.legal_sensitivity || c.legal_sensitivity);
  const fine = claims.filter(c => fc.results.get(c.id)?.verdict === 'correct');
  const pending = claims.filter(c => !fc.results.has(c.id));

  $('fc-attention').innerHTML = attention.map(c => fcItem(c, fc.results.get(c.id))).join('')
    || `<li class="muted">${pending.length ? 'Nothing flagged yet.' : 'Nothing flagged.'}</li>`;
  $('fc-attn-count').textContent = `(${attention.length})`;
  $('fc-legal').innerHTML = legal.map(c => fcItem(c, fc.results.get(c.id), { compact: true })).join('') || '<li class="muted">None.</li>';
  $('fc-legal-count').textContent = `(${legal.length})`;
  $('fc-legal-wrap').open = legal.length > 0 && legal.length <= 6;
  $('fc-fine').innerHTML = fine.map(c => fcItem(c, fc.results.get(c.id), { compact: true })).join('') || '<li class="muted">None yet.</li>';
  $('fc-fine-count').textContent = `(${fine.length})`;
}

async function runFactCheck() {
  $('factcheck-section').classList.remove('hidden');
  $('factcheck-body').classList.add('hidden');
  const status = $('factcheck-status');
  status.innerHTML = '<span class="spinner"></span> Starting fact-check…';
  fc = { doc: null, claims: new Map(), results: new Map(), final: false };
  const p = basePayload();
  let failed = false;
  try {
    await stream('/api/fact-check', { article: p.article, guidance: p.guidance, deep: $('factcheck-deep').checked, styleGuide: guideOverride('factCheck') }, ev => {
      if (ev.type === 'progress') status.innerHTML = `<span class="spinner"></span> ${esc(ev.message)}`;
      if (ev.type === 'claims') {
        fc.doc = ev.doc;
        ev.claims.forEach(c => fc.claims.set(c.id, c));
        $('factcheck-body').classList.remove('hidden');
        renderFactCheck();
      }
      if (ev.type === 'verdicts') { ev.results.forEach(r => fc.results.set(r.id, r)); renderFactCheck(); }
      if (ev.type === 'final') { fc.results = new Map(ev.results.map(r => [r.id, r])); fc.final = true; renderFactCheck(); }
      if (ev.type === 'error') { failed = true; status.innerHTML = `<span class="inline-error">Fact-check failed: ${esc(ev.error)}</span>`; }
    });
    if (!failed) {
      const flagged = [...fc.results.values()].filter(r => SEVERITY[r.verdict] != null).length;
      status.textContent = fc.claims.size
        ? `Done — checked ${fc.claims.size} claims; ${flagged} need${flagged === 1 ? 's' : ''} attention.`
        : 'No checkable factual claims found.';
    }
  } catch (e) {
    status.innerHTML = `<span class="inline-error">Fact-check failed: ${esc(e.message)}</span>`;
  }
}

$('factcheck-section').addEventListener('click', e => {
  const mark = e.target.closest('mark.hl, sup.hl-num');
  if (mark) {
    const id = mark.dataset.ids.split(' ')[0].replace('fc', '');
    const li = document.querySelector(`#fc-attention #fc-item-${id}`) || document.querySelector(`#fc-item-${id}`);
    if (li) {
      li.closest('details')?.setAttribute('open', '');
      li.scrollIntoView({ behavior: 'smooth', block: 'center' });
      li.classList.add('flash');
      setTimeout(() => li.classList.remove('flash'), 1200);
    }
    return;
  }
  const btn = e.target.closest('[data-act="fc-rule"]');
  if (!btn) return;
  const id = Number(btn.closest('.issue-item').dataset.id);
  const c = fc.claims.get(id);
  const r = fc.results.get(id);
  openRuleModal({
    scope: 'factCheck',
    text: '',
    context: `Flag the editor disagreed with: "${c.quote}" — ${r.verdict}: ${r.explanation}`,
  });
});

// ---------------- Run ----------------
$('process-btn').addEventListener('click', async () => {
  const article = articleText.value.trim();
  const error = $('error');
  if (!article) { error.textContent = 'Please enter article text'; error.classList.remove('hidden'); return; }
  const tasks = {
    headlines: $('task-headlines').checked,
    social: $('task-social').checked,
    copyEdit: $('task-copyedit').checked,
    factCheck: $('task-factcheck').checked,
  };
  if (!Object.values(tasks).some(Boolean)) { error.textContent = 'Please select at least one task'; error.classList.remove('hidden'); return; }
  error.classList.add('hidden');

  ['headlines-section', 'social-section', 'copyedit-section', 'factcheck-section'].forEach(id => $(id).classList.add('hidden'));
  const btn = $('process-btn');
  btn.disabled = true;
  btn.textContent = 'Working…';
  const jobs = [];
  if (tasks.headlines) {
    $('headlines-section').classList.remove('hidden');
    headlinesPanel.reset();
    jobs.push(headlinesPanel.generate());
  }
  if (tasks.social) {
    $('social-section').classList.remove('hidden');
    for (const panel of Object.values(socialPanels)) { panel.reset(); jobs.push(panel.generate()); }
  }
  if (tasks.copyEdit) jobs.push(runCopyEdit());
  if (tasks.factCheck) jobs.push(runFactCheck());
  await Promise.allSettled(jobs);
  btn.disabled = false;
  btn.textContent = 'Process Article';
});

window.Shared.loadFooter($('footer'));
