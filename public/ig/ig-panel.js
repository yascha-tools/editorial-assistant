// IG Cards tab: generate an Instagram carousel, edit it, download PNGs.
(function () {
  const { api, escapeHtml: esc, openRuleModal } = window.Shared;
  const KIND_LABEL = { cover: 'Cover', quote: 'Quote', stat: 'Number', point: 'Argument', cta: 'Closing card' };
  const DEFAULT_CTA = 'Read the full essay at';

  function numbersIn(str) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, hundred: 100 };
    const s = String(str || '').toLowerCase().replace(/,(?=\d{3})/g, '');
    const out = new Set(s.match(/\d+(?:\.\d+)?/g) || []);
    for (const [w, n] of Object.entries(words)) if (new RegExp(`\\b${w}\\b`).test(s)) out.add(String(n));
    return out;
  }

  class IGPanel {
    constructor({ root, payload, articleImage }) {
      this.root = root;
      this.payload = payload;
      this.articleImage = articleImage;
      this.set = null;
      this.versions = [];
      this.style = 'light';
      this.count = 5;
      this.photo = null;
      this.photoLabel = '';
      this.photoY = 0.5;
      this.loading = false;
      this.error = '';
      this.canvases = [];
      this.buildShell();
      this.readyPromise = window.IGCards.ready().catch(e => { this.error = `Could not load card fonts: ${e.message}`; this.renderStatus(); });
    }

    buildShell() {
      this.root.innerHTML = `
        <div class="ig-controls">
          <div class="ig-ctrl">
            <div class="ig-label">Style</div>
            <div class="seg">${Object.entries(window.IGCards.STYLES).map(([k, s]) => `<button type="button" class="seg-btn ${k === this.style ? 'active' : ''}" data-style="${k}">${esc(s.label)}</button>`).join('')}</div>
          </div>
          <div class="ig-ctrl">
            <div class="ig-label">Cards</div>
            <select class="ig-count">${[4, 5, 6].map(n => `<option value="${n}" ${n === this.count ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </div>
          <div class="ig-ctrl ig-photo-ctrl">
            <div class="ig-label">Cover photo</div>
            <div class="ig-photo-row">
              <button type="button" class="mini-btn" data-act="upload">Upload…</button>
              <input type="file" accept="image/*" class="ig-file" hidden>
              <button type="button" class="mini-btn ig-article-img hidden" data-act="article-image">Use article image</button>
              <input type="url" class="ig-photo-url" placeholder="…or paste an image URL">
              <button type="button" class="mini-btn" data-act="load-url">Load</button>
              <button type="button" class="mini-btn" data-act="remove-photo">No photo</button>
            </div>
            <div class="ig-photo-row">
              <span class="ig-photo-status muted small">No photo — the cover will be typographic. You can also drop an image here.</span>
              <label class="small ig-photo-y-wrap hidden">Position <input type="range" class="ig-photo-y" min="0" max="100" value="50"></label>
            </div>
          </div>
          <div class="ig-ctrl ig-buttons">
            <button type="button" class="secondary-btn" data-act="generate">Generate cards</button>
            <button type="button" data-act="download-all" disabled>Download all (.zip)</button>
          </div>
        </div>
        <div class="ig-status"></div>
        <div class="ig-strip"></div>
        <div class="feedback-box ig-feedback hidden">
          <textarea class="feedback-input" placeholder="Feedback for the next version (e.g. “use the Madison line instead of the statistic”, “shorter quotes”)"></textarea>
          <div class="feedback-actions">
            <button type="button" class="secondary-btn" data-act="regen">Regenerate with feedback</button>
            <button type="button" class="link-btn ig-undo hidden" data-act="undo">Back to previous version</button>
            <button type="button" class="link-btn" data-act="save-rule">Save feedback as a standing rule…</button>
          </div>
        </div>
        <p class="field-hint">Cards are 1080×1350 (Instagram portrait). Edit any text below a card and it updates instantly. Quotes are checked against the article; a ⚠ means the wording doesn’t match exactly.</p>`;
      const q = sel => this.root.querySelector(sel);
      this.$ = q;
      this.root.addEventListener('click', e => this.onClick(e));
      this.root.addEventListener('input', e => this.onInput(e));
      q('.ig-count').addEventListener('change', e => { this.count = Number(e.target.value); });
      q('.ig-file').addEventListener('change', e => { if (e.target.files[0]) this.loadFile(e.target.files[0]); e.target.value = ''; });
      q('.ig-photo-y').addEventListener('input', e => { this.photoY = Number(e.target.value) / 100; this.renderCard(0); });
      this.root.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.type.startsWith('image/'))) { e.preventDefault(); this.root.classList.add('drag-over'); } });
      this.root.addEventListener('dragleave', () => this.root.classList.remove('drag-over'));
      this.root.addEventListener('drop', e => {
        this.root.classList.remove('drag-over');
        const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
        if (f) { e.preventDefault(); this.loadFile(f); }
      });
      this.refreshArticleImageButton();
    }

    refreshArticleImageButton() {
      this.$('.ig-article-img').classList.toggle('hidden', !this.articleImage());
    }

    // ---------- photo ----------
    setPhoto(img, label) {
      this.photo = img;
      this.photoLabel = label;
      this.$('.ig-photo-status').textContent = img ? `Using ${label}.` : 'No photo — the cover will be typographic. You can also drop an image here.';
      this.$('.ig-photo-y-wrap').classList.toggle('hidden', !img);
      this.renderCard(0);
    }

    async loadImageSrc(src) {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img;
    }

    async loadFile(file) {
      try {
        const img = await this.loadImageSrc(URL.createObjectURL(file));
        this.setPhoto(img, `uploaded photo “${file.name}”`);
      } catch (e) {
        this.$('.ig-photo-status').textContent = `Couldn't read that image: ${e.message}`;
      }
    }

    async loadUrl(url, label) {
      if (!url) return;
      this.$('.ig-photo-status').textContent = 'Loading image…';
      try {
        const img = await this.loadImageSrc(`/api/image-proxy?url=${encodeURIComponent(url)}`);
        this.setPhoto(img, label || 'the linked image');
      } catch (e) {
        this.$('.ig-photo-status').textContent = 'Couldn’t load that image. Try downloading it and using Upload instead.';
      }
    }

    // ---------- generation ----------
    async generate({ feedback = '', fresh = false } = {}) {
      this.refreshArticleImageButton();
      const base = this.payload();
      if (!base.article) { this.error = 'Add the article text first.'; this.renderStatus(); return; }
      if (fresh) { this.versions = []; this.set = null; }
      if (!this.photo && this.articleImage()) this.loadUrl(this.articleImage(), 'the article’s image');
      this.loading = true;
      this.error = '';
      this.renderStatus();
      try {
        const history = this.versions.map(v => ({ result: this.summarize(v.set), feedback: v.feedback }));
        if (feedback && this.versions.length) this.versions[this.versions.length - 1].feedback = feedback;
        const res = await api('/api/ig-cards', { ...base, count: this.count, history, feedback });
        const r = res.result;
        const prev = this.set;
        this.set = {
          title: r.title || base.currentTitle || '',
          author: r.author || base.author || '',
          ctaText: prev ? prev.ctaText : DEFAULT_CTA,
          cards: [{ kind: 'cover' }, ...r.cards, { kind: 'cta' }],
        };
        this.versions.push({ set: JSON.parse(JSON.stringify(this.set)), feedback: null });
        await this.readyPromise;
        this.buildStrip();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
        this.renderStatus();
      }
    }

    summarize(set) {
      return [`Title: ${set.title}`, ...set.cards.filter(c => !['cover', 'cta'].includes(c.kind)).map(c => `${c.kind}: ${c.stat ? c.stat + ' — ' : ''}${c.text}`)].join('\n');
    }

    renderStatus() {
      const st = this.$('.ig-status');
      st.innerHTML = this.loading ? '<div class="inline-loading"><span class="spin-inline"></span> Picking the strongest moments…</div>'
        : this.error ? `<div class="inline-error">${esc(this.error)}</div>` : '';
      this.$('[data-act="generate"]').textContent = this.set ? 'Start over' : 'Generate cards';
      this.$('[data-act="generate"]').disabled = this.loading;
      this.$('[data-act="download-all"]').disabled = !this.set || this.loading;
      this.$('.ig-feedback').classList.toggle('hidden', !this.set);
      this.$('.ig-undo').classList.toggle('hidden', this.versions.length < 2);
    }

    // ---------- strip of cards with editable fields ----------
    fieldsFor(card, i) {
      const f = (field, label, value, { area = false, scope = 'card', placeholder = '' } = {}) => area
        ? `<label class="ig-field"><span>${label}</span><textarea data-scope="${scope}" data-field="${field}" data-idx="${i}" rows="4" placeholder="${esc(placeholder)}">${esc(value || '')}</textarea></label>`
        : `<label class="ig-field"><span>${label}</span><input data-scope="${scope}" data-field="${field}" data-idx="${i}" value="${esc(value || '')}" placeholder="${esc(placeholder)}"></label>`;
      if (card.kind === 'cover') return f('title', 'Title', this.set.title, { scope: 'set' }) + f('author', 'Author', this.set.author, { scope: 'set' });
      if (card.kind === 'cta') return f('ctaText', 'Line above the URL', this.set.ctaText, { scope: 'set' });
      let html = '';
      if (card.kind === 'stat') html += f('stat', 'Number', card.stat);
      html += f('text', card.kind === 'quote' ? 'Quote (exact words)' : 'Text', card.text, { area: true });
      html += f('highlight', 'Highlight (exact phrase)', card.highlight, { placeholder: 'optional' });
      if (card.kind === 'quote') html += f('attribution', 'Attribution', card.attribution, { placeholder: this.set.author });
      return html;
    }

    badge(card) {
      if (card.kind === 'quote' && card.verbatim === false) return '<div class="ig-warn">⚠ Not word-for-word from the article — check before posting.</div>';
      if (card.kind === 'stat' && card.verified === false) return '<div class="ig-warn">⚠ This number doesn’t appear in the article — check it.</div>';
      if (card.kind === 'quote' && card.verbatim) return '<div class="ig-ok">✓ Exact quote</div>';
      return '';
    }

    buildStrip() {
      const strip = this.$('.ig-strip');
      const n = this.set.cards.length;
      strip.innerHTML = this.set.cards.map((card, i) => {
        const movable = card.kind !== 'cover' && card.kind !== 'cta';
        return `<div class="ig-card" data-idx="${i}">
          <div class="ig-canvas-wrap"></div>
          <div class="ig-card-head">
            <span class="ig-card-title">${i + 1} · ${KIND_LABEL[card.kind] || card.kind}</span>
            <span class="ig-card-tools">
              ${movable ? `<button type="button" class="mini-btn" data-act="left" ${i <= 1 ? 'disabled' : ''} title="Move left">←</button><button type="button" class="mini-btn" data-act="right" ${i >= n - 2 ? 'disabled' : ''} title="Move right">→</button><button type="button" class="mini-btn" data-act="delete" ${n <= 3 ? 'disabled' : ''} title="Remove card">✕</button>` : ''}
              <button type="button" class="mini-btn" data-act="download" title="Download this card">PNG</button>
            </span>
          </div>
          <div class="ig-badge">${this.badge(card)}</div>
          <div class="ig-fields">${this.fieldsFor(card, i)}</div>
        </div>`;
      }).join('') + `<div class="ig-card ig-add">
          <div class="ig-label">Add a card</div>
          <button type="button" class="mini-btn" data-act="add" data-kind="quote">+ Quote</button>
          <button type="button" class="mini-btn" data-act="add" data-kind="stat">+ Number</button>
          <button type="button" class="mini-btn" data-act="add" data-kind="point">+ Argument</button>
        </div>`;
      this.canvases = this.set.cards.map((_, i) => {
        const c = document.createElement('canvas');
        c.className = 'ig-canvas';
        strip.querySelector(`.ig-card[data-idx="${i}"] .ig-canvas-wrap`).appendChild(c);
        return c;
      });
      this.renderAll();
    }

    opts(canvas) { return { style: this.style, photo: this.photo, photoY: this.photoY, canvas }; }

    renderCard(i) {
      if (!this.set || !this.canvases[i]) return;
      window.IGCards.renderCard(this.set, i, this.opts(this.canvases[i]));
    }

    renderAll() {
      if (!this.set) return;
      this.set.cards.forEach((_, i) => this.renderCard(i));
    }

    // ---------- events ----------
    onInput(e) {
      const el = e.target;
      if (!el.dataset || !el.dataset.field || !this.set) return;
      const i = Number(el.dataset.idx);
      if (el.dataset.scope === 'set') {
        this.set[el.dataset.field] = el.value;
        cancelAnimationFrame(this.raf);
        this.raf = requestAnimationFrame(() => this.renderAll());
        return;
      }
      const card = this.set.cards[i];
      card[el.dataset.field] = el.value;
      if (el.dataset.field === 'text' && card.kind === 'quote' && window.LiteDoc) {
        const doc = window.LiteDoc.parseLite(this.payload().article);
        const loc = window.LiteDoc.locate(doc, el.value);
        card.verbatim = !!loc && !loc.approximate;
        this.root.querySelector(`.ig-card[data-idx="${i}"] .ig-badge`).innerHTML = this.badge(card);
      }
      if (el.dataset.field === 'stat' && card.kind === 'stat') {
        const have = numbersIn(this.payload().article);
        card.verified = [...numbersIn(el.value)].every(n => have.has(n));
        this.root.querySelector(`.ig-card[data-idx="${i}"] .ig-badge`).innerHTML = this.badge(card);
      }
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.renderAll());
    }

    async onClick(e) {
      const styleBtn = e.target.closest('[data-style]');
      if (styleBtn) {
        this.style = styleBtn.dataset.style;
        this.root.querySelectorAll('[data-style]').forEach(b => b.classList.toggle('active', b === styleBtn));
        this.renderAll();
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const cardEl = btn.closest('.ig-card');
      const i = cardEl ? Number(cardEl.dataset.idx) : -1;
      if (act === 'upload') this.$('.ig-file').click();
      if (act === 'article-image') this.loadUrl(this.articleImage(), 'the article’s image');
      if (act === 'load-url') this.loadUrl(this.$('.ig-photo-url').value.trim(), 'the linked image');
      if (act === 'remove-photo') this.setPhoto(null, '');
      if (act === 'generate') this.generate({ fresh: true });
      if (act === 'regen') this.generate({ feedback: this.$('.ig-feedback .feedback-input').value });
      if (act === 'undo' && this.versions.length > 1) {
        this.versions.pop();
        this.set = JSON.parse(JSON.stringify(this.versions[this.versions.length - 1].set));
        this.buildStrip();
        this.renderStatus();
      }
      if (act === 'save-rule') {
        openRuleModal({ scope: 'social', text: this.$('.ig-feedback .feedback-input').value, context: this.set ? `IG cards at the time:\n${this.summarize(this.set)}` : '' });
      }
      if (act === 'left' || act === 'right') {
        const j = act === 'left' ? i - 1 : i + 1;
        [this.set.cards[i], this.set.cards[j]] = [this.set.cards[j], this.set.cards[i]];
        this.buildStrip();
      }
      if (act === 'delete') { this.set.cards.splice(i, 1); this.buildStrip(); }
      if (act === 'add') {
        const kind = btn.dataset.kind;
        const card = kind === 'stat' ? { kind, stat: '00%', text: 'What the number means.', highlight: '' }
          : kind === 'quote' ? { kind, text: 'Paste an exact quote from the article.', highlight: '', attribution: '' }
            : { kind, text: 'State the argument in one sentence.', highlight: '' };
        this.set.cards.splice(this.set.cards.length - 1, 0, card);
        this.buildStrip();
      }
      if (act === 'download') {
        const blob = await window.IGCards.toBlob(this.canvases[i]);
        this.save(blob, `${window.IGCards.slug(this.set.title)}-${i + 1}.png`);
      }
      if (act === 'download-all' && this.set) {
        btn.disabled = true;
        const files = [];
        for (let k = 0; k < this.canvases.length; k++) {
          files.push({ name: `${window.IGCards.slug(this.set.title)}-${String(k + 1).padStart(2, '0')}.png`, blob: await window.IGCards.toBlob(this.canvases[k]) });
        }
        this.save(await window.IGCards.makeZip(files), `${window.IGCards.slug(this.set.title)}-ig-cards.zip`);
        btn.disabled = false;
      }
    }

    save(blob, name) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  }

  window.IGPanel = IGPanel;
})();
