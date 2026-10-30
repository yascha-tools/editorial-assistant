const express = require('express');
const cookieSession = require('cookie-session');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client/http');
require('dotenv').config();

// ==================== TURSO DATABASE SETUP ====================
let db = null;

// Initialize Turso database connection
async function initDatabase() {
  // Create Turso client
  db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });

  // Initialize articles analytics tables
  await db.execute(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      published_date TEXT NOT NULL,
      source TEXT NOT NULL,

      views INTEGER DEFAULT 0,
      open_rate REAL DEFAULT 0,
      new_paid_subs INTEGER DEFAULT 0,
      canceled_paid_subs INTEGER DEFAULT 0,
      new_free_subs INTEGER DEFAULT 0,
      estimated_revenue REAL DEFAULT 0,

      recipients INTEGER DEFAULT 0,
      engagement_rate REAL DEFAULT 0,
      click_through_rate REAL DEFAULT 0,
      shares INTEGER DEFAULT 0,

      article_type TEXT DEFAULT 'article',
      access_type TEXT DEFAULT 'free',
      author TEXT,
      list_name TEXT DEFAULT 'persuasion',
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      original_source TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(title, published_date, source)
    )
  `);

  // Add new columns if they don't exist (for existing databases)
  const alterStatements = [
    `ALTER TABLE articles ADD COLUMN list_name TEXT DEFAULT 'persuasion'`,
    `ALTER TABLE articles ADD COLUMN likes INTEGER DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN comments INTEGER DEFAULT 0`,
    `ALTER TABLE articles ADD COLUMN original_source TEXT`,
    `ALTER TABLE articles ADD COLUMN access_type TEXT DEFAULT 'free'`
  ];
  for (const stmt of alterStatements) {
    try { await db.execute(stmt); } catch (e) { /* column exists */ }
  }

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(published_date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_articles_type ON articles(article_type)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_articles_list ON articles(list_name)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_articles_access ON articles(access_type)`);

  // Import metadata table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS article_import_metadata (
      source TEXT PRIMARY KEY,
      last_updated TEXT,
      records_count INTEGER DEFAULT 0
    )
  `);

  console.log('Turso database connected and initialized');
}

// Helper: run query and return all rows as array of objects
async function dbAll(sql, params = []) {
  if (!db) return [];
  try {
    const result = await db.execute({ sql, args: params });
    return result.rows;
  } catch (e) {
    console.error('DB query error:', e.message);
    return [];
  }
}

// Helper: run query and return first row
async function dbGet(sql, params = []) {
  const results = await dbAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

// Helper: run query (INSERT/UPDATE/DELETE)
async function dbRun(sql, params = []) {
  if (!db) return { changes: 0 };
  try {
    const result = await db.execute({ sql, args: params });
    return { changes: result.rowsAffected };
  } catch (e) {
    console.error('DB run error:', e.message);
    return { changes: 0 };
  }
}

// Helper to update import metadata
async function updateArticleImportMetadata(source, recordsCount) {
  await dbRun(`
    INSERT INTO article_import_metadata (source, last_updated, records_count)
    VALUES (?, datetime('now'), ?)
    ON CONFLICT(source) DO UPDATE SET
      last_updated = datetime('now'),
      records_count = ?
  `, [source, recordsCount, recordsCount]);
}

// Helper to parse numbers from strings
function parseNumber(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[$,\s%]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// Helper to parse percentage (33.03% -> 0.3303)
function parsePercent(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[%\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num / 100;
}

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== AI SETUP ====================
const { callClaude, extractJson, webTools, retrievedSources, normalizeUrl, tierInfo, setUsageSink, dateContext } = require('./lib/claude');
const storage = require('./lib/storage');
const rules = require('./lib/rules');
const modelcheck = require('./lib/modelcheck');
const { parseLite, locate, linksIn, guessTitle } = require('./lib/doc');
const { htmlToLite } = require('./lib/richtext');
const { notificationsConfigured } = require('./lib/notify');

// Which model tier and how much thinking each task gets. "standard" is the
// current Opus; "top" is the current Fable (used for the optional deep fact-check).
const TASKS = {
  headlines: { tier: 'standard', effort: 'high' },
  social: { tier: 'standard', effort: 'medium' },
  copyEdit: { tier: 'standard', effort: 'high' },
  factExtract: { tier: 'standard', effort: 'medium' },
  factVerify: { tier: 'standard', effort: 'high' },
  factVerifyDeep: { tier: 'top', effort: 'high' },
  factReview: { tier: 'standard', effort: 'medium' },
  repairJson: { tier: 'fast', effort: 'low' },
};

const PLATFORMS = {
  substack: { label: 'Substack Notes', limit: 1500 },
  twitter: { label: 'X', limit: 256 },
  linkedin: { label: 'LinkedIn', limit: 1300 },
  instagram: { label: 'Instagram', limit: 2200 },
};

// Session middleware
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'editorial-assistant-secret-key'],
  maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
}));

app.use(express.json({ limit: '50mb' }));

// Serve login page without auth
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve article analytics login page without auth
app.get('/article-analytics/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'article-analytics-login.html'));
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const correctPassword = process.env.APP_PASSWORD || 'editorial';

  if (password === correctPassword) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// Article Analytics login endpoint
app.post('/api/article-analytics/login', (req, res) => {
  const { password } = req.body;
  const correctPassword = process.env.ANALYTICS_PASSWORD || process.env.APP_PASSWORD || 'editorial';

  if (password === correctPassword) {
    req.session.articleAnalyticsAuthenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// Article Analytics auth middleware
function requireArticleAnalyticsAuth(req, res, next) {
  if (req.session.articleAnalyticsAuthenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Article analytics authentication required' });
  }
}

// Serve article analytics dashboard (requires auth)
app.get('/article-analytics', (req, res) => {
  if (req.session.articleAnalyticsAuthenticated) {
    res.sendFile(path.join(__dirname, 'public', 'article-analytics.html'));
  } else {
    res.redirect('/article-analytics/login');
  }
});

// Auth middleware
app.use((req, res, next) => {
  // Skip auth for article analytics routes (they have their own auth)
  if (req.path.startsWith('/api/article-analytics/')) {
    return next();
  }
  if (req.session.authenticated) {
    next();
  } else {
    if (req.path === '/' || req.path === '/admin' || req.path === '/rules' || req.path.endsWith('.html')) {
      res.redirect('/login');
    } else if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Not authenticated' });
    } else {
      next();
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/rules', (req, res) => res.sendFile(path.join(__dirname, 'public', 'rules.html')));

// Load style guides
const styleGuidesDir = path.join(__dirname, 'style-guides');

function loadStyleGuide(name) {
  const filePath = path.join(styleGuidesDir, `${name}.txt`);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return '';
  }
}

rules.registerScopes({
  headlines: { label: 'Headlines & dek', guide: () => loadStyleGuide('headlines') },
  social: { label: 'Social media copy', guide: () => loadStyleGuide('social-media') },
  copyEdit: { label: 'Copy-edit', guide: () => loadStyleGuide('copy-edit') },
  factCheck: { label: 'Fact-check', guide: () => loadStyleGuide('fact-check') },
});

// API: Get all style guides
app.get('/api/style-guides', (req, res) => {
  res.json({
    headlines: loadStyleGuide('headlines'),
    socialMedia: loadStyleGuide('social-media'),
    copyEdit: loadStyleGuide('copy-edit'),
    factCheck: loadStyleGuide('fact-check')
  });
});

// The style guide used for a request: the session's edited copy if the editor
// changed it in the Style Guides panel, otherwise the file on disk.
function guideFor(name, override) {
  return (override && override.trim()) ? override : loadStyleGuide(name);
}

function errorMessage(e) {
  if (e?.status === 429) return 'The AI service is busy (rate limit). Please try again in a minute.';
  if (e?.status === 529 || e?.status === 503) return 'The AI service is temporarily overloaded. Please try again shortly.';
  if (e?.status === 401) return 'The Anthropic API key is missing or invalid.';
  return e?.message || 'Something went wrong.';
}

function editorNotes(guidance) {
  return guidance && guidance.trim()
    ? `\n<editor_notes>\nNotes from the editor about this piece. Follow them unless they conflict with accuracy:\n${guidance.trim()}\n</editor_notes>\n`
    : '';
}

// ==================== FETCHING ARTICLES ====================

async function fetchSubstack(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Persuasion editorial assistant)' } });
  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  const html = await response.text();
  const $ = cheerio.load(html);

  let bodyHtml = '';
  let title = '';
  let subtitle = '';

  $('script').each((i, el) => {
    if (bodyHtml) return;
    const scriptContent = $(el).html() || '';
    if (!scriptContent.includes('window._preloads')) return;
    const m = scriptContent.match(/window\._preloads\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\)/s);
    if (!m) return;
    try {
      const preloads = JSON.parse(JSON.parse(m[1]));
      const post = preloads.post || (preloads.posts && preloads.posts[0]);
      if (post && post.body_html) {
        bodyHtml = post.body_html;
        title = post.title || '';
        subtitle = post.subtitle || '';
      }
    } catch (e) {
      console.log('Substack preload parse failed:', e.message);
    }
  });

  if (!bodyHtml) {
    for (const selector of ['.body.markup', '.available-content', '.post-content', 'article .body', '.entry-content']) {
      const el = $(selector).first();
      if (el.length && el.text().trim().length > 100) { bodyHtml = el.html(); break; }
    }
    title = title || $('h1.post-title').text().trim() || $('h1').first().text().trim();
    subtitle = subtitle || $('h3.subtitle').first().text().trim();
  }
  if (!bodyHtml) throw new Error('Could not extract article content. Make sure this is a public or shared Substack post.');

  const body = htmlToLite(bodyHtml).text;
  const head = [title ? `# ${title}` : '', subtitle].filter(Boolean).join('\n\n');
  return { text: head ? `${head}\n\n${body}` : body, title, subtitle };
}

async function fetchGoogleDoc(url) {
  let docId = null;
  for (const pattern of [/\/document\/d\/([a-zA-Z0-9-_]+)/, /\/open\?id=([a-zA-Z0-9-_]+)/, /id=([a-zA-Z0-9-_]+)/]) {
    const match = url.match(pattern);
    if (match) { docId = match[1]; break; }
  }
  if (!docId) throw Object.assign(new Error('Could not parse URL. Supported: Google Docs (shared with "Anyone with the link") or Substack posts.'), { status: 400 });

  const response = await fetch(`https://docs.google.com/document/d/${docId}/export?format=html`);
  if (!response.ok) {
    throw new Error(`Failed to fetch document: ${response.status}. Make sure the document is shared with "Anyone with the link".`);
  }
  const converted = htmlToLite(await response.text());
  return {
    text: converted.text,
    title: converted.title || guessTitle(converted.text),
    subtitle: converted.subtitle,
  };
}

// API: Fetch Google Doc or Substack, keeping italics and links
app.post('/api/fetch-doc', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim()) return res.status(400).json({ error: 'URL is required' });
  try {
    const isSubstack = url.includes('substack.com') || /https?:\/\/[^/]+\.[^/]+\/p\//.test(url) || url.includes('persuasion.community');
    const result = isSubstack && !url.includes('docs.google.com') ? await fetchSubstack(url.trim()) : await fetchGoogleDoc(url.trim());
    res.json({ content: result.text, title: result.title, subtitle: result.subtitle, formatting: 'rich' });
  } catch (error) {
    console.error('Fetch doc error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// API: Convert pasted HTML (from Google Docs, Word, Substack...) to text with
// *italics* and [links](url) preserved.
app.post('/api/convert-html', (req, res) => {
  try {
    const { text, title } = htmlToLite(String(req.body.html || ''));
    res.json({ text, title });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==================== HEADLINES & SOCIAL (options with feedback) ====================

const STOP = new Set('a an the and or but of to in on for at by with from as is are was were be its it this that how why what who we our us your their his her'.split(' '));
function wordSet(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(w => w && !STOP.has(w)));
}
function tooSimilar(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return false;
  const na = [...A].join(' '), nb = [...B].join(' ');
  if (na === nb) return true;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const containment = inter / Math.min(A.size, B.size);
  return dice >= 0.75 || (containment === 1 && Math.min(A.size, B.size) >= 3);
}

function roundsBlock(history, describe) {
  if (!Array.isArray(history) || !history.length) return '';
  return `\n<previous_rounds>\n${history.map((r, i) => `Round ${i + 1} options:\n${(r.options || []).map(o => `- ${describe(o)}`).join('\n')}${r.feedback ? `\nEditor's feedback on round ${i + 1}: ${r.feedback}` : ''}`).join('\n\n')}\n</previous_rounds>\n`;
}

function steeringInstructions({ feedback, variantOf, pinned, describe }) {
  let s = '';
  if (Array.isArray(pinned) && pinned.length) {
    s += `\n<pinned>\nThe editor has pinned these as keepers. Don't repeat them; use them as a signal of what they like:\n${pinned.map(o => `- ${describe(o)}`).join('\n')}\n</pinned>\n`;
  }
  if (variantOf) {
    s += `\n<more_like_this>\nThe editor liked this option and wants variations on it — keep what makes it work while trying different wording and angles:\n${describe(variantOf)}\n</more_like_this>\n`;
  }
  if (feedback && feedback.trim()) {
    s += `\n<latest_feedback>\n${feedback.trim()}\n</latest_feedback>\nThis feedback is the most important instruction: the new options must clearly respond to it.\n`;
  }
  return s;
}

const HEADLINE_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          style: { type: 'string' },
          headline: { type: 'string' },
          dek: { type: 'string' },
        },
        required: ['style', 'headline', 'dek'],
        additionalProperties: false,
      },
    },
  },
  required: ['options'],
  additionalProperties: false,
};

async function generateHeadlines(body, exclude = []) {
  const { article, currentTitle, currentDek, guidance, history, pinned, feedback, variantOf, styleGuide } = body;
  const describe = o => `${o.headline} — ${o.dek}`;
  const want = 3;
  const system = `You are an expert headline editor for Persuasion, a magazine defending liberal democracy and open debate.\n\n${dateContext()}\n\n<style_guide>\n${guideFor('headlines', styleGuide)}\n</style_guide>${await rules.rulesForPrompt('headlines')}`;

  const ask = variantOf
    ? `Write ${want} new headline + dek pairs that are variations on the option in <more_like_this>. Label each style "Variation".`
    : `Write ${want} headline + dek pairs in three distinct styles:
1. "Straight": clear and direct; states the argument or topic plainly.
2. "Provocative": a bold claim or challenge; assertive but never clickbait.
3. "Creative": playful, clever, or unexpected; can take creative risks (e.g. Persuasion's "All COPs Are Bastards" on climate conferences).`;

  const prompt = `<article>\n${article}\n</article>\n${currentTitle ? `\n<current_title>\n${currentTitle}${currentDek ? `\nCurrent dek: ${currentDek}` : ''}\n</current_title>\nThis is the article's working title. Do NOT suggest it, or a light rewording of it — every option must be genuinely new.\n` : ''}${editorNotes(guidance)}${roundsBlock(history, describe)}${steeringInstructions({ feedback, variantOf, pinned, describe })}${exclude.length ? `\n<already_rejected>\nThese are too close to existing titles; don't produce anything similar:\n${exclude.map(e => `- ${e}`).join('\n')}\n</already_rejected>\n` : ''}
${ask}

Every option must be new: never repeat or lightly reword the current title or any option from previous rounds or the pinned list. Use title case for headlines and sentence case for deks, per the style guide.`;

  const { json } = await callClaude({ task: 'headlines', ...TASKS.headlines, system, prompt, schema: HEADLINE_SCHEMA, maxTokens: 12000 });
  return json.options || [];
}

app.post('/api/headlines', async (req, res) => {
  const body = req.body || {};
  if (!body.article || !body.article.trim()) return res.status(400).json({ error: 'Article text is required' });
  try {
    const previous = [
      ...(body.currentTitle ? [body.currentTitle] : []),
      ...((body.history || []).flatMap(r => (r.options || []).map(o => o.headline))),
      ...((body.pinned || []).map(o => o.headline)),
    ];
    const isNew = o => o && o.headline && !previous.some(p => tooSimilar(o.headline, p));
    let options = (await generateHeadlines(body)).filter(isNew);
    if (options.length < 3) {
      // One retry for any slots lost to repeats of the current title / earlier rounds.
      const rejected = previous.slice(0, 20);
      const extra = (await generateHeadlines(body, rejected)).filter(isNew)
        .filter(o => !options.some(x => tooSimilar(x.headline, o.headline)));
      options = options.concat(extra).slice(0, 3);
    }
    res.json({ options });
  } catch (error) {
    console.error('Headlines error:', error);
    res.status(500).json({ error: errorMessage(error) });
  }
});

const SOCIAL_SCHEMA = {
  type: 'object',
  properties: {
    options: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  },
  required: ['options'],
  additionalProperties: false,
};

async function generateSocial(body) {
  const { article, platform, currentTitle, guidance, history, pinned, feedback, variantOf, styleGuide } = body;
  const p = PLATFORMS[platform];
  const describe = o => o.text;
  const system = `You are the social media editor for Persuasion, a magazine defending liberal democracy and open debate.\n\n${dateContext()}\n\n<style_guide>\n${guideFor('social-media', styleGuide)}\n</style_guide>${await rules.rulesForPrompt('social')}`;
  const ask = variantOf
    ? `Write 3 new ${p.label} posts that are variations on the post in <more_like_this>.`
    : `Write 3 distinct ${p.label} posts promoting this article, each taking a different angle or structure.`;
  const prompt = `<article>\n${article}\n</article>\n${currentTitle ? `\n<article_title>${currentTitle}</article_title>\n` : ''}${editorNotes(guidance)}${roundsBlock(history, describe)}${steeringInstructions({ feedback, variantOf, pinned, describe })}
${ask}

Platform: ${p.label}. Follow the ${p.label} section of the style guide. Hard length limit: ${p.limit} characters per post. Never include a URL or link placeholder. Never repeat a previous or pinned post.`;
  const { json } = await callClaude({ task: `social-${platform}`, ...TASKS.social, system, prompt, schema: SOCIAL_SCHEMA, maxTokens: 10000 });
  return json.options || [];
}

app.post('/api/social', async (req, res) => {
  const body = req.body || {};
  if (!body.article || !body.article.trim()) return res.status(400).json({ error: 'Article text is required' });
  if (!PLATFORMS[body.platform]) return res.status(400).json({ error: 'Unknown platform' });
  const limit = PLATFORMS[body.platform].limit;
  try {
    let options = await generateSocial(body);
    const tooLong = options.filter(o => o.text.length > limit);
    if (tooLong.length) {
      const { json } = await callClaude({
        task: `social-${body.platform}-shorten`, tier: 'standard', effort: 'low', schema: SOCIAL_SCHEMA, maxTokens: 6000,
        prompt: `These ${PLATFORMS[body.platform].label} posts are over the ${limit}-character limit. Rewrite each to fit comfortably under ${limit} characters, keeping its angle and voice. Return them in the same order.\n\n${tooLong.map((o, i) => `${i + 1}. (${o.text.length} chars) ${o.text}`).join('\n\n')}`,
      });
      const fixed = json.options || [];
      options = options.map(o => {
        const idx = tooLong.indexOf(o);
        return idx >= 0 && fixed[idx] && fixed[idx].text.length < o.text.length ? fixed[idx] : o;
      });
    }
    res.json({ options: options.map(o => ({ text: o.text, overLimit: o.text.length > limit })), limit });
  } catch (error) {
    console.error('Social error:', error);
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ==================== COPY-EDIT ====================

const COPY_CATEGORIES = ['spelling', 'grammar', 'punctuation', 'house_style', 'usage', 'consistency', 'clarity', 'other'];
const COPYEDIT_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Exact words from the article, copied character for character' },
          context_before: { type: 'string', description: 'Up to 6 words immediately before the quote, to locate it if the phrase repeats' },
          replacement: { type: 'string', description: 'What the quoted words should become' },
          explanation: { type: 'string' },
          severity: { type: 'string', enum: ['error', 'suggestion'] },
          category: { type: 'string', enum: COPY_CATEGORIES },
        },
        required: ['quote', 'context_before', 'replacement', 'explanation', 'severity', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['issues'],
  additionalProperties: false,
};

function chunkParagraphs(text, max) {
  const paras = text.split(/\n\s*\n/);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > max) { chunks.push(cur); cur = p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function copyEditChunk(chunk, { formatting, guidance, styleGuide, part, parts }) {
  const system = `You are a meticulous copy editor for Persuasion magazine.\n\n${dateContext()}\n\n<style_guide>\n${guideFor('copy-edit', styleGuide)}\n</style_guide>${await rules.rulesForPrompt('copyEdit')}`;
  const formattingNote = formatting === 'plain'
    ? 'Formatting was NOT captured for this text (plain paste): you cannot see italics, so never flag missing or incorrect italics.'
    : 'Formatting WAS captured: *asterisks* mark italics, **double asterisks** bold, and [text](url) links. Text shown in *asterisks* is italicized.';
  const prompt = `${formattingNote}${parts > 1 ? `\nThis is part ${part} of ${parts} of the article.` : ''}
${editorNotes(guidance)}
<article>
${chunk}
</article>

List the copy-editing issues in this article, following the style guide. Do NOT rewrite or reproduce the article.

For each issue:
- quote: the exact words that need changing, copied character for character from the article (without the markup asterisks/brackets unless the issue is about them). Keep it short — just enough to pinpoint the problem, usually 1 to 8 words.
- context_before: up to 6 words that come right before the quote in the article (empty string if it starts a paragraph).
- replacement: what those exact words should become. It must differ from the quote.
- explanation: one short sentence saying what's wrong (cite the rule where relevant, e.g. "House style: serial comma").
- severity: "error" for objective mistakes and style-guide violations; "suggestion" for optional clarity improvements.
- category: one of ${COPY_CATEGORIES.join(', ')}.

Only include real problems you are confident about. If something is already correct, leave it out entirely — never list an item just to say it's fine. Return an empty list if the article is clean.`;
  const { json } = await callClaude({ task: 'copy-edit', ...TASKS.copyEdit, system, prompt, schema: COPYEDIT_SCHEMA, maxTokens: 24000 });
  return json.issues || [];
}

function publicDoc(d) { return { text: d.text, marks: d.marks }; }

app.post('/api/copy-edit', async (req, res) => {
  const { article, formatting = 'rich', guidance, styleGuide } = req.body || {};
  if (!article || !article.trim()) return res.status(400).json({ error: 'Article text is required' });
  try {
    const chunks = article.length > 80000 ? chunkParagraphs(article, 40000) : [article];
    const results = await Promise.all(chunks.map((c, i) => copyEditChunk(c, { formatting, guidance, styleGuide, part: i + 1, parts: chunks.length })));
    const doc = parseLite(article);
    const used = [];
    const seen = new Set();
    const issues = [];
    for (const raw of results.flat()) {
      const quote = String(raw.quote || '').trim();
      const replacement = String(raw.replacement ?? '');
      if (!quote) continue;
      // Drop non-issues (replacement identical to the original) — these are the
      // "flags something, then realizes it's fine" cases.
      const squash = s => s.replace(/\s+/g, ' ').trim();
      if (squash(replacement) === squash(quote)) continue;
      if (formatting === 'plain' && /italic/i.test(`${raw.explanation} ${raw.category}`)) continue;
      const loc = locate(doc, quote, raw.context_before, used);
      // "Should be italicized" when the text already is italic: drop.
      const onlyAsterisks = squash(replacement.replace(/\*/g, '')) === squash(quote.replace(/\*/g, ''));
      if (onlyAsterisks && loc && doc.marks.some(m => m.type === 'i' && m.start <= loc.start && m.end >= loc.end)) continue;
      const key = loc ? `${loc.start}:${loc.end}:${replacement}` : `x:${quote}:${replacement}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (loc) used.push(loc);
      issues.push({
        quote, replacement, explanation: raw.explanation,
        severity: raw.severity === 'suggestion' ? 'suggestion' : 'error',
        category: raw.category,
        start: loc ? loc.start : null, end: loc ? loc.end : null,
        approximate: !!loc?.approximate,
      });
    }
    issues.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
    issues.forEach((it, i) => { it.id = i + 1; });
    res.json({ doc: publicDoc(doc), issues });
  } catch (error) {
    console.error('Copy-edit error:', error);
    res.status(500).json({ error: errorMessage(error) });
  }
});

// ==================== FACT-CHECK ====================

const CLAIM_CATEGORIES = ['quote', 'statistic', 'person', 'event', 'history', 'law_policy', 'research', 'other'];
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Exact words from the article containing the claim' },
          claim: { type: 'string', description: 'The claim restated so it can be checked without the article' },
          category: { type: 'string', enum: CLAIM_CATEGORIES },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          linked_url: { type: 'string', description: 'URL of the author\'s link supporting this claim, or empty string' },
          legal_sensitivity: { type: 'boolean' },
        },
        required: ['quote', 'claim', 'category', 'priority', 'linked_url', 'legal_sensitivity'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
};

const VERDICTS = ['correct', 'incorrect', 'imprecise', 'unsupported', 'opinion'];
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          keep_flag: { type: 'boolean' },
          verdict: { type: 'string', enum: VERDICTS },
          explanation: { type: 'string' },
          correction: { type: 'string' },
        },
        required: ['id', 'keep_flag', 'verdict', 'explanation', 'correction'],
        additionalProperties: false,
      },
    },
  },
  required: ['reviews'],
  additionalProperties: false,
};
const VERIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          verdict: { type: 'string', enum: VERDICTS },
          explanation: { type: 'string' },
          correction: { type: 'string' },
          sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' } }, required: ['url', 'title'], additionalProperties: false } },
          legal_sensitivity: { type: 'boolean' },
        },
        required: ['id', 'verdict', 'explanation', 'correction', 'sources', 'legal_sensitivity'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

async function factSystem(styleGuide) {
  return `You are a rigorous, fair-minded fact-checker for Persuasion magazine.\n\n${dateContext()}\n\n<guide>\n${guideFor('fact-check', styleGuide)}\n</guide>${await rules.rulesForPrompt('factCheck')}`;
}

async function extractClaims(article, { guidance, styleGuide }) {
  const prompt = `${editorNotes(guidance)}
<article>
${article}
</article>

Identify the checkable factual claims in this article, following the guide. Skip opinions, arguments, predictions, and rhetoric. If there are more than 40, keep the 40 that matter most (quotes, numbers, claims about named people, and anything legally sensitive come first).

For each claim:
- quote: the exact words from the article that contain the claim (copied character for character, without markup; a clause or sentence, at most about 40 words)
- claim: the claim restated as a standalone sentence, adding any context needed to check it (who, what, when)
- category, priority (how much it matters if wrong)
- linked_url: if the author linked a source for this claim in the same sentence, that URL exactly as written in the article; otherwise ""
- legal_sensitivity: true if it alleges wrongdoing or misconduct by an identifiable person or organization, or concerns a private individual`;
  const { json } = await callClaude({ task: 'fact-extract', ...TASKS.factExtract, system: await factSystem(styleGuide), prompt, schema: EXTRACT_SCHEMA, maxTokens: 16000 });
  return (json.claims || []).slice(0, 40);
}

async function verifyBatch(article, batch, { styleGuide, deep, articleLinks }) {
  const n = batch.length;
  const prompt = `<article>
${article}
</article>

<claims_to_check>
${batch.map(c => `[${c.id}] ${c.claim}\n    Article wording: "${c.quote}"${c.linked_url ? `\n    Author's linked source: ${c.linked_url}` : ''}`).join('\n\n')}
</claims_to_check>

Check each claim above, following the guide. For a claim with an author's linked source, fetch that page first and see whether it supports the claim. Then search the web as needed — use searches efficiently, and prefer primary and established sources.

When you have finished checking, reply with ONLY a JSON object in a \`\`\`json code block, in this shape:
{"results": [{"id": <claim number>, "verdict": "correct|incorrect|imprecise|unsupported|opinion", "explanation": "<1-3 sentences: your conclusion and the evidence>", "correction": "<the accurate version, or empty string>", "sources": [{"url": "<a page you actually read or found in search>", "title": "<page title>"}], "legal_sensitivity": <true|false>}]}

Include every claim number exactly once. The explanation must state only your final conclusion — no back-and-forth, and never a flag that you then retract.`;

  const task = deep ? TASKS.factVerifyDeep : TASKS.factVerify;
  const result = await callClaude({
    task: deep ? 'fact-verify-deep' : 'fact-verify', ...task,
    system: await factSystem(styleGuide), prompt,
    tools: webTools({ searches: 3 * n + 2, fetches: 2 * n + 2 }), maxTokens: 32000,
  });

  let parsed = extractJson(result.text);
  if (!parsed || !Array.isArray(parsed.results)) {
    const repair = await callClaude({
      task: 'fact-repair-json', ...TASKS.repairJson, schema: VERIFY_JSON_SCHEMA, maxTokens: 8000,
      prompt: `Convert this fact-check write-up into the JSON shape required. Do not change any conclusions.\n\nClaim numbers: ${batch.map(c => c.id).join(', ')}\n\n${result.text}`,
    });
    parsed = repair.json;
  }

  const retrieved = retrievedSources(result.blocks);
  for (const l of articleLinks) retrieved.set(normalizeUrl(l.href), { url: l.href, title: l.text });

  const byId = new Map((parsed.results || []).map(r => [Number(r.id), r]));
  return batch.map(c => {
    const r = byId.get(c.id);
    if (!r) return { id: c.id, verdict: 'unsupported', explanation: 'The checker did not return a result for this claim.', correction: '', sources: [], legal_sensitivity: c.legal_sensitivity, error: true };
    const sources = [];
    for (const s of r.sources || []) {
      const hit = retrieved.get(normalizeUrl(s.url));
      if (hit && !sources.some(x => normalizeUrl(x.url) === normalizeUrl(hit.url))) sources.push({ url: hit.url, title: s.title || hit.title });
    }
    return {
      id: c.id,
      verdict: VERDICTS.includes(String(r.verdict).toLowerCase()) ? String(r.verdict).toLowerCase() : 'unsupported',
      explanation: r.explanation || '',
      correction: r.correction || '',
      sources,
      legal_sensitivity: !!(r.legal_sensitivity || c.legal_sensitivity),
    };
  });
}

async function reviewFlags(results, claims, { styleGuide }) {
  const flagged = results.filter(r => ['incorrect', 'imprecise', 'unsupported'].includes(r.verdict) && !r.error);
  if (!flagged.length) return results;
  const claimById = new Map(claims.map(c => [c.id, c]));
  const prompt = `You are the senior editor doing a final pass over fact-check flags before they go to the author. Each flag below was produced by a checker with web access.

${flagged.map(r => {
    const c = claimById.get(r.id);
    return `[${r.id}] Claim: ${c.claim}\nArticle wording: "${c.quote}"\nVerdict: ${r.verdict}\nExplanation: ${r.explanation}${r.correction ? `\nCorrection: ${r.correction}` : ''}\nSources: ${r.sources.map(s => s.url).join(', ') || 'none'}`;
  }).join('\n\n')}

For each flag, decide whether it should go to the author.
Set keep_flag to false if: the explanation itself indicates the claim is accurate or substantially accurate; the problem is an immaterial quibble; the "claim" is really opinion, interpretation, or hyperbole; or the only basis for doubt is not recognizing a recent event.
For flags you keep, you may adjust the verdict, and rewrite the explanation so it states only the conclusion and the evidence in 1-3 sentences, without hedging or narrating the checking process. For flags you drop, set verdict to "correct" (or "opinion" if it isn't a factual claim) and give a one-sentence explanation.
Return a review for every flag id.`;
  try {
    const { json } = await callClaude({ task: 'fact-review', ...TASKS.factReview, system: await factSystem(styleGuide), prompt, schema: REVIEW_SCHEMA, maxTokens: 12000 });
    const reviews = new Map((json.reviews || []).map(r => [Number(r.id), r]));
    return results.map(r => {
      const rev = reviews.get(r.id);
      if (!rev || !flagged.includes(r)) return r;
      return {
        ...r,
        verdict: rev.keep_flag ? (VERDICTS.includes(String(rev.verdict).toLowerCase()) ? String(rev.verdict).toLowerCase() : r.verdict) : (String(rev.verdict).toLowerCase() === 'opinion' ? 'opinion' : 'correct'),
        explanation: rev.explanation || r.explanation,
        correction: rev.keep_flag ? (rev.correction || r.correction) : '',
        reviewed: true,
      };
    });
  } catch (e) {
    console.error('Fact review pass failed (keeping unreviewed flags):', e.message);
    return results;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

app.post('/api/fact-check', async (req, res) => {
  const { article, guidance, styleGuide, deep = false } = req.body || {};
  if (!article || !article.trim()) return res.status(400).json({ error: 'Article text is required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (type, data = {}) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  let closed = false;
  res.on('close', () => { if (!res.writableEnded) closed = true; clearInterval(heartbeat); });

  try {
    const doc = parseLite(article);
    const articleLinks = linksIn(doc);
    send('progress', { message: 'Identifying claims to check...' });
    const rawClaims = await extractClaims(article, { guidance, styleGuide });
    const used = [];
    const claims = rawClaims.map((c, i) => {
      const loc = locate(doc, c.quote, '', used);
      if (loc) used.push(loc);
      return { ...c, id: i + 1, start: loc ? loc.start : null, end: loc ? loc.end : null };
    });
    send('claims', { doc: publicDoc(doc), claims });
    if (!claims.length) { send('final', { results: [] }); send('done'); return; }

    const batches = [];
    for (let i = 0; i < claims.length; i += 4) batches.push(claims.slice(i, i + 4));
    let done = 0;
    send('progress', { message: `Checking ${claims.length} claims against the web${deep ? ' (deep check)' : ''}...` });
    const batchResults = await mapLimit(batches, 4, async (batch) => {
      if (closed) return [];
      let results;
      try {
        results = await verifyBatch(article, batch, { styleGuide, deep, articleLinks });
      } catch (e) {
        console.error('Verify batch failed:', e);
        results = batch.map(c => ({ id: c.id, verdict: 'unsupported', explanation: `Could not be checked: ${errorMessage(e)}`, correction: '', sources: [], legal_sensitivity: c.legal_sensitivity, error: true }));
      }
      done += batch.length;
      send('verdicts', { results });
      send('progress', { message: `Checked ${done} of ${claims.length} claims...` });
      return results;
    });

    send('progress', { message: 'Final review of flagged claims...' });
    const reviewed = await reviewFlags(batchResults.flat(), claims, { styleGuide });
    send('final', { results: reviewed });
    send('done');
  } catch (error) {
    console.error('Fact-check error:', error);
    send('error', { error: errorMessage(error) });
    send('done');
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// ==================== HOUSE RULES ====================

app.get('/api/rules', async (req, res) => {
  try {
    const all = await rules.listRules();
    res.json({ scopes: rules.scopeList(), rules: all.map(r => ({ id: r.id, scope: r.scope, rule: r.rule, status: r.status, submitted_by: r.submitted_by, created_at: r.created_at, review_note: r.status === 'pending' ? r.review_note : undefined })) });
  } catch (e) {
    res.status(500).json({ error: errorMessage(e) });
  }
});

app.post('/api/rules', async (req, res) => {
  try {
    const { scope, text, submittedBy, context } = req.body || {};
    if (!submittedBy || !submittedBy.trim()) return res.status(400).json({ error: 'Please add your name.' });
    res.json(await rules.submitRule({ scope, text, submittedBy: submittedBy.trim(), context }));
  } catch (e) {
    console.error('Rule submit error:', e);
    res.status(400).json({ error: errorMessage(e) });
  }
});

app.get('/api/meta', async (req, res) => {
  const tiers = tierInfo();
  res.json({
    models: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, v.model])),
    pendingRules: await rules.pendingCount().catch(() => 0),
    platforms: PLATFORMS,
  });
});

// ==================== ADMIN ====================

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(401).json({ error: 'Admin login required' });
}

app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(400).json({ error: 'Admin access is not set up. Add an ADMIN_PASSWORD environment variable on Render.' });
  if (req.body?.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Incorrect admin password' });
});

app.post('/api/admin/logout', (req, res) => { req.session.isAdmin = false; res.json({ success: true }); });

app.get('/api/admin/state', requireAdmin, async (req, res) => {
  try {
    res.json({
      rules: await rules.listRules({ includeRejected: true }),
      scopes: rules.scopeList(),
      models: await modelcheck.status(),
      usage: await storage.usageSummary(30),
      notificationsConfigured: notificationsConfigured(),
    });
  } catch (e) {
    res.status(500).json({ error: errorMessage(e) });
  }
});

app.post('/api/admin/rules/:id/decide', requireAdmin, async (req, res) => {
  try {
    await rules.decideRule(Number(req.params.id), { approve: !!req.body.approve, editedRule: req.body.rule, by: 'admin' });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});

app.put('/api/admin/rules/:id', requireAdmin, async (req, res) => {
  try {
    if (!req.body.rule || !req.body.rule.trim()) return res.status(400).json({ error: 'Rule text is empty' });
    await rules.updateRule(Number(req.params.id), req.body.rule.trim());
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});

app.delete('/api/admin/rules/:id', requireAdmin, async (req, res) => {
  try { await rules.deleteRule(Number(req.params.id)); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});

app.post('/api/admin/models/check', requireAdmin, async (req, res) => {
  try { await modelcheck.checkForUpgrades(); res.json(await modelcheck.status()); }
  catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.post('/api/admin/models/approve', requireAdmin, async (req, res) => {
  try { await modelcheck.approveUpgrade(req.body.tier, req.body.model); res.json(await modelcheck.status()); }
  catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});

app.post('/api/admin/models/revert', requireAdmin, async (req, res) => {
  try { await modelcheck.revertTier(req.body.tier); res.json(await modelcheck.status()); }
  catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});

app.post('/api/admin/models/snooze', requireAdmin, async (req, res) => {
  try { await modelcheck.snooze(); res.json(await modelcheck.status()); }
  catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});

// ==================== ARTICLE ANALYTICS API ENDPOINTS ====================

// Get articles (paginated to avoid Turso timeout with large datasets)
app.get('/api/article-analytics/articles', requireArticleAnalyticsAuth, async (req, res) => {
  try {
    const source = req.query.source || 'all';
    const listName = req.query.list_name || 'all';
    const articleType = req.query.article_type || 'all';
    const accessType = req.query.access_type || 'all';
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 50);
    const offset = (page - 1) * limit;

    const conditions = [];
    const params = [];

    if (source !== 'all') {
      conditions.push(`source = ?`);
      params.push(source);
    }

    if (listName !== 'all') {
      conditions.push(`list_name = ?`);
      params.push(listName);
    }

    if (articleType !== 'all') {
      conditions.push(`article_type = ?`);
      params.push(articleType);
    }

    if (accessType !== 'all') {
      conditions.push(`access_type = ?`);
      params.push(accessType);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    // Get total count
    const countResult = await dbGet(`SELECT COUNT(*) as total FROM articles${whereClause}`, params);
    const total = countResult ? countResult.total : 0;

    // Get paginated articles (select specific columns to avoid Turso timeout with SELECT *)
    const articles = await dbAll(
      `SELECT id, title, published_date, source, views, open_rate, new_paid_subs, canceled_paid_subs, new_free_subs, estimated_revenue, recipients, engagement_rate, click_through_rate, shares, article_type, access_type, author, list_name, likes, comments, original_source FROM articles${whereClause} ORDER BY published_date DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ articles, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get analytics summary
app.get('/api/article-analytics/summary', requireArticleAnalyticsAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    const source = req.query.source || 'all';
    const listName = req.query.list_name || 'all';
    const articleType = req.query.article_type || 'all';
    const accessType = req.query.access_type || 'all';

    // Quote values as SQL string literals (doubling single quotes) so query
    // parameters can't inject SQL.
    const lit = v => `'${String(v).replace(/'/g, "''")}'`;
    let dateFilter = days > 0 ? `published_date >= date('now', '-${days} days')` : '1=1';
    let sourceFilter = source !== 'all' ? `source = ${lit(source)}` : '1=1';
    let listFilter = listName !== 'all' ? `list_name = ${lit(listName)}` : '1=1';
    let typeFilter = articleType !== 'all' ? `article_type = ${lit(articleType)}` : '1=1';
    let accessFilter = accessType !== 'all' ? `access_type = ${lit(accessType)}` : '1=1';
    let whereClause = `WHERE ${dateFilter} AND ${sourceFilter} AND ${listFilter} AND ${typeFilter} AND ${accessFilter}`;

    // Total stats
    const totalStats = await dbGet(`
      SELECT
        COUNT(*) as total_articles,
        COALESCE(SUM(views), 0) as total_views,
        COALESCE(AVG(views), 0) as avg_views,
        COALESCE(AVG(open_rate), 0) as avg_open_rate,
        COALESCE(SUM(new_paid_subs), 0) as total_new_paid_subs,
        COALESCE(SUM(new_free_subs), 0) as total_new_free_subs,
        COALESCE(SUM(estimated_revenue), 0) as total_revenue,
        COALESCE(SUM(likes), 0) as total_likes
      FROM articles ${whereClause}
    `);

    // Weekly data
    const weeklyData = await dbAll(`
      SELECT
        strftime('%Y-%W', published_date) as week,
        COUNT(*) as article_count,
        SUM(views) as total_views,
        AVG(views) as avg_views,
        AVG(open_rate) as avg_open_rate,
        SUM(new_paid_subs + new_free_subs) as new_subs
      FROM articles ${whereClause}
      GROUP BY week
      ORDER BY week DESC
      LIMIT 52
    `);

    // Monthly data
    const monthlyData = await dbAll(`
      SELECT
        strftime('%Y-%m', published_date) as month,
        COUNT(*) as article_count,
        SUM(views) as total_views,
        AVG(views) as avg_views,
        AVG(open_rate) as avg_open_rate
      FROM articles ${whereClause}
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    // Top 10 articles by views
    const topArticles = await dbAll(`
      SELECT * FROM articles ${whereClause}
      ORDER BY views DESC
      LIMIT 10
    `);

    // Bottom 10 articles by views (excluding 0)
    const bottomArticles = await dbAll(`
      SELECT * FROM articles ${whereClause} AND views > 0
      ORDER BY views ASC
      LIMIT 10
    `);

    // Latest 20 articles
    const latestArticles = await dbAll(`
      SELECT * FROM articles ${whereClause}
      ORDER BY published_date DESC
      LIMIT 20
    `);

    // By article type
    const byType = await dbAll(`
      SELECT
        article_type,
        COUNT(*) as count,
        AVG(views) as avg_views,
        SUM(views) as total_views,
        AVG(open_rate) as avg_open_rate
      FROM articles ${whereClause}
      GROUP BY article_type
      ORDER BY total_views DESC
    `);

    // By source
    const bySource = await dbAll(`
      SELECT
        source,
        COUNT(*) as count,
        AVG(views) as avg_views,
        SUM(views) as total_views,
        AVG(open_rate) as avg_open_rate,
        SUM(new_paid_subs) as total_paid_subs,
        SUM(new_free_subs) as total_free_subs
      FROM articles
      WHERE ${dateFilter} AND ${listFilter} AND ${typeFilter} AND ${accessFilter}
      GROUP BY source
      ORDER BY total_views DESC
    `);

    // By list
    const byList = await dbAll(`
      SELECT
        list_name,
        COUNT(*) as count,
        AVG(views) as avg_views,
        SUM(views) as total_views,
        AVG(open_rate) as avg_open_rate,
        SUM(new_paid_subs) as total_paid_subs,
        SUM(likes) as total_likes
      FROM articles
      WHERE ${dateFilter} AND ${sourceFilter} AND ${typeFilter} AND ${accessFilter}
      GROUP BY list_name
      ORDER BY total_views DESC
    `);

    res.json({
      totalStats,
      weeklyData,
      monthlyData,
      topArticles,
      bottomArticles,
      latestArticles,
      byType,
      bySource,
      byList
    });
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get import metadata
app.get('/api/article-analytics/import-metadata', requireArticleAnalyticsAuth, async (req, res) => {
  try {
    const metadata = await dbAll(`SELECT source, last_updated, records_count FROM article_import_metadata`);
    res.json(metadata);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import CSV data
app.post('/api/article-analytics/import/csv', requireArticleAnalyticsAuth, async (req, res) => {
  const { csvData, source } = req.body;

  if (!csvData || !csvData.trim()) {
    return res.status(400).json({ error: 'CSV data is required' });
  }

  if (!source || !['ym', 'persuasion'].includes(source)) {
    return res.status(400).json({ error: 'Source must be "ym" or "persuasion"' });
  }

  try {
    const lines = csvData.trim().split('\n');
    const header = lines[0].toLowerCase();
    const cols = header.split(',').map(c => c.trim().replace(/"/g, ''));

    // Detect columns
    const titleIdx = cols.findIndex(c => c.includes('title') || c.includes('post') || c.includes('name'));
    const dateIdx = cols.findIndex(c => c.includes('date') || c.includes('published'));
    const viewsIdx = cols.findIndex(c => c.includes('view') || c.includes('total view'));
    const openRateIdx = cols.findIndex(c => c.includes('open rate') || c.includes('open_rate'));
    const paidSubsIdx = cols.findIndex(c => c.includes('paid sub') || c.includes('new paid'));
    const freeSubsIdx = cols.findIndex(c => c.includes('free sub') || c.includes('new free'));
    const revenueIdx = cols.findIndex(c => c.includes('revenue') || c.includes('estimated'));
    const recipientsIdx = cols.findIndex(c => c.includes('recipient') || c.includes('sent'));
    const engagementIdx = cols.findIndex(c => c.includes('engagement'));
    const sharesIdx = cols.findIndex(c => c.includes('share'));

    console.log('Article import - columns detected:', { cols, titleIdx, dateIdx, viewsIdx, openRateIdx, source });

    if (titleIdx === -1) {
      return res.status(400).json({ error: 'Could not find title column' });
    }

    let imported = 0;
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Parse CSV line (handle quoted fields)
      const values = [];
      let current = '';
      let inQuotes = false;
      for (const char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());

      const title = values[titleIdx]?.replace(/"/g, '');
      if (!title) {
        skipped++;
        continue;
      }

      const dateStr = dateIdx >= 0 ? values[dateIdx]?.replace(/"/g, '') : null;
      const views = viewsIdx >= 0 ? parseNumber(values[viewsIdx]) : 0;
      const openRate = openRateIdx >= 0 ? parsePercent(values[openRateIdx]) : 0;
      const paidSubs = paidSubsIdx >= 0 ? parseNumber(values[paidSubsIdx]) : 0;
      const freeSubs = freeSubsIdx >= 0 ? parseNumber(values[freeSubsIdx]) : 0;
      const revenue = revenueIdx >= 0 ? parseNumber(values[revenueIdx]) : 0;
      const recipients = recipientsIdx >= 0 ? parseNumber(values[recipientsIdx]) : 0;
      const engagement = engagementIdx >= 0 ? parsePercent(values[engagementIdx]) : 0;
      const shares = sharesIdx >= 0 ? parseNumber(values[sharesIdx]) : 0;

      // Parse date
      let publishedDate = dateStr;
      if (dateStr) {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          publishedDate = parsed.toISOString().split('T')[0];
        }
      }

      if (i <= 3) {
        console.log(`Row ${i}: title="${title}", views=${views}, openRate=${openRate}, date=${publishedDate}`);
      }

      try {
        await dbRun(`
          INSERT INTO articles (title, published_date, source, views, open_rate, new_paid_subs, new_free_subs, estimated_revenue, recipients, engagement_rate, shares)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(title, published_date, source) DO UPDATE SET
            views = ?, open_rate = ?, new_paid_subs = ?, new_free_subs = ?, estimated_revenue = ?,
            recipients = ?, engagement_rate = ?, shares = ?, updated_at = datetime('now')
        `, [title, publishedDate || new Date().toISOString().split('T')[0], source, views, openRate, paidSubs, freeSubs, revenue, recipients, engagement, shares,
            views, openRate, paidSubs, freeSubs, revenue, recipients, engagement, shares]);
        imported++;
      } catch (e) {
        console.error(`Error importing row ${i}:`, e.message);
        skipped++;
      }
    }

    await updateArticleImportMetadata(source, imported);
    res.json({ success: true, imported, skipped });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add/Update article manually
app.post('/api/article-analytics/articles', requireArticleAnalyticsAuth, async (req, res) => {
  const { title, published_date, source, views, open_rate, new_paid_subs, new_free_subs, estimated_revenue, article_type, author } = req.body;

  if (!title || !published_date || !source) {
    return res.status(400).json({ error: 'Title, published_date, and source are required' });
  }

  try {
    await dbRun(`
      INSERT INTO articles (title, published_date, source, views, open_rate, new_paid_subs, new_free_subs, estimated_revenue, article_type, author)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(title, published_date, source) DO UPDATE SET
        views = ?, open_rate = ?, new_paid_subs = ?, new_free_subs = ?, estimated_revenue = ?,
        article_type = ?, author = ?, updated_at = datetime('now')
    `, [title, published_date, source, views || 0, open_rate || 0, new_paid_subs || 0, new_free_subs || 0, estimated_revenue || 0, article_type || 'essay', author || null,
        views || 0, open_rate || 0, new_paid_subs || 0, new_free_subs || 0, estimated_revenue || 0, article_type || 'essay', author || null]);
    res.json({ success: true });
  } catch (error) {
    console.error('Add article error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update article
app.put('/api/article-analytics/articles/:id', requireArticleAnalyticsAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { published_date, source, views, open_rate, new_paid_subs, canceled_paid_subs, new_free_subs, estimated_revenue, recipients, engagement_rate, click_through_rate, shares, article_type, access_type, author, list_name, likes, comments } = req.body;

    const updates = [];
    const params = [];

    if (published_date !== undefined) { updates.push('published_date = ?'); params.push(published_date); }
    if (source !== undefined) { updates.push('source = ?'); params.push(source); }
    if (views !== undefined) { updates.push('views = ?'); params.push(views); }
    if (open_rate !== undefined) { updates.push('open_rate = ?'); params.push(open_rate); }
    if (new_paid_subs !== undefined) { updates.push('new_paid_subs = ?'); params.push(new_paid_subs); }
    if (canceled_paid_subs !== undefined) { updates.push('canceled_paid_subs = ?'); params.push(canceled_paid_subs); }
    if (new_free_subs !== undefined) { updates.push('new_free_subs = ?'); params.push(new_free_subs); }
    if (estimated_revenue !== undefined) { updates.push('estimated_revenue = ?'); params.push(estimated_revenue); }
    if (recipients !== undefined) { updates.push('recipients = ?'); params.push(recipients); }
    if (engagement_rate !== undefined) { updates.push('engagement_rate = ?'); params.push(engagement_rate); }
    if (click_through_rate !== undefined) { updates.push('click_through_rate = ?'); params.push(click_through_rate); }
    if (shares !== undefined) { updates.push('shares = ?'); params.push(shares); }
    if (article_type !== undefined) { updates.push('article_type = ?'); params.push(article_type); }
    if (access_type !== undefined) { updates.push('access_type = ?'); params.push(access_type); }
    if (author !== undefined) { updates.push('author = ?'); params.push(author); }
    if (list_name !== undefined) { updates.push('list_name = ?'); params.push(list_name); }
    if (likes !== undefined) { updates.push('likes = ?'); params.push(likes); }
    if (comments !== undefined) { updates.push('comments = ?'); params.push(comments); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = datetime(\'now\')');
    params.push(id);

    await dbRun(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete article
app.delete('/api/article-analytics/articles/:id', requireArticleAnalyticsAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM articles WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sync from Substack - now disabled since scraper runs locally with Turso
app.post('/api/article-analytics/sync', requireArticleAnalyticsAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ status: 'info', message: 'Server-side sync is disabled.' });
  sendEvent({ status: 'info', message: 'Data is now stored in Turso cloud database.' });
  sendEvent({ status: 'info', message: '' });
  sendEvent({ status: 'info', message: 'To update data, run the scraper locally:' });
  sendEvent({ status: 'info', message: '  cd /Users/yaschamounk/editorial-assistant' });
  sendEvent({ status: 'info', message: '  node scrape-articles.js --pages 5' });
  sendEvent({ status: 'complete', message: '' });
  res.end();
});


// ==================== STARTUP ====================
function tursoStore() {
  return {
    all: async (sql, args = []) => (await db.execute({ sql, args })).rows,
    get: async (sql, args = []) => (await db.execute({ sql, args })).rows[0] || null,
    run: async (sql, args = []) => db.execute({ sql, args }),
  };
}

initDatabase().then(async () => {
  await storage.initStorage(tursoStore());
  setUsageSink(storage.recordUsage);
  await modelcheck.loadOverrides();
  modelcheck.startModelChecks();
  app.listen(PORT, () => {
    console.log(`Editorial Assistant running at http://localhost:${PORT}`);
    console.log(`Article Analytics available at http://localhost:${PORT}/article-analytics`);
    console.log('Models:', Object.entries(tierInfo()).map(([t, v]) => `${t}=${v.model}`).join(', '));
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
