// Convert HTML (Google Docs export, Google Docs / Word clipboard, Substack
// posts) into the lite-markdown format described in lib/doc.js, keeping
// italics, bold, links, headings and block quotes.

const cheerio = require('cheerio');

const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'div', 'section', 'article',
  'header', 'footer', 'pre', 'ul', 'ol', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'figure', 'hr', 'body', 'main']);

function classStyles($) {
  const italic = new Set();
  const bold = new Set();
  $('style').each((_, el) => {
    const css = $(el).html() || '';
    const re = /\.([\w-]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      if (/font-style\s*:\s*italic/i.test(m[2])) italic.add(m[1]);
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(m[2])) bold.add(m[1]);
    }
  });
  return { italic, bold };
}

function unwrapGoogleUrl(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q')) {
      return u.searchParams.get('q');
    }
  } catch (_) { /* relative or invalid */ }
  return href;
}

function wrap(content, open, close) {
  const lead = content.match(/^\s*/)[0];
  const trail = content.match(/\s*$/)[0];
  const core = content.trim();
  if (!core) return content;
  return `${lead}${open}${core}${close}${trail}`;
}

function htmlToLite(html) {
  const $ = cheerio.load(html || '');
  const cls = classStyles($);

  $('script, style, head, title, meta, noscript, button, svg, figcaption, .subscription-widget, .subscription-widget-wrap, .button-wrapper, .captioned-button-wrap').remove();
  // Google Docs comments: inline markers and the comment bodies at the end
  $('a[id^="cmnt"]').not('[id^="cmnt_ref"]').each((_, el) => { const div = $(el).closest('div'); (div.length ? div : $(el).closest('p')).remove(); });
  $('a[href^="#cmnt"]').each((_, el) => { const sup = $(el).closest('sup'); (sup.length ? sup : $(el)).remove(); });

  let title = '';
  let subtitle = '';

  function styleOf(el) {
    const tag = (el.tagName || el.name || '').toLowerCase();
    const style = ($(el).attr('style') || '').toLowerCase();
    const classes = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
    let italic = tag === 'em' || tag === 'i' || /font-style\s*:\s*italic/.test(style) || classes.some(c => cls.italic.has(c));
    let bold = ((tag === 'strong' || tag === 'b') && !/font-weight\s*:\s*(normal|[1-4]00)/.test(style))
      || /font-weight\s*:\s*(bold|[6-9]00)/.test(style) || classes.some(c => cls.bold.has(c));
    if (/font-style\s*:\s*normal/.test(style)) italic = false;
    return { italic, bold };
  }

  function inlineNode(child) {
    if (child.type === 'text') return child.data.replace(/[\s ]+/g, ' ');
    if (child.type !== 'tag') return '';
    const tag = child.name.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'img') return '';
    let content = inline(child);
    if (!content.trim()) return content;
    const { italic, bold } = styleOf(child);
    if (italic) content = wrap(content.replace(/\*/g, ''), '*', '*');
    else if (bold) content = wrap(content, '**', '**');
    if (tag === 'a') {
      const href = unwrapGoogleUrl($(child).attr('href') || '');
      if (/^https?:\/\//i.test(href)) content = wrap(content.replace(/[[\]]/g, ''), '[', `](${href.replace(/\)/g, '%29').replace(/\s/g, '%20')})`);
    }
    return content;
  }

  function inline(node) {
    let out = '';
    $(node).contents().each((_, child) => { out += inlineNode(child); });
    return out;
  }

  const paras = [];
  function emit(text, prefix = '') {
    for (const line of text.split('\n')) {
      const clean = line.replace(/[ \t]+/g, ' ').replace(/(?<=[^\s*])\*(\s+)\*(?=[^\s*])/g, '$1').trim();
      if (clean) paras.push(prefix + clean);
    }
  }

  function hasBlockChild(el) {
    return $(el).children().toArray().some(c => BLOCK.has((c.name || '').toLowerCase()));
  }

  const BLOCK_SELECTOR = Array.from(BLOCK).join(',');

  function walk(el, prefix = '') {
    let buffer = '';
    const flush = () => { if (buffer.trim()) emit(buffer, prefix); buffer = ''; };
    $(el).contents().each((_, child) => {
      if (child.type === 'text') { buffer += inlineNode(child); return; }
      if (child.type !== 'tag') return;
      const tag = child.name.toLowerCase();
      const isBlock = BLOCK.has(tag);
      if (!isBlock && $(child).find(BLOCK_SELECTOR).length === 0) { buffer += inlineNode(child); return; }
      flush();
      if (!isBlock) { walk(child, prefix); return; } // inline wrapper around paragraphs (Google Docs clipboard)
      if (tag === 'hr') return;
      const classes = ($(child).attr('class') || '').split(/\s+/);
      if (tag === 'blockquote') { walk(child, '> '); return; }
      if (hasBlockChild(child)) { walk(child, prefix); return; }
      const text = inline(child);
      if (!text.trim()) return;
      if (classes.includes('title') && !title) { title = text.replace(/\*/g, '').trim(); emit(text, '# '); return; }
      if (classes.includes('subtitle') && !subtitle) { subtitle = text.replace(/\*/g, '').trim(); emit(text, prefix); return; }
      if (/^h[1-6]$/.test(tag)) { emit(text, tag === 'h1' ? '# ' : '## '); return; }
      if (tag === 'li') { emit(text, prefix + '- '); return; }
      emit(text, prefix);
    });
    flush();
  }

  const root = $('body').length ? $('body')[0] : $.root()[0];
  walk(root);
  return { text: paras.join('\n\n'), title, subtitle };
}

module.exports = { htmlToLite };
