const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// Configuration
const OUTPUT_FILE_YM = path.join(__dirname, 'data', 'ym-articles.csv');
const OUTPUT_FILE_PERSUASION = path.join(__dirname, 'data', 'persuasion-articles.csv');
const DB_PATH = path.join(__dirname, 'data', 'articles.db');

// Parse command-line arguments
const args = process.argv.slice(2);
let MAX_PAGES = null; // null = all pages
let MAX_DAYS = null;  // null = no date limit

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pages' && args[i + 1]) {
    MAX_PAGES = parseInt(args[i + 1]);
  }
  if (args[i] === '--days' && args[i + 1]) {
    MAX_DAYS = parseInt(args[i + 1]);
  }
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Usage: node scrape-articles.js [options]

Options:
  --pages N    Only scrape first N pages (default: all)
  --days N     Only include articles from last N days (default: all)
  --help       Show this help message

Examples:
  node scrape-articles.js --pages 3        # Quick test: first 3 pages only
  node scrape-articles.js --days 90        # Last 90 days of articles
  node scrape-articles.js --pages 5 --days 30  # First 5 pages, last 30 days
  node scrape-articles.js                  # Scrape everything
`);
    process.exit(0);
  }
}

// Calculate cutoff date if MAX_DAYS is set
const CUTOFF_DATE = MAX_DAYS ? new Date(Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000) : null;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Helper function to safely click the next page button in pagination
async function clickNextPage(page, expectedNextPage, totalPages) {
  const currentPage = expectedNextPage - 1;
  const paginationTextPattern = `${currentPage} of ${totalPages}`;

  // 1. Scroll pagination into view
  try {
    const paginationText = page.locator(`text=${paginationTextPattern}`);
    await paginationText.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  } catch (e) {
    console.log(`   Could not scroll to pagination text "${paginationTextPattern}"`);
  }

  // 2. Find the next button using multiple strategies
  const dangerousWords = ['delete', 'remove', 'trash', 'archive', 'discard'];

  // Strategy A: Button with aria-label containing "next"
  let nextButton = page.locator('button[aria-label*="next" i], button[aria-label*="Next" i]').first();

  // Strategy B: Button containing ">" text that's near pagination
  if (!(await nextButton.count())) {
    nextButton = page.locator('button:has-text(">")').first();
  }

  // Strategy C: Button with chevron-right SVG icon
  if (!(await nextButton.count())) {
    nextButton = page.locator('button:has(svg[class*="chevron-right"]), button:has(svg[data-icon="chevron-right"])').first();
  }

  // Strategy D: Look for pagination container and find the third button (typical: |< < > >|)
  if (!(await nextButton.count())) {
    // Find buttons near the "X of Y" text
    const paginationContainer = page.locator(`text=${paginationTextPattern}`).locator('xpath=ancestor::*[.//button][position()=1]');
    const buttons = paginationContainer.locator('button');
    const buttonCount = await buttons.count();

    if (buttonCount >= 4) {
      // Typical layout: first-page, prev, next, last-page
      nextButton = buttons.nth(2);
    } else if (buttonCount >= 2) {
      // Simpler layout: prev, next
      nextButton = buttons.nth(1);
    }
  }

  // Check if we found a button
  if (!(await nextButton.count())) {
    console.log('   ⚠️ Could not find next page button with any strategy');
    return false;
  }

  // 3. Safety check: verify button doesn't contain dangerous words
  try {
    const buttonText = await nextButton.textContent() || '';
    const ariaLabel = await nextButton.getAttribute('aria-label') || '';
    const combinedText = (buttonText + ' ' + ariaLabel).toLowerCase();

    for (const word of dangerousWords) {
      if (combinedText.includes(word)) {
        console.log(`   ⚠️ SAFETY: Refusing to click button containing "${word}"`);
        return false;
      }
    }

    console.log(`   Clicking next button (text: "${buttonText.trim() || '>'}", aria-label: "${ariaLabel || 'none'}")`);
  } catch (e) {
    // If we can't read the text, be cautious but proceed
    console.log('   Clicking next button (could not read button text)');
  }

  // 4. Click and verify page number changed
  try {
    await nextButton.click();

    // Wait for the page number to change
    const expectedText = `${expectedNextPage} of ${totalPages}`;
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      expectedText,
      { timeout: 5000 }
    );

    console.log(`   ✓ Navigated to page ${expectedNextPage}`);
    return true;
  } catch (e) {
    console.log(`   ⚠️ Click succeeded but page didn't change to ${expectedNextPage}: ${e.message}`);
    return false;
  }
}

// Parse date string with smart handling for missing year/date
function parseDate(dateStr) {
  if (!dateStr) return '';

  const today = new Date();
  const currentYear = today.getFullYear();

  // Time only (e.g., "1:15 PM") → Use today's date
  if (/^\d{1,2}:\d{2}\s*(AM|PM)?$/i.test(dateStr.trim())) {
    return today.toISOString().split('T')[0];
  }

  // Date without year (e.g., "Jan 18") → Assume current year
  const monthDayMatch = dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})$/i);
  if (monthDayMatch) {
    const month = monthDayMatch[1];
    const day = monthDayMatch[2];
    const parsed = new Date(`${month} ${day}, ${currentYear}`);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  }

  // Full date (e.g., "January 18, 2025" or "Jan 18, 2025") → Use as-is
  const fullDateMatch = dateStr.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (fullDateMatch) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  }

  // Try generic parsing as fallback
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return dateStr;
}

// Classify article into list based on author and section
function classifyList(author, section, dateStr) {
  // Parse date for Yascha Mounk check
  let articleDate = null;
  if (dateStr) {
    articleDate = new Date(dateStr);
  }

  const julyFirst2023 = new Date('2023-07-01');

  // Author = "Yascha Mounk" AND date >= July 2023 → ym (duplicate from YM Substack)
  if (author && author.toLowerCase().includes('yascha mounk')) {
    if (articleDate && articleDate >= julyFirst2023) {
      return 'ym';
    }
    // Author = "Yascha Mounk" AND date < July 2023 → persuasion
    return 'persuasion';
  }

  // Check section for known lists
  const sectionLower = (section || '').toLowerCase();

  if (sectionLower.includes('bookstack')) {
    return 'bookstack';
  }
  if (sectionLower.includes('frankly fukuyama')) {
    return 'frankly_fukuyama';
  }
  if (sectionLower.includes('american purpose')) {
    return 'american_purpose';
  }

  // Default
  return 'persuasion';
}

// Helper function to scrape article data from the posts list page
async function scrapeArticleData(page, feedName) {
  console.log(`\n🔍 Scraping ${feedName} posts...`);

  if (!page.url().includes('/publish')) {
    console.log('   Not on posts page, skipping...');
    return [];
  }

  // Get pagination info
  const paginationInfo = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/(\d+)\s+of\s+(\d+)/);
    return match ? { current: parseInt(match[1]), total: parseInt(match[2]) } : { current: 1, total: 1 };
  });

  const totalPages = paginationInfo.total;
  const pagesToScrape = MAX_PAGES ? Math.min(MAX_PAGES, totalPages) : totalPages;

  if (MAX_PAGES && MAX_PAGES < totalPages) {
    console.log(`📄 Found ${totalPages} pages, scraping first ${pagesToScrape} (--pages ${MAX_PAGES})\n`);
  } else {
    console.log(`📄 Found ${totalPages} pages of articles\n`);
  }

  if (CUTOFF_DATE) {
    console.log(`📅 Filtering to articles from last ${MAX_DAYS} days (since ${CUTOFF_DATE.toISOString().split('T')[0]})\n`);
  }

  const allArticles = [];
  let reachedCutoff = false;

  for (let pageNum = 1; pageNum <= pagesToScrape && !reachedCutoff; pageNum++) {
    console.log(`   Scraping page ${pageNum}/${totalPages}...`);

    if (!page.url().includes('/publish')) {
      console.log('   ⚠️ Navigated away, going back...');
      await page.goBack();
      await page.waitForTimeout(2000);
    }

    await page.waitForTimeout(1000);

    // First, build a map of titles to their podcast status by checking DOM elements
    const podcastTitles = await page.evaluate(() => {
      const podcasts = new Set();
      // Find all post rows and check for audio/podcast icons
      const postRows = document.querySelectorAll('[class*="post"], [class*="draft"], tr, [role="row"]');
      postRows.forEach(row => {
        // Check for headphone/audio icons (SVG or icon elements)
        const hasAudioIcon = row.querySelector('svg[class*="headphone"], svg[class*="audio"], [class*="headphone"], [class*="audio-icon"], [class*="podcast"]');
        // Also check for any SVG that might be an audio indicator
        const svgs = row.querySelectorAll('svg');
        let hasPodcastSvg = false;
        svgs.forEach(svg => {
          const svgHtml = svg.outerHTML.toLowerCase();
          if (svgHtml.includes('headphone') || svgHtml.includes('audio') || svgHtml.includes('podcast') || svgHtml.includes('microphone')) {
            hasPodcastSvg = true;
          }
        });

        if (hasAudioIcon || hasPodcastSvg) {
          // Get the title from this row
          const titleEl = row.querySelector('a[href*="/p/"], [class*="title"], h2, h3');
          if (titleEl) {
            podcasts.add(titleEl.textContent.trim().substring(0, 50));
          }
        }
      });
      return Array.from(podcasts);
    });

    // Extract articles with enhanced field extraction
    const articles = await page.evaluate((podcastTitlePrefixes) => {
      const data = [];
      const bodyText = document.body.innerText;
      const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l);

      const skipPatterns = /^(Home|Website|Posts|Published|Scheduled|Drafts|Podcast|Chat|Subscribers|Growth|Stats|Help|Settings|Filter|Newest|Search|Create new|CONTENT|AUDIENCE|CREATOR TOOLS|Subs|Views|Opened|Payments|N\/A|Restore pages|Chromium didn't shut down|\d+\s+of\s+\d+)$/i;
      const monthHeaders = /^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4}$/i;

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        const nextLine = lines[i + 1] || '';

        if (line.length < 15) continue;
        if (/^\d+$/.test(line)) continue;
        if (skipPatterns.test(line)) continue;
        if (monthHeaders.test(line)) continue;
        if (line.includes('CONTENT') || line.includes('AUDIENCE') || line.includes('CREATOR')) continue;

        // Check for date line patterns (meta line with bullets)
        const hasBullet = nextLine.includes('•') || nextLine.includes('·') || nextLine.includes(' - ');
        const hasDatePattern = (
          /^\d{1,2}:\d{2}/.test(nextLine) ||
          /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/.test(nextLine) ||
          /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/.test(nextLine)
        );

        if (hasBullet && hasDatePattern) {
          let title = line.replace(/^[🎧🎤📻🎙️]+\s*/, '').replace(/\s*(Paid|Free|Preview)$/, '').trim();

          // Detect podcast by checking if title matches any podcast titles from DOM scan
          // or by pattern: "[Name] on [Topic]" which is typical for podcast interviews
          const isPodcastFromDom = podcastTitlePrefixes.some(prefix => title.startsWith(prefix));
          // Match patterns like "Ian Bassin on How to...", "Rebecca Goldstein on Why..."
          // Name can be 2-4 words followed by " on " and then the topic
          const isPodcastPattern = /^[A-Z][a-zA-Z'-]+\s+[A-Z][a-zA-Z'-]+(\s+[A-Z][a-zA-Z'-]+){0,2}\s+on\s+/i.test(title);
          const hasHeadphones = line.includes('🎧') || line.startsWith('🎧');
          const articleType = (isPodcastFromDom || isPodcastPattern || hasHeadphones) ? 'podcast' : 'article';

          // Capture access type from title line
          let accessType = 'free'; // default
          if (line.includes('Paid')) accessType = 'paid';
          else if (line.includes('Preview')) accessType = 'preview';

          // Parse meta line: "Jan 18 • Francis Fukuyama • Frankly Fukuyama" or "1:15 PM • Yascha Mounk • Bookstack"
          const metaParts = nextLine.split(/\s*[•·]\s*/);

          let date = '';
          let author = '';
          let section = '';

          // First part is always date
          if (metaParts[0]) {
            date = metaParts[0].trim();
          }

          // Second part is author (if present)
          if (metaParts[1]) {
            author = metaParts[1].trim();
          }

          // Third part is section/list name (if present)
          if (metaParts[2]) {
            section = metaParts[2].trim();
          }

          let subs = '0', views = '0', openRate = '0';
          let likes = '0', comments = '0';

          // Look ahead for metrics
          for (let j = i + 2; j < Math.min(i + 15, lines.length); j++) {
            const m = lines[j];
            const prevLine = j > 0 ? lines[j - 1] : '';

            // Stop if we hit another article's meta line
            if (j > i + 3 && (m.includes('•') || m.includes('·')) &&
                (/^\d{1,2}:\d{2}/.test(m) || /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(m))) {
              break;
            }

            // Open rate (e.g., "28%")
            if (/^\d{1,2}%$/.test(m)) openRate = m;

            // Views (e.g., "40.9k" or "1.2k")
            if (/^[\d.]+k$/i.test(m)) views = m;

            // Paid subs
            if (/^\d{1,3}$/.test(m) && lines[j + 1] === 'Subs') subs = m;

            // Likes - look for heart icon context or number before "likes"
            // Usually appears as a number near heart icon
            if (/^\d+$/.test(m) && (prevLine.includes('❤') || lines[j + 1]?.toLowerCase().includes('like'))) {
              likes = m;
            }

            // Comments - look for speech bubble context
            if (/^\d+$/.test(m) && (prevLine.includes('💬') || lines[j + 1]?.toLowerCase().includes('comment'))) {
              comments = m;
            }
          }

          if (title.length > 10) {
            data.push({
              title,
              date,
              author,
              section,
              article_type: articleType,
              access_type: accessType,
              views: views.replace(/,/g, ''),
              open_rate: openRate,
              new_paid_subs: subs,
              new_free_subs: '0',
              estimated_revenue: '0',
              engagement_rate: '0',
              recipients: '0',
              shares: '0',
              likes,
              comments
            });
          }
        }
      }
      return data;
    }, podcastTitles);

    // Post-process articles to parse dates and classify lists
    const processedArticles = [];
    for (const article of articles) {
      const parsedDate = parseDate(article.date);
      const listName = classifyList(article.author, article.section, parsedDate);

      // Check if article is within date range
      if (CUTOFF_DATE && parsedDate) {
        const articleDate = new Date(parsedDate);
        if (articleDate < CUTOFF_DATE) {
          console.log(`   ⏹️ Reached articles older than ${MAX_DAYS} days, stopping...`);
          reachedCutoff = true;
          break;
        }
      }

      processedArticles.push({
        ...article,
        date: parsedDate,
        list_name: listName,
        article_type: article.article_type || 'article',
        access_type: article.access_type || 'free'
      });
    }

    console.log(`   Found ${processedArticles.length} articles on page ${pageNum}`);
    allArticles.push(...processedArticles);

    if (reachedCutoff) break;

    // Navigate to next page using the safe clickNextPage helper
    if (pageNum < pagesToScrape && !reachedCutoff) {
      console.log(`   Navigating to page ${pageNum + 1}...`);

      const success = await clickNextPage(page, pageNum + 1, totalPages);

      if (!success) {
        console.log(`   ⚠️ Failed to navigate to page ${pageNum + 1}, stopping pagination`);
        break;
      }

      // Wait for new content to load
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
    }
  }

  const seen = new Set();
  const unique = allArticles.filter(a => {
    const key = a.title.toLowerCase().substring(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`   ✅ ${unique.length} unique articles`);
  return unique;
}

function saveToCSV(articles, outputFile) {
  const csvHeader = 'title,date,author,list_name,article_type,access_type,views,open_rate,new_paid_subs,new_free_subs,estimated_revenue,engagement_rate,recipients,shares,likes,comments';
  const csvRows = articles.map(a => {
    const escape = (str) => `"${(str || '').replace(/"/g, '""')}"`;
    return [
      escape(a.title),
      escape(a.date),
      escape(a.author),
      escape(a.list_name),
      escape(a.article_type || 'article'),
      escape(a.access_type || 'free'),
      a.views || '0',
      a.open_rate || '0',
      a.new_paid_subs || '0',
      a.new_free_subs || '0',
      a.estimated_revenue || '0',
      a.engagement_rate || '0',
      a.recipients || '0',
      a.shares || '0',
      a.likes || '0',
      a.comments || '0'
    ].join(',');
  });
  fs.writeFileSync(outputFile, [csvHeader, ...csvRows].join('\n'));
  console.log(`📁 Saved to: ${outputFile}`);
}

// Import articles into database
async function importToDatabase(articles, source) {
  console.log(`📥 Importing ${articles.length} articles to database (source: ${source})...`);

  const SQL = await initSqlJs();
  let db;

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create table if it doesn't exist (with new columns)
  db.run(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    published_date TEXT NOT NULL,
    source TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    open_rate REAL DEFAULT 0,
    new_paid_subs INTEGER DEFAULT 0,
    new_free_subs INTEGER DEFAULT 0,
    estimated_revenue REAL DEFAULT 0,
    engagement_rate REAL DEFAULT 0,
    recipients INTEGER DEFAULT 0,
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
  )`);

  // Add new columns if they don't exist (for existing databases)
  try { db.run(`ALTER TABLE articles ADD COLUMN list_name TEXT DEFAULT 'persuasion'`); } catch (e) { /* column exists */ }
  try { db.run(`ALTER TABLE articles ADD COLUMN likes INTEGER DEFAULT 0`); } catch (e) { /* column exists */ }
  try { db.run(`ALTER TABLE articles ADD COLUMN comments INTEGER DEFAULT 0`); } catch (e) { /* column exists */ }
  try { db.run(`ALTER TABLE articles ADD COLUMN original_source TEXT`); } catch (e) { /* column exists */ }
  try { db.run(`ALTER TABLE articles ADD COLUMN access_type TEXT DEFAULT 'free'`); } catch (e) { /* column exists */ }

  // Create indexes
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_articles_list ON articles(list_name)`); } catch (e) { /* index exists */ }
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_articles_access ON articles(access_type)`); } catch (e) { /* index exists */ }

  let imported = 0;
  let skippedYmDupes = 0;

  for (const article of articles) {
    try {
      // Determine list_name - use article's list_name if present, otherwise use source
      const listName = article.list_name || source;

      // Skip YM duplicates when importing from Persuasion
      // (YM articles post-July 2023 will be captured from YM Substack with correct stats)
      if (source === 'persuasion' && listName === 'ym') {
        skippedYmDupes++;
        continue;
      }

      // Parse views (handle "40.9k" format)
      let views = 0;
      if (article.views) {
        const viewStr = article.views.toString().toLowerCase();
        if (viewStr.includes('k')) {
          views = Math.round(parseFloat(viewStr.replace('k', '')) * 1000);
        } else {
          views = parseInt(viewStr.replace(/,/g, '')) || 0;
        }
      }

      // Parse open rate (handle "28%" format)
      let openRate = 0;
      if (article.open_rate) {
        openRate = parseFloat(article.open_rate.toString().replace('%', '')) / 100;
      }

      // Parse likes and comments
      const likes = parseInt(article.likes) || 0;
      const comments = parseInt(article.comments) || 0;

      // Track original source for aggregation tracking
      const originalSource = source;

      // Get article_type and access_type
      const articleType = article.article_type || 'article';
      const accessType = article.access_type || 'free';

      db.run(`INSERT OR REPLACE INTO articles
        (title, published_date, source, views, open_rate, new_paid_subs, new_free_subs, estimated_revenue, author, list_name, article_type, access_type, likes, comments, original_source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          article.title,
          article.date || '',
          source,
          views,
          openRate,
          parseInt(article.new_paid_subs) || 0,
          parseInt(article.new_free_subs) || 0,
          parseFloat(article.estimated_revenue) || 0,
          article.author || null,
          listName,
          articleType,
          accessType,
          likes,
          comments,
          originalSource
        ]
      );
      imported++;
    } catch (e) {
      // Skip duplicates or errors
      console.log(`   Error importing article: ${e.message}`);
    }
  }

  // Save database
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  db.close();

  console.log(`✅ Imported ${imported} articles to database`);
  if (skippedYmDupes > 0) {
    console.log(`   ℹ️  Skipped ${skippedYmDupes} YM duplicates (will be imported from YM Substack)`);
  }
}

async function scrapeSubstackArticles() {
  console.log('📰 Substack Article Scraper');
  console.log('━'.repeat(50));

  // Show current settings
  if (MAX_PAGES || MAX_DAYS) {
    console.log('⚙️  Settings:');
    if (MAX_PAGES) console.log(`   • Max pages: ${MAX_PAGES}`);
    if (MAX_DAYS) console.log(`   • Max days: ${MAX_DAYS} (since ${CUTOFF_DATE.toISOString().split('T')[0]})`);
    console.log('');
  }

  const userDataDir = path.join(__dirname, '.playwright-profile');

  // Check if profile exists (session should be saved)
  const hasProfile = fs.existsSync(userDataDir);
  if (hasProfile) {
    console.log('🚀 Using saved session...\n');
  } else {
    console.log('🔐 First run - you\'ll need to log in to Substack.\n');
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-sync',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble'
    ],
  });

  const page = await context.newPage();

  page.on('dialog', async dialog => {
    await dialog.dismiss();
  });

  console.log('📂 Opening YM published posts...\n');
  await page.goto('https://writing.yaschamounk.com/publish/posts', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Try to dismiss any restore bubble by pressing Escape or clicking elsewhere
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const needsLogin = page.url().includes('sign-in') || page.url().includes('login');

  if (needsLogin) {
    console.log('🔐 LOGIN REQUIRED - Please log in to Substack');
    console.log('Waiting up to 5 minutes...\n');

    try {
      await page.waitForURL(/\/publish/, { timeout: 300000 });
      console.log('✅ Login successful!\n');
      await page.goto('https://writing.yaschamounk.com/publish/posts', { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('❌ Login timed out.');
      await context.close();
      return;
    }
  } else {
    console.log('✅ Already logged in!\n');
  }

  // ========== PART 1: YM ==========
  console.log('═'.repeat(50));
  console.log('📰 PART 1: Yascha Mounk Substack');
  console.log('═'.repeat(50));

  await page.screenshot({ path: 'ym-debug.png', fullPage: true });
  const ymArticles = await scrapeArticleData(page, 'Yascha Mounk');

  if (ymArticles.length > 0) {
    console.log(`\n✅ Scraped ${ymArticles.length} YM articles!\n`);
    saveToCSV(ymArticles, OUTPUT_FILE_YM);
    await importToDatabase(ymArticles, 'ym');
  } else {
    console.log('\n⚠️ No YM articles found.\n');
  }

  // ========== PART 2: Persuasion ==========
  console.log('═'.repeat(50));
  console.log('📰 PART 2: Persuasion');
  console.log('═'.repeat(50));

  console.log('📂 Switching to Persuasion...');

  try {
    await page.locator('button:has-text("Yascha Mounk")').first().click();
    await page.waitForTimeout(1500);
    await page.locator('text=Persuasion').first().click();
    await page.waitForTimeout(2000);
    await page.locator('text=Posts').first().click();
    await page.waitForTimeout(2000);
    console.log('✅ Switched to Persuasion!\n');
  } catch (e) {
    console.log('   Could not switch via dropdown, trying direct URL...');
    await page.goto('https://www.persuasion.community/publish/posts', { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: 'persuasion-debug.png', fullPage: true });

  if (page.url().includes('/publish')) {
    const persuasionArticles = await scrapeArticleData(page, 'Persuasion');
    if (persuasionArticles.length > 0) {
      console.log(`\n✅ Scraped ${persuasionArticles.length} Persuasion articles!\n`);
      saveToCSV(persuasionArticles, OUTPUT_FILE_PERSUASION);
      await importToDatabase(persuasionArticles, 'persuasion');
    } else {
      console.log('\n⚠️ No Persuasion articles found.\n');
    }
  }

  console.log('═'.repeat(50));
  console.log('📊 SUMMARY - Check CSV files in:', dataDir);
  console.log('═'.repeat(50));

  console.log('\n✅ Done! Closing in 3 seconds...');
  await page.waitForTimeout(3000);
  await context.close();
}

scrapeSubstackArticles().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
