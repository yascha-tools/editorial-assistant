const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cookieSession = require('cookie-session');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const anthropic = new Anthropic();

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

// Logout endpoint
app.post('/api/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// Auth middleware
app.use((req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.redirect('/login');
    } else if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Not authenticated' });
    } else {
      next();
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));

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

// API: Get all style guides
app.get('/api/style-guides', (req, res) => {
  res.json({
    headlines: loadStyleGuide('headlines'),
    socialMedia: loadStyleGuide('social-media'),
    copyEdit: loadStyleGuide('copy-edit'),
    factCheck: loadStyleGuide('fact-check')
  });
});

// API: Fetch Google Doc or Substack
app.post('/api/fetch-doc', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Check if it's a Substack URL
    if (url.includes('substack.com') || url.match(/https?:\/\/[^\/]+\.[^\/]+\/p\//)) {
      // Fetch Substack article
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status}`);
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      let content = '';
      let title = '';

      // Helper to extract text while preserving italics as markdown
      function extractTextWithItalics($el, $) {
        // Convert <em> and <i> tags to markdown italics
        $el.find('em, i').each((idx, elem) => {
          const $elem = $(elem);
          const rawText = $elem.text();
          const trimmed = rawText.trim();
          // Preserve leading/trailing spaces outside the asterisks
          const leadingSpace = rawText.match(/^\s+/) ? ' ' : '';
          const trailingSpace = rawText.match(/\s+$/) ? ' ' : '';
          $elem.replaceWith(`${leadingSpace}*${trimmed}*${trailingSpace}`);
        });
        return $el.text().trim();
      }

      // First, try to extract from JSON preloads (works for drafts and some posts)
      const allScripts = $('script');
      allScripts.each((i, el) => {
        if (content && content.length > 100) return; // Already found content

        const scriptContent = $(el).html() || '';
        if (scriptContent.includes('body_html') && scriptContent.includes('window._preloads')) {
          // Extract the JSON string from: window._preloads = JSON.parse("...")
          const jsonMatch = scriptContent.match(/window\._preloads\s*=\s*JSON\.parse\("(.+)"\)/s);
          if (jsonMatch) {
            try {
              // The JSON is escaped - we need to unescape it
              // First unescape the outer string escaping
              let jsonStr = jsonMatch[1];
              // Replace escaped quotes and backslashes
              jsonStr = jsonStr.replace(/\\"/g, '"');
              jsonStr = jsonStr.replace(/\\\\/g, '\\');

              const preloads = JSON.parse(jsonStr);

              // Look for post data in various locations
              const post = preloads.post || (preloads.posts && preloads.posts[0]);
              if (post && post.body_html) {
                title = post.title || '';
                // Parse HTML content, preserving italics
                const $body = cheerio.load(post.body_html);
                content = $body('p, h1, h2, h3, h4, blockquote, li').map((idx, elem) => {
                  return extractTextWithItalics($body(elem).clone(), $body);
                }).get().filter(t => t.length > 0).join('\n\n');
              }
            } catch (e) {
              console.log('JSON parse failed:', e.message);
            }
          }
        }
      });

      // Fall back to HTML selectors if JSON extraction failed
      if (!content || content.length < 100) {
        const selectors = ['.body.markup', '.post-content', '.available-content', 'article .body', '.entry-content'];

        for (const selector of selectors) {
          const element = $(selector);
          if (element.length > 0) {
            element.find('button, .subscription-widget, .captioned-image-container figcaption').remove();
            content = element.find('p, h1, h2, h3, h4, blockquote, li').map((i, el) => {
              return extractTextWithItalics($(el).clone(), $);
            }).get().join('\n\n');
            if (content.length > 100) break;
          }
        }

        if (!title) {
          title = $('h1.post-title').text().trim() || $('h1').first().text().trim() || '';
        }
      }

      if (!content || content.length < 100) {
        throw new Error('Could not extract article content. Make sure this is a public or shared Substack post.');
      }

      const finalContent = title ? `${title}\n\n${content}` : content;

      res.json({ content: finalContent });
    } else {
      // Google Doc URL
      let docId = null;
      const patterns = [
        /\/document\/d\/([a-zA-Z0-9-_]+)/,
        /\/open\?id=([a-zA-Z0-9-_]+)/,
        /id=([a-zA-Z0-9-_]+)/
      ];

      for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
          docId = match[1];
          break;
        }
      }

      if (!docId) {
        return res.status(400).json({ error: 'Could not parse URL. Supported: Google Docs (shared publicly) or Substack articles.' });
      }

      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      const response = await fetch(exportUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch document: ${response.status}. Make sure the document is shared with "Anyone with the link".`);
      }

      const content = await response.text();
      res.json({ content });
    }
  } catch (error) {
    console.error('Fetch doc error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Prompt creation functions
function createHeadlinePrompt(text, styleGuide) {
  const guideSection = styleGuide?.trim()
    ? `\n\nStyle Guide for Headlines:\n${styleGuide}\n\n---\n\n`
    : '';

  return `You are an expert editor for Persuasion, a magazine focused on defending liberal democracy and promoting open debate.
${guideSection}
Generate 3 headline and dek (subheadline) pairs for this article, each with a different style:

1. STRAIGHT: Clear, direct, to the point. States the main argument or topic plainly.

2. PROVOCATIVE: Grabs attention, makes a bold claim or poses a challenge. More assertive than straight, but NOT clickbait.

3. CREATIVE: Playful, clever, or unexpected. Can use wordplay, cultural references, or surprising framing. Example from Persuasion's past: "All COPs Are Bastards" (about climate conferences). Be willing to take creative risks.

All three should:
- Capture the essence of the article
- Match Persuasion's tone: intelligent, accessible, principled

Format your response as JSON:
{
  "suggestions": [
    { "style": "Straight", "headline": "...", "dek": "..." },
    { "style": "Provocative", "headline": "...", "dek": "..." },
    { "style": "Creative", "headline": "...", "dek": "..." }
  ]
}

Article:
${text}`;
}

function createSocialPrompt(text, platform, styleGuide) {
  const guideSection = styleGuide?.trim()
    ? `\n\nStyle Guide for Social Media:\n${styleGuide}\n\n---\n\n`
    : '';

  const platformInstructions = {
    substack: 'Substack Notes: Can be longer (up to 500 chars), include context, can reference the article directly. NEVER use hashtags.',
    twitter: 'Twitter/X: Maximum 280 characters. Punchy, engaging. NEVER use hashtags - they look desperate and reduce engagement.',
    instagram: 'Instagram: Caption style, can be slightly longer, emoji-friendly, engaging hook. Minimal hashtags only if truly necessary.'
  };

  return `You are a social media manager for Persuasion, a magazine focused on defending liberal democracy.
${guideSection}
Generate 3 social media posts for ${platform} promoting this article.

Platform guidelines: ${platformInstructions[platform]}

Format your response as JSON:
{
  "suggestions": ["post 1", "post 2", "post 3"]
}

Article:
${text}`;
}

function createCopyEditPrompt(text, styleGuide, startIssueNum = 1) {
  const guideSection = styleGuide?.trim()
    ? `\n\nCopy-Editing Style Guide:\n${styleGuide}\n\n---\n\n`
    : '';

  return `You are an expert copy editor for Persuasion magazine.
${guideSection}
Review this article ONLY for prose and style issues:
- Spelling and grammar errors
- Punctuation issues
- Awkward phrasing
- Clarity problems
- Style inconsistencies
- Repetitive word choices

DO NOT flag:
- Factual claims or fact-checking issues (there's a separate fact-checker for that)
- Dates or timeline issues
- Whether statistics or claims are accurate
- "Toward" vs "towards" (both are acceptable)

For each issue you find, mark ONLY the problematic text using this exact format:
[[ISSUE: problematic text here]]

Do NOT include the fix in the marked text - just highlight what needs attention.

After the complete article, add a section starting with "---ISSUES---" followed by a numbered list of all issues in this format (start numbering at ${startIssueNum}):
${startIssueNum}. "problematic text" -> "suggested fix" (reason)
${startIssueNum + 1}. "problematic text" -> "suggested fix" (reason)

Output the COMPLETE article with issues marked, then the issues list.

Article to edit:
${text}`;
}

// Helper to split text into chunks by paragraphs
function splitIntoChunks(text, maxChunkSize = 4000) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    if (currentChunk.length + para.length + 2 > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// Process copy-edit in chunks for long articles
async function processCopyEditChunked(text, styleGuide, sendProgress) {
  const CHUNK_THRESHOLD = 5000; // Only chunk if longer than this

  if (text.length <= CHUNK_THRESHOLD) {
    // Short article - process normally
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [{ role: 'user', content: createCopyEditPrompt(text, styleGuide, 1) }]
    });
    return response.content[0].text;
  }

  // Long article - split into chunks
  const chunks = splitIntoChunks(text, 4000);
  sendProgress('copyEdit', `Processing ${chunks.length} sections...`);

  let allMarkedText = '';
  let allIssues = [];
  let issueCounter = 1;

  // Process chunks in parallel (max 3 at a time to avoid rate limits)
  const batchSize = 3;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const startNums = batch.map((_, idx) => issueCounter + idx * 10); // Estimate 10 issues per chunk max

    sendProgress('copyEdit', `Processing sections ${i + 1}-${Math.min(i + batchSize, chunks.length)} of ${chunks.length}...`);

    const batchResults = await Promise.all(
      batch.map((chunk, idx) =>
        anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          messages: [{ role: 'user', content: createCopyEditPrompt(chunk, styleGuide, startNums[idx]) }]
        }).then(r => r.content[0].text)
      )
    );

    // Merge results
    for (const result of batchResults) {
      const parts = result.split(/---ISSUES---/i);
      const markedText = parts[0].trim();
      const issuesText = parts[1] || '';

      allMarkedText += (allMarkedText ? '\n\n' : '') + markedText;

      // Extract and renumber issues
      const issueMatches = issuesText.matchAll(/\d+\.\s*(.+?)(?=\n\d+\.|$)/gs);
      for (const match of issueMatches) {
        allIssues.push(`${issueCounter}. ${match[1].trim()}`);
        issueCounter++;
      }
    }
  }

  // Combine marked text with renumbered issues list
  return allMarkedText + '\n\n---ISSUES---\n' + allIssues.join('\n');
}

// Process flag claims in chunks for long articles
async function processFlagClaimsChunked(text, sendProgress) {
  const CHUNK_THRESHOLD = 5000;

  if (text.length <= CHUNK_THRESHOLD) {
    // Short article - process normally
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [{ role: 'user', content: createFlagClaimsPrompt(text) }]
    });
    return response.content[0].text;
  }

  // Long article - split into chunks and process in parallel
  const chunks = splitIntoChunks(text, 4000);
  sendProgress('flagClaims', `Processing ${chunks.length} sections in parallel...`);

  const batchResults = await Promise.all(
    chunks.map((chunk, idx) =>
      anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [{ role: 'user', content: createFlagClaimsPrompt(chunk) }]
      }).then(r => r.content[0].text)
    )
  );

  // Merge results
  let allMarkedText = '';
  let allClaims = [];
  let claimCounter = 1;

  for (const result of batchResults) {
    const parts = result.split(/---CLAIMS---/i);
    const markedText = parts[0].trim();
    const claimsText = parts[1] || '';

    allMarkedText += (allMarkedText ? '\n\n' : '') + markedText;

    // Extract and renumber claims
    const claimMatches = claimsText.matchAll(/\d+\.\s*(.+?)(?=\n\d+\.|$)/gs);
    for (const match of claimMatches) {
      allClaims.push(`${claimCounter}. ${match[1].trim()}`);
      claimCounter++;
    }
  }

  return allMarkedText + '\n\n---CLAIMS---\n' + allClaims.join('\n');
}

function createFlagClaimsPrompt(text) {
  return `You are identifying claims that need fact-checking in an article for Persuasion magazine.

Your job is to IDENTIFY claims that should be verified before publication - NOT to verify them yourself. Be AGGRESSIVE - it's better to flag too much than too little.

Mark each claim that needs verification using:
[[CLAIM: the claim text | category | why it needs verification]]

Categories:
- STATISTIC: Numbers, percentages, data points
- QUOTE: Direct quotes or attributed statements
- HISTORICAL: Historical events, dates, facts
- SCIENTIFIC: Scientific claims, studies, research findings
- BIOGRAPHICAL: Facts about specific people
- CURRENT: Current events, recent developments, ongoing situations
- LEGAL: Claims about laws, court decisions, legal processes
- POLICY: Claims about what policies do or have done
- SENSITIVE: Potentially defamatory claims, personal allegations, claims that could lead to lawsuits - FLAG THESE LIBERALLY

FLAG AGGRESSIVELY - include:
- Strong allegations about individuals or institutions
- Claims about someone's motives or intentions
- Accusations of wrongdoing, corruption, or illegal activity
- Claims about due process violations or civil rights abuses
- Assertions about what agencies or officials have done
- Claims about impacts or consequences of policies
- Characterizations of someone's behavior (e.g., "turned X into an instrument of revenge")
- Claims that could be seen as defamatory if inaccurate
- Any claim a lawyer might flag before publication

Do NOT flag:
- Pure opinion clearly framed as opinion ("I believe...", "In my view...")
- Obvious hyperbole or rhetorical flourishes
- Questions posed by the author

IMPORTANT: When in doubt, FLAG IT. The goal is to catch everything that could cause problems if wrong.

Output the COMPLETE article with claims marked.
After the article, add "---CLAIMS---" followed by a numbered list:
1. "claim text" (CATEGORY) - What to verify
2. "claim text" (CATEGORY) - What to verify

Article to review:
${text}`;
}

function createFactCheckPrompt(text, styleGuide) {
  const guideSection = styleGuide?.trim()
    ? `\n\nFact-Checking Guidelines:\n${styleGuide}\n\n---\n\n`
    : '';

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return `You are a fact-checker for Persuasion magazine.
Today's date is ${today} (or possibly later when you process this - the article is CURRENT).
${guideSection}
Review this article and verify factual claims. Be COMPREHENSIVE - mark ALL significant claims.

For each claim:

1. If VERIFIED (you're confident it's accurate based on established facts):
   [[VERIFIED: the claim text]]

2. If QUESTIONABLE (uncertain, needs source, or partially accurate):
   [[QUESTIONABLE: the claim text | your concern or what needs verification]]

3. If INCORRECT (demonstrably wrong based on established facts):
   [[INCORRECT: the claim text | the correction with accurate information]]

4. If TIME-SENSITIVE (requires current data you don't have):
   [[CHECK_CURRENT: the claim text | what specifically needs to be verified with current sources]]

Be AGGRESSIVE - mark claims about:
- Statistics, numbers, and percentages
- Historical facts and dates
- Quotes and attributions
- Scientific and research claims
- Named events, policies, or legislation
- What officials or agencies have done
- Allegations of wrongdoing or illegal activity
- Policy impacts and consequences
- Any claim that could be defamatory if wrong

CRITICAL DATE GUIDANCE:
- Today is ${today}. The article is CURRENT - written recently.
- Do NOT flag claims as incorrect or questionable just because they mention recent events.
- Do NOT question whether recent events happened - assume the author has current knowledge.
- Do NOT flag timeline issues for events in 2025 or late 2024.
- Only use CHECK_CURRENT for claims where you genuinely cannot verify the current state.

Output the COMPLETE article with claims marked.
After the article, do not add any additional commentary.

Article to fact-check:
${text}`;
}

// Tavily web search helper
async function searchWithTavily(query) {
  const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
  if (!TAVILY_API_KEY) {
    return null;
  }

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: 'basic', // Use basic for cost efficiency
        max_results: 3
      })
    });

    if (!response.ok) {
      console.error('Tavily search failed:', response.status);
      return null;
    }

    const data = await response.json();
    return data.results || [];
  } catch (e) {
    console.error('Tavily search error:', e.message);
    return null;
  }
}

// Extract claims for fact-checking - chunked for long articles
async function extractClaimsForFactCheck(text, today, sendProgress) {
  const CHUNK_THRESHOLD = 5000;

  const extractPrompt = (articleText) => `Today's date is ${today} (or possibly later when you process this).

Extract ALL factual claims from this article that should be verified. Be AGGRESSIVE - it's better to extract too many than too few.

For each claim, provide:
1. The exact claim text (short - just the core claim)
2. A search query to verify it (be specific)

Format as JSON:
{
  "claims": [
    { "claim": "exact claim from article", "searchQuery": "specific search query" }
  ]
}

FLAG AGGRESSIVELY - include:
- Statistics, numbers, percentages
- Quotes and attributed statements
- Named policies, legislation, or executive actions
- Claims about what officials or agencies have done
- Allegations of wrongdoing, corruption, or illegal activity
- Claims about someone's motives or intentions
- Claims about due process violations or civil rights abuses
- Policy impacts and consequences
- Characterizations of someone's behavior (e.g., "turned X into an instrument of revenge")
- Claims that could be seen as defamatory if inaccurate
- Any claim a lawyer might flag before publication
- Claims about institutional actions
- Historical facts and dates
- Scientific or research claims

DO NOT extract:
- Pure opinions clearly framed as opinion ("I believe...", "In my view...")
- Obvious hyperbole or rhetorical flourishes
- Questions posed by the author

IMPORTANT: When in doubt, EXTRACT IT. Extract as many claims as the article warrants - could be 20, could be 60+.

Article:
${articleText}`;

  if (text.length <= CHUNK_THRESHOLD) {
    // Short article - single extraction
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: extractPrompt(text) }]
    });

    const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
    const data = JSON.parse(jsonMatch[0]);
    return data.claims || [];
  }

  // Long article - chunk and extract in parallel
  const chunks = splitIntoChunks(text, 4000);
  sendProgress('factCheck', `Identifying claims across ${chunks.length} sections...`);

  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: extractPrompt(chunk) }]
      });

      try {
        const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
        const data = JSON.parse(jsonMatch[0]);
        return data.claims || [];
      } catch (e) {
        return [];
      }
    })
  );

  // Merge and deduplicate claims more robustly
  const allClaims = chunkResults.flat();
  const uniqueClaims = [];
  const seenClaims = [];

  for (const claim of allClaims) {
    // Normalize: lowercase, remove extra spaces, take key words
    const normalized = claim.claim.toLowerCase()
      .replace(/[^\w\s]/g, '') // remove punctuation
      .replace(/\s+/g, ' ')    // normalize spaces
      .trim();

    // Check if we've seen a similar claim (>60% overlap in words)
    const words = normalized.split(' ').filter(w => w.length > 3);
    const isDuplicate = seenClaims.some(seen => {
      const seenWords = seen.split(' ').filter(w => w.length > 3);
      const overlap = words.filter(w => seenWords.includes(w)).length;
      const similarity = overlap / Math.max(words.length, seenWords.length);
      return similarity > 0.6;
    });

    if (!isDuplicate) {
      seenClaims.push(normalized);
      uniqueClaims.push(claim);
    }
  }

  return uniqueClaims;
}

// Process fact-checking with web search
async function processFactCheckWithWeb(text, styleGuide, sendProgress, sendConfirmRequired, confirmedClaimCount = false) {
  const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // If no Tavily key, fall back to regular fact-check
  if (!TAVILY_API_KEY) {
    sendProgress('factCheck', 'No web search API configured - using AI knowledge only...');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [{ role: 'user', content: createFactCheckPrompt(text, styleGuide) }]
    });
    return response.content[0].text;
  }

  // Step 1: Extract claims to verify (using chunked extraction for long articles)
  sendProgress('factCheck', 'Identifying claims to verify...');

  let claims = [];
  try {
    claims = await extractClaimsForFactCheck(text, today, sendProgress);
  } catch (e) {
    console.error('Failed to extract claims:', e.message);
    // Fall back to regular fact-check
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [{ role: 'user', content: createFactCheckPrompt(text, styleGuide) }]
    });
    return response.content[0].text;
  }

  if (claims.length === 0) {
    // No claims found, fall back to regular fact-check
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      messages: [{ role: 'user', content: createFactCheckPrompt(text, styleGuide) }]
    });
    return response.content[0].text;
  }

  // Step 2: Check claim count and request confirmation if needed
  const claimCount = claims.length;

  if (claimCount > 25 && !confirmedClaimCount) {
    // Request user confirmation before proceeding
    sendConfirmRequired(claimCount);
    return null; // Signal that confirmation is needed
  }

  sendProgress('factCheck', `Searching web for ${claimCount} claims...`);

  // Batch Tavily searches - run 10 at a time for speed
  const searchResults = [];
  const SEARCH_BATCH_SIZE = 10;

  for (let i = 0; i < claims.length; i += SEARCH_BATCH_SIZE) {
    const batch = claims.slice(i, i + SEARCH_BATCH_SIZE);

    sendProgress('factCheck', `Searching claims ${i + 1}-${Math.min(i + SEARCH_BATCH_SIZE, claimCount)} of ${claimCount}...`);

    const batchResults = await Promise.all(
      batch.map(async (claim) => {
        const results = await searchWithTavily(claim.searchQuery);
        return {
          claim: claim.claim,
          query: claim.searchQuery,
          results: results || []
        };
      })
    );

    searchResults.push(...batchResults);
  }

  // Step 3: Have Claude verify with search results
  // For large articles, chunk and analyze in parallel
  const ANALYSIS_CHUNK_THRESHOLD = 4000;

  if (text.length > ANALYSIS_CHUNK_THRESHOLD && searchResults.length > 10) {
    sendProgress('factCheck', `Analyzing ${searchResults.length} claims in parallel...`);

    // Split article into chunks
    const chunks = splitIntoChunks(text, 3000);
    const chunkCount = chunks.length;

    // For each chunk, find relevant search results + include some extras
    const chunkResults = await Promise.all(
      chunks.map(async (chunk, idx) => {
        // Find claims that appear in this chunk
        const chunkLower = chunk.toLowerCase();
        const relevantResults = searchResults.filter(sr => {
          const claimWords = sr.claim.toLowerCase().split(' ').filter(w => w.length > 4);
          // Check if at least 2 significant words from the claim appear in the chunk
          const matchCount = claimWords.filter(w => chunkLower.includes(w)).length;
          return matchCount >= 2 || chunkLower.includes(sr.claim.toLowerCase().substring(0, 30));
        });

        // Use relevant results, or if too few, use all (but cap at 40 to avoid huge prompts)
        let resultsToUse = relevantResults.length >= 3 ? relevantResults : searchResults;
        if (resultsToUse.length > 40) {
          resultsToUse = resultsToUse.slice(0, 40);
        }

        try {
          const chunkPrompt = createVerifyPrompt(chunk, resultsToUse, today, idx + 1, chunkCount);

          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8192,
            messages: [{ role: 'user', content: chunkPrompt }]
          });

          return response.content[0].text;
        } catch (e) {
          console.error(`Error analyzing chunk ${idx + 1}:`, e.message);
          return chunk; // Return unmarked chunk on error
        }
      })
    );

    // Merge chunk results
    return chunkResults.join('\n\n');
  }

  // For smaller articles, analyze in one go
  sendProgress('factCheck', 'Analyzing search results...');
  const verifyPrompt = createVerifyPrompt(text, searchResults, today);

  const verifyResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16384,
    messages: [{ role: 'user', content: verifyPrompt }]
  });

  return verifyResponse.content[0].text;
}

// Helper to create verification prompt
function createVerifyPrompt(text, searchResults, today, chunkNum = null, totalChunks = null) {
  const chunkNote = chunkNum ? `\n\nThis is section ${chunkNum} of ${totalChunks} of the article.` : '';

  return `You are a fact-checker for Persuasion magazine. Today's date is ${today} (or possibly later).

I've ALREADY searched the web for claims in this article. You MUST use these search results to verify claims - do not say "needs verification" if I've provided search results!

SEARCH RESULTS FROM WEB:
${searchResults.map((sr, i) => `
CLAIM ${i + 1}: "${sr.claim}"
Search query: ${sr.query}
Results:
${sr.results.length > 0
    ? sr.results.map(r => `- ${r.title}: ${r.content?.substring(0, 300) || 'No content'}... [SOURCE: ${r.url}]`).join('\n')
    : 'No results found'}
`).join('\n')}

Now review the article and mark claims using the search results above.

CRITICAL INSTRUCTIONS:
- If search results SUPPORT a claim → mark as VERIFIED with the source
- If search results CONTRADICT a claim → mark as INCORRECT with correction and source
- If search results are MIXED or UNCLEAR → mark as QUESTIONABLE with explanation and source
- ONLY use CHECK_CURRENT if NO search results were found for that specific claim

Format:
1. [[VERIFIED: claim | what confirms it | source URL]] - USE THIS when search results support the claim
2. [[QUESTIONABLE: claim | concern | source URL]] - USE THIS when results are mixed/unclear
3. [[INCORRECT: claim | correction | source URL]] - USE THIS when results contradict
4. [[CHECK_CURRENT: claim | note]] - ONLY use if we have NO search results for this claim

IMPORTANT: I searched the web for these claims. If there are search results above, USE THEM to verify. Do not mark something as CHECK_CURRENT if I provided search results for it - instead mark it VERIFIED, QUESTIONABLE, or INCORRECT based on what the results say.

For claims not in the search results above, you can still mark them based on established facts you know.
${chunkNote}
Output the article text with claims marked.

Article:
${text}`;
}

// SSE endpoint for processing
app.post('/api/process-stream', async (req, res) => {
  const { text, tasks, styleGuides = {}, factCheckConfirmed = false } = req.body;

  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'Article text is required' });
  }

  if (!tasks || Object.values(tasks).every(v => !v)) {
    return res.status(400).json({ error: 'Select at least one task' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (task, message) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', task, message })}\n\n`);
  };

  const sendResult = (task, data) => {
    res.write(`data: ${JSON.stringify({ type: 'result', task, data })}\n\n`);
  };

  const sendError = (task, error) => {
    res.write(`data: ${JSON.stringify({ type: 'error', task, error })}\n\n`);
  };

  const sendDone = () => {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  };

  const sendConfirmRequired = (claimCount) => {
    res.write(`data: ${JSON.stringify({ type: 'confirm_required', task: 'factCheck', claimCount })}\n\n`);
  };

  try {
    const promises = [];

    // Headlines
    if (tasks.headlines) {
      sendProgress('headlines', 'Generating headline suggestions...');
      promises.push(
        anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          messages: [{ role: 'user', content: createHeadlinePrompt(text, styleGuides.headlines) }]
        }).then(response => {
          try {
            const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
            const data = JSON.parse(jsonMatch[0]);
            sendResult('headlines', data.suggestions);
          } catch (e) {
            sendError('headlines', 'Failed to parse headline response');
          }
        }).catch(e => sendError('headlines', e.message))
      );
    }

    // Social Media
    if (tasks.social) {
      const platforms = ['substack', 'twitter', 'instagram'];
      for (const platform of platforms) {
        sendProgress('social', `Generating ${platform} posts...`);
        promises.push(
          anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            messages: [{ role: 'user', content: createSocialPrompt(text, platform, styleGuides.socialMedia) }]
          }).then(response => {
            try {
              const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
              const data = JSON.parse(jsonMatch[0]);
              sendResult('social', { platform, suggestions: data.suggestions });
            } catch (e) {
              sendError('social', `Failed to parse ${platform} response`);
            }
          }).catch(e => sendError('social', e.message))
        );
      }
    }

    // Copy-Edit (with chunking for long articles)
    if (tasks.copyEdit) {
      sendProgress('copyEdit', 'Analyzing article for copy-editing...');
      promises.push(
        processCopyEditChunked(text, styleGuides.copyEdit, sendProgress)
          .then(result => {
            sendResult('copyEdit', { text: result });
          })
          .catch(e => sendError('copyEdit', e.message))
      );
    }

    // Flag Claims (identify without verifying) - with chunking for long articles
    if (tasks.flagClaims) {
      sendProgress('flagClaims', 'Identifying claims to verify...');
      promises.push(
        processFlagClaimsChunked(text, sendProgress)
          .then(result => {
            sendResult('flagClaims', { text: result });
          })
          .catch(e => sendError('flagClaims', e.message))
      );
    }

    // Fact-Check (with web search)
    if (tasks.factCheck) {
      sendProgress('factCheck', 'Fact-checking article claims with web search...');
      promises.push(
        processFactCheckWithWeb(text, styleGuides.factCheck, sendProgress, sendConfirmRequired, factCheckConfirmed)
          .then(result => {
            if (result === null) {
              // Confirmation was requested - don't send result yet
              return;
            }
            if (!result || result.length === 0) {
              sendError('factCheck', 'No results returned from analysis');
              return;
            }
            console.log(`Fact-check complete: ${result.length} chars`);
            sendResult('factCheck', { text: result });
          })
          .catch(e => {
            console.error('Fact-check error:', e);
            sendError('factCheck', e.message || 'Unknown error during fact-check');
          })
      );
    }

    await Promise.all(promises);
    sendDone();
  } catch (error) {
    console.error('Processing error:', error);
    sendError('general', error.message);
    sendDone();
  }
});

// Regenerate headlines endpoint
app.post('/api/regenerate-headlines', async (req, res) => {
  const { text, styleGuide } = req.body;

  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'Article text is required' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: createHeadlinePrompt(text, styleGuide) }]
    });

    const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
    const data = JSON.parse(jsonMatch[0]);
    res.json({ suggestions: data.suggestions });
  } catch (error) {
    console.error('Regenerate error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Regenerate social media endpoint
app.post('/api/regenerate-social', async (req, res) => {
  const { text, styleGuide } = req.body;

  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'Article text is required' });
  }

  try {
    const platforms = ['substack', 'twitter', 'instagram'];
    const results = { substack: [], twitter: [], instagram: [] };

    await Promise.all(
      platforms.map(async (platform) => {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          messages: [{ role: 'user', content: createSocialPrompt(text, platform, styleGuide) }]
        });
        const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
        const data = JSON.parse(jsonMatch[0]);
        results[platform] = data.suggestions;
      })
    );

    res.json({ suggestions: results });
  } catch (error) {
    console.error('Regenerate social error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Editorial Assistant running at http://localhost:${PORT}`);
});
