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

      // First, try to extract from JSON preloads (works for drafts and some posts)
      const scriptTags = $('script').filter((i, el) => {
        const text = $(el).html() || '';
        return text.includes('window._preloads');
      });

      if (scriptTags.length > 0) {
        const scriptContent = $(scriptTags[0]).html();
        // Extract JSON from window._preloads = {...}
        const jsonMatch = scriptContent.match(/window\._preloads\s*=\s*JSON\.parse\(["'](.+?)["']\)/s);
        if (jsonMatch) {
          try {
            // Unescape the JSON string
            const jsonStr = jsonMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            const preloads = JSON.parse(jsonStr);

            // Look for post data in various locations
            const post = preloads.post || (preloads.posts && preloads.posts[0]);
            if (post && post.body_html) {
              title = post.title || '';
              // Parse HTML content
              const $body = cheerio.load(post.body_html);
              content = $body('p, h1, h2, h3, h4, blockquote, li').map((i, el) => {
                return $body(el).text().trim();
              }).get().join('\n\n');
            }
          } catch (e) {
            console.log('JSON parse failed, falling back to HTML extraction');
          }
        }
      }

      // Fall back to HTML selectors if JSON extraction failed
      if (!content || content.length < 100) {
        const selectors = ['.body.markup', '.post-content', '.available-content', 'article .body', '.entry-content'];

        for (const selector of selectors) {
          const element = $(selector);
          if (element.length > 0) {
            element.find('button, .subscription-widget, .captioned-image-container figcaption').remove();
            content = element.find('p, h1, h2, h3, h4, blockquote, li').map((i, el) => {
              return $(el).text().trim();
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
Generate 3 compelling headline and dek (subheadline) pairs for this article. Each pair should:
- Capture the essence of the article
- Be engaging and thought-provoking
- Match Persuasion's tone: intelligent, accessible, principled

Format your response as JSON:
{
  "suggestions": [
    { "headline": "...", "dek": "..." },
    { "headline": "...", "dek": "..." },
    { "headline": "...", "dek": "..." }
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

function createCopyEditPrompt(text, styleGuide) {
  const guideSection = styleGuide?.trim()
    ? `\n\nCopy-Editing Style Guide:\n${styleGuide}\n\n---\n\n`
    : '';

  return `You are an expert copy editor for Persuasion magazine.
${guideSection}
Review this article for:
- Spelling and grammar errors
- Punctuation issues
- Awkward phrasing
- Clarity problems
- Style inconsistencies
- Factual inconsistencies within the text

For each issue you find, mark ONLY the problematic text using this exact format:
[[ISSUE: problematic text here]]

Do NOT include the fix in the marked text - just highlight what needs attention.

After the complete article, add a section starting with "---ISSUES---" followed by a numbered list of all issues in this format:
1. "problematic text" -> "suggested fix" (reason)
2. "problematic text" -> "suggested fix" (reason)

Output the COMPLETE article with issues marked, then the issues list.

Article to edit:
${text}`;
}

function createFactCheckPrompt(text, styleGuide) {
  const guideSection = styleGuide?.trim()
    ? `\n\nFact-Checking Guidelines:\n${styleGuide}\n\n---\n\n`
    : '';

  return `You are a fact-checker for Persuasion magazine.
${guideSection}
Review this article and verify factual claims. For each significant claim:

1. If VERIFIED (you're confident it's accurate based on established facts):
   [[VERIFIED: the claim text]]

2. If QUESTIONABLE (uncertain, needs source, or partially accurate):
   [[QUESTIONABLE: the claim text | your concern or what needs verification]]

3. If INCORRECT (demonstrably wrong based on established facts):
   [[INCORRECT: the claim text | the correction with accurate information]]

4. If TIME-SENSITIVE (requires current data you don't have - recent statistics, current officeholders, ongoing events, recent developments):
   [[CHECK_CURRENT: the claim text | what specifically needs to be verified with current sources]]

IMPORTANT: Your knowledge has a cutoff date. For any claims about:
- Current statistics or polls
- Who currently holds office or positions
- Recent events (within the last year)
- Ongoing situations that may have changed
- Recent legislation or policy changes
You MUST mark these as CHECK_CURRENT rather than VERIFIED, even if they match your training data.

Focus on:
- Statistics and numbers
- Historical facts
- Quotes and attributions
- Scientific claims
- Named events or policies
- Current affairs and recent developments

Output the COMPLETE article with claims marked. Not every sentence needs marking - only factual claims that can be verified.
After the article, do not add any additional commentary.

Article to fact-check:
${text}`;
}

// SSE endpoint for processing
app.post('/api/process-stream', async (req, res) => {
  const { text, tasks, styleGuides = {} } = req.body;

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

    // Copy-Edit
    if (tasks.copyEdit) {
      sendProgress('copyEdit', 'Analyzing article for copy-editing...');
      promises.push(
        anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 16384,
          messages: [{ role: 'user', content: createCopyEditPrompt(text, styleGuides.copyEdit) }]
        }).then(response => {
          sendResult('copyEdit', { text: response.content[0].text });
        }).catch(e => sendError('copyEdit', e.message))
      );
    }

    // Fact-Check
    if (tasks.factCheck) {
      sendProgress('factCheck', 'Fact-checking article claims...');
      promises.push(
        anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 16384,
          messages: [{ role: 'user', content: createFactCheckPrompt(text, styleGuides.factCheck) }]
        }).then(response => {
          sendResult('factCheck', { text: response.content[0].text });
        }).catch(e => sendError('factCheck', e.message))
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

app.listen(PORT, () => {
  console.log(`Editorial Assistant running at http://localhost:${PORT}`);
});
