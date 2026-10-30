// Persuasion Instagram cards: renders 1080x1350 carousel images on <canvas>.
//
//   await IGCards.ready();
//   const canvases = IGCards.renderSet(set, { style: 'light', photo, photoY: 0.5 });
//
// set = { title, author, ctaText, cards: [
//   { kind: 'cover' },
//   { kind: 'quote', text, highlight, attribution },
//   { kind: 'stat',  stat, text, highlight },
//   { kind: 'point', text, highlight },
//   { kind: 'cta' } ] }
//
// Card text may contain *italic* markup (e.g. book titles).
(function (root) {
  'use strict';

  const W = 1080, H = 1350, M = 96;
  const SERIF = 'PersuasionSerif';
  const SANS = 'PersuasionSans';

  const STYLES = {
    light: {
      label: 'Light',
      bg: '#FFFFFF', text: '#0A0A0A', muted: '#4B5563', faint: '#9CA3AF', rule: '#E5E7EB', accent: '#0D9488',
      coverBg: '#000000', coverText: '#FFFFFF', coverMuted: '#D1D5DB', coverAccent: '#14B8A6',
      ctaBg: '#000000', ctaText: '#FFFFFF', ctaMuted: '#9CA3AF', ctaAccent: '#14B8A6',
    },
    dark: {
      label: 'Dark',
      bg: '#000000', text: '#FFFFFF', muted: '#D1D5DB', faint: '#8B8F96', rule: '#2B2B2B', accent: '#14B8A6',
      coverBg: '#000000', coverText: '#FFFFFF', coverMuted: '#D1D5DB', coverAccent: '#14B8A6',
      ctaBg: '#0D9488', ctaText: '#FFFFFF', ctaMuted: 'rgba(255,255,255,0.82)', ctaAccent: '#FFFFFF',
    },
  };

  const FONT_FILES = [
    [SERIF, 'libre-baskerville-latin-400-normal.woff2', { weight: '400', style: 'normal' }],
    [SERIF, 'libre-baskerville-latin-400-italic.woff2', { weight: '400', style: 'italic' }],
    [SERIF, 'libre-baskerville-latin-700-normal.woff2', { weight: '700', style: 'normal' }],
    [SERIF, 'libre-baskerville-latin-700-italic.woff2', { weight: '700', style: 'italic' }],
    [SANS, 'inter-latin-400-normal.woff2', { weight: '400', style: 'normal' }],
    [SANS, 'inter-latin-500-normal.woff2', { weight: '500', style: 'normal' }],
    [SANS, 'inter-latin-600-normal.woff2', { weight: '600', style: 'normal' }],
    [SANS, 'inter-latin-700-normal.woff2', { weight: '700', style: 'normal' }],
  ];

  let assets = null;
  let readyPromise = null;

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load ${src}`));
      img.src = src;
    });
  }

  function tint(img, color) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
    return c;
  }

  function ready(base) {
    base = base || '';
    if (!readyPromise) {
      readyPromise = (async () => {
        await Promise.all(FONT_FILES.map(async ([family, file, desc]) => {
          const face = new FontFace(family, `url(${base}/ig/fonts/${file})`, desc);
          await face.load();
          document.fonts.add(face);
        }));
        const [icon, full] = await Promise.all([loadImage(`${base}/ig/logo-icon.png`), loadImage(`${base}/ig/logo-full.png`)]);
        assets = { icon, full, fullWhite: tint(full, '#FFFFFF') };
      })();
    }
    return readyPromise;
  }

  // ---------- text layout ----------

  // Split "*italic*" markup into runs, then into words made of styled segments.
  function toWords(text, highlight) {
    const runs = [];
    const re = /\*([^*]+)\*/g;
    let last = 0, m;
    const src = String(text || '');
    while ((m = re.exec(src))) {
      if (m.index > last) runs.push({ text: src.slice(last, m.index), italic: false });
      runs.push({ text: m[1], italic: true });
      last = m.index + m[0].length;
    }
    if (last < src.length) runs.push({ text: src.slice(last), italic: false });
    const plain = runs.map(r => r.text).join('');
    const hl = new Array(plain.length).fill(false);
    const h = String(highlight || '').replace(/\*/g, '').trim();
    if (h) {
      const i = plain.toLowerCase().indexOf(h.toLowerCase());
      if (i !== -1) for (let k = i; k < i + h.length; k++) hl[k] = true;
    }
    const chars = [];
    let pos = 0;
    for (const r of runs) for (const ch of r.text) { chars.push({ ch, italic: r.italic, hl: hl[pos] }); pos++; }
    const words = [];
    let cur = null;
    for (const c of chars) {
      if (/\s/.test(c.ch)) { if (cur) { words.push(cur); cur = null; } continue; }
      if (!cur) cur = [];
      const lastSeg = cur[cur.length - 1];
      if (lastSeg && lastSeg.italic === c.italic && lastSeg.hl === c.hl) lastSeg.text += c.ch;
      else cur.push({ text: c.ch, italic: c.italic, hl: c.hl });
    }
    if (cur) words.push(cur);
    return words;
  }

  function fontString(base, size, italic) {
    return `${italic ? 'italic ' : ''}${base.weight} ${size}px ${base.family}`;
  }

  function measureWord(ctx, word, base, size) {
    let w = 0;
    for (const seg of word) {
      ctx.font = fontString(base, size, seg.italic || base.italic);
      w += ctx.measureText(seg.text).width;
    }
    return w;
  }

  function layout(ctx, words, base, size, maxWidth) {
    ctx.font = fontString(base, size, base.italic);
    const space = ctx.measureText(' ').width;
    const lines = [];
    let line = [], width = 0;
    for (const w of words) {
      const ww = measureWord(ctx, w, base, size);
      if (line.length && width + space + ww > maxWidth) {
        lines.push({ words: line, width });
        line = [{ w, ww }];
        width = ww;
      } else {
        width += (line.length ? space : 0) + ww;
        line.push({ w, ww });
      }
    }
    if (line.length) lines.push({ words: line, width });
    const tooWide = lines.some(l => l.width > maxWidth + 0.5);
    return { lines, space, tooWide };
  }

  // Largest size (stepping down) at which the text fits the box.
  function fit(ctx, words, base, { maxWidth, maxHeight, max, min, lineHeight, maxLines }) {
    for (let size = max; size >= min; size -= 2) {
      const l = layout(ctx, words, base, size, maxWidth);
      const lh = Math.round(size * lineHeight);
      const height = l.lines.length * lh;
      if (!l.tooWide && height <= maxHeight && (!maxLines || l.lines.length <= maxLines)) return { ...l, size, lh, height };
    }
    const l = layout(ctx, words, base, min, maxWidth);
    const lh = Math.round(min * lineHeight);
    return { ...l, size: min, lh, height: l.lines.length * lh, overflow: true };
  }

  function drawLines(ctx, block, base, { x, y, align = 'left', color, highlightColor, maxWidth }) {
    ctx.textBaseline = 'alphabetic';
    const ascent = block.size * 0.78;
    block.lines.forEach((line, i) => {
      let cx = x;
      if (align === 'center') cx = x + (maxWidth - line.width) / 2;
      if (align === 'right') cx = x + maxWidth - line.width;
      const baseline = y + i * block.lh + (block.lh - block.size) / 2 + ascent;
      line.words.forEach((item, wi) => {
        for (const seg of item.w) {
          ctx.font = fontString(base, block.size, seg.italic || base.italic);
          ctx.fillStyle = seg.hl ? (highlightColor || color) : color;
          ctx.fillText(seg.text, cx, baseline);
          cx += ctx.measureText(seg.text).width;
        }
        if (wi < line.words.length - 1) cx += block.space;
      });
    });
  }

  function spaced(ctx, text, x, y, spacing, align = 'left') {
    // Letter-spaced small caps-style labels.
    if ('letterSpacing' in ctx) {
      ctx.letterSpacing = `${spacing}px`;
      const w = ctx.measureText(text).width;
      ctx.fillText(text, align === 'right' ? x - w : align === 'center' ? x - w / 2 : x, y);
      ctx.letterSpacing = '0px';
      return w;
    }
    const w = ctx.measureText(text).width;
    ctx.fillText(text, align === 'right' ? x - w : align === 'center' ? x - w / 2 : x, y);
    return w;
  }

  function truncate(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t.replace(/\s+\S*$/, '') + '…';
  }

  const stripStars = s => String(s || '').replace(/\*/g, '');

  // ---------- card chrome ----------

  function contentChrome(ctx, st, set, index, total) {
    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, W, H);
    // top: accent bar, kicker (the piece's title), counter
    ctx.fillStyle = st.accent;
    ctx.fillRect(M, M, 64, 8);
    ctx.font = `600 22px ${SANS}`;
    ctx.fillStyle = st.muted;
    ctx.textBaseline = 'alphabetic';
    const counter = `${index + 1} / ${total}`;
    const counterW = ctx.measureText(counter).width + 20;
    const kicker = truncate(ctx, stripStars(set.title || '').toUpperCase(), W - 2 * M - counterW - 60);
    spaced(ctx, kicker, M, M + 54, 2.5);
    ctx.fillStyle = st.faint;
    ctx.font = `500 22px ${SANS}`;
    spaced(ctx, counter, W - M, M + 54, 1.5, 'right');
    // bottom: hairline, url, icon
    ctx.fillStyle = st.rule;
    ctx.fillRect(M, H - 180, W - 2 * M, 2);
    ctx.font = `600 26px ${SANS}`;
    ctx.fillStyle = st.muted;
    spaced(ctx, 'persuasion.community', M, H - 112, 0.5);
    const s = 84;
    ctx.drawImage(assets.icon, W - M - s, H - 150, s, s);
    return { top: M + 110, bottom: H - 220 };
  }

  function drawPhoto(ctx, img, x, y, w, h, focusY) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const scale = Math.max(w / iw, h / ih);
    const sw = w / scale, sh = h / scale;
    const sx = (iw - sw) / 2;
    const sy = Math.max(0, Math.min(ih - sh, (ih - sh) * (focusY == null ? 0.5 : focusY)));
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  // ---------- card types ----------

  function renderCover(ctx, st, set, opts) {
    const title = toWords(set.title || 'Untitled');
    const byline = set.author ? `BY ${stripStars(set.author).toUpperCase()}` : '';
    const titleBase = { family: SERIF, weight: '700' };
    const wordmarkW = 280, wordmarkH = Math.round(wordmarkW * 333 / 2000);

    ctx.fillStyle = st.coverBg;
    ctx.fillRect(0, 0, W, H);

    if (opts.photo) {
      const tb = fit(ctx, title, titleBase, { maxWidth: W - 2 * M, maxHeight: 400, max: 88, min: 50, lineHeight: 1.16, maxLines: 4 });
      const panel = 76 + tb.height + 34 + 8 + 26 + (byline ? 34 : 0) + 58 + wordmarkH + 76;
      const photoH = Math.max(560, H - panel);
      drawPhoto(ctx, opts.photo, 0, 0, W, photoH, opts.photoY);
      ctx.fillStyle = st.coverBg;
      ctx.fillRect(0, photoH, W, H - photoH);
      let y = photoH + 76;
      drawLines(ctx, tb, titleBase, { x: M, y, color: st.coverText, maxWidth: W - 2 * M });
      y += tb.height + 34;
      ctx.fillStyle = st.coverAccent;
      ctx.fillRect(M, y, 64, 8);
      y += 8 + 26;
      if (byline) {
        ctx.font = `600 26px ${SANS}`;
        ctx.fillStyle = st.coverMuted;
        spaced(ctx, byline, M, y + 24, 3);
      }
      ctx.drawImage(assets.fullWhite, M, H - 76 - wordmarkH, wordmarkW, wordmarkH);
    } else {
      ctx.drawImage(assets.fullWhite, M, M, wordmarkW, wordmarkH);
      const tb = fit(ctx, title, titleBase, { maxWidth: W - 2 * M, maxHeight: 700, max: 124, min: 64, lineHeight: 1.12, maxLines: 6 });
      const blockH = tb.height + 44 + 8 + 34 + (byline ? 34 : 0);
      let y = H - M - 70 - blockH;
      drawLines(ctx, tb, titleBase, { x: M, y, color: st.coverText, maxWidth: W - 2 * M });
      y += tb.height + 44;
      ctx.fillStyle = st.coverAccent;
      ctx.fillRect(M, y, 64, 8);
      y += 8 + 34;
      if (byline) {
        ctx.font = `600 28px ${SANS}`;
        ctx.fillStyle = st.coverMuted;
        spaced(ctx, byline, M, y + 26, 3);
      }
    }
    // swipe cue
    ctx.font = `600 48px ${SANS}`;
    ctx.fillStyle = st.coverAccent;
    ctx.textBaseline = 'alphabetic';
    const arrow = '→';
    ctx.fillText(arrow, W - M - ctx.measureText(arrow).width, H - 76 - 6);
  }

  function renderQuote(ctx, st, set, card, index, total) {
    const area = contentChrome(ctx, st, set, index, total);
    const base = { family: SERIF, weight: '400' };
    const words = toWords(card.text, card.highlight);
    const glyphH = 104, gapAfterGlyph = 4, attrH = card.attribution || set.author ? 80 : 0;
    const tb = fit(ctx, words, base, { maxWidth: W - 2 * M, maxHeight: area.bottom - area.top - glyphH - gapAfterGlyph - attrH, max: 70, min: 34, lineHeight: 1.4, maxLines: 14 });
    const blockH = glyphH + gapAfterGlyph + tb.height + attrH;
    let y = area.top + Math.max(0, (area.bottom - area.top - blockH) / 2) - 10;
    ctx.font = `700 220px ${SERIF}`;
    ctx.fillStyle = st.accent;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('“', M - 10, y + 158);
    y += glyphH + gapAfterGlyph;
    drawLines(ctx, tb, base, { x: M, y, color: st.text, highlightColor: st.accent, maxWidth: W - 2 * M });
    y += tb.height;
    const who = stripStars(card.attribution || set.author || '');
    if (who) {
      ctx.font = `600 26px ${SANS}`;
      ctx.fillStyle = st.text;
      spaced(ctx, `— ${who.toUpperCase()}`, M, y + 60, 2.5);
    }
  }

  function renderStat(ctx, st, set, card, index, total) {
    const area = contentChrome(ctx, st, set, index, total);
    const statBase = { family: SERIF, weight: '700' };
    const textBase = { family: SERIF, weight: '400' };
    const sb = fit(ctx, toWords(card.stat || ''), statBase, { maxWidth: W - 2 * M, maxHeight: 360, max: 300, min: 120, lineHeight: 1.0, maxLines: 1 });
    const tb = fit(ctx, toWords(card.text, card.highlight), textBase, { maxWidth: W - 2 * M, maxHeight: area.bottom - area.top - sb.height - 60, max: 58, min: 34, lineHeight: 1.36, maxLines: 9 });
    const blockH = sb.height + 50 + tb.height;
    let y = area.top + Math.max(0, (area.bottom - area.top - blockH) / 2);
    drawLines(ctx, sb, statBase, { x: M, y, color: st.accent, maxWidth: W - 2 * M });
    y += sb.height + 50;
    drawLines(ctx, tb, textBase, { x: M, y, color: st.text, highlightColor: st.accent, maxWidth: W - 2 * M });
  }

  function renderPoint(ctx, st, set, card, index, total) {
    const area = contentChrome(ctx, st, set, index, total);
    const base = { family: SERIF, weight: '700' };
    const tb = fit(ctx, toWords(card.text, card.highlight), base, { maxWidth: W - 2 * M, maxHeight: area.bottom - area.top, max: 88, min: 40, lineHeight: 1.22, maxLines: 10 });
    const y = area.top + Math.max(0, (area.bottom - area.top - tb.height) / 2);
    drawLines(ctx, tb, base, { x: M, y, color: st.text, highlightColor: st.accent, maxWidth: W - 2 * M });
  }

  function renderCta(ctx, st, set) {
    ctx.fillStyle = st.ctaBg;
    ctx.fillRect(0, 0, W, H);
    const lead = set.ctaText || 'Read the full essay at';
    const urlBase = { family: SERIF, weight: '700' };
    const ub = fit(ctx, toWords('persuasion.community'), urlBase, { maxWidth: W - 2 * M, maxHeight: 120, max: 92, min: 48, lineHeight: 1.1, maxLines: 1 });
    const titleBase = { family: SERIF, weight: '400', italic: true };
    const tb = set.title ? fit(ctx, toWords(stripStars(set.title)), titleBase, { maxWidth: W - 2 * M - 80, maxHeight: 200, max: 38, min: 28, lineHeight: 1.35, maxLines: 3 }) : null;
    const blockH = 50 + 24 + ub.height + 56 + 8 + (tb ? 48 + tb.height : 0);
    let y = (H - blockH) / 2 - 40;
    ctx.font = `500 40px ${SANS}`;
    ctx.fillStyle = st.ctaMuted;
    ctx.textBaseline = 'alphabetic';
    const lw = ctx.measureText(lead).width;
    ctx.fillText(lead, (W - lw) / 2, y + 40);
    y += 50 + 24;
    drawLines(ctx, ub, urlBase, { x: M, y, align: 'center', color: st.ctaText, maxWidth: W - 2 * M });
    y += ub.height + 56;
    ctx.fillStyle = st.ctaAccent;
    ctx.fillRect((W - 64) / 2, y, 64, 8);
    y += 8;
    if (tb) {
      y += 48;
      drawLines(ctx, tb, titleBase, { x: M + 40, y, align: 'center', color: st.ctaMuted, maxWidth: W - 2 * M - 80 });
    }
    const wordmarkW = 240, wordmarkH = Math.round(wordmarkW * 333 / 2000);
    ctx.drawImage(assets.fullWhite, (W - wordmarkW) / 2, H - M - wordmarkH, wordmarkW, wordmarkH);
  }

  function renderCard(set, index, opts) {
    if (!assets) throw new Error('Call IGCards.ready() first');
    opts = opts || {};
    const st = STYLES[opts.style] || STYLES.light;
    const canvas = opts.canvas || document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const card = set.cards[index];
    const total = set.cards.length;
    if (card.kind === 'cover') renderCover(ctx, st, set, opts);
    else if (card.kind === 'quote') renderQuote(ctx, st, set, card, index, total);
    else if (card.kind === 'stat') renderStat(ctx, st, set, card, index, total);
    else if (card.kind === 'point') renderPoint(ctx, st, set, card, index, total);
    else renderCta(ctx, st, set);
    return canvas;
  }

  function renderSet(set, opts) {
    return set.cards.map((_, i) => renderCard(set, i, opts));
  }

  function toBlob(canvas) {
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  // ---------- minimal ZIP (stored, no compression; PNGs are already compressed) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  async function makeZip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0, true); local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0, true); cen.setUint16(10, 0, true);
      cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true); cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, name.length, true);
      cen.setUint16(30, 0, true); cen.setUint16(32, 0, true); cen.setUint16(34, 0, true); cen.setUint16(36, 0, true); cen.setUint32(38, 0, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  function slug(s) {
    return stripStars(s || 'persuasion').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'persuasion';
  }

  root.IGCards = { ready, renderCard, renderSet, toBlob, makeZip, slug, STYLES, W, H };
})(typeof self !== 'undefined' ? self : this);
