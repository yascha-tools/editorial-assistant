const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'data', 'articles.db');
const YM_CSV = path.join(__dirname, 'data', 'ym-articles.csv');
const PERSUASION_CSV = path.join(__dirname, 'data', 'persuasion-articles.csv');

// Parse various date formats to ISO (YYYY-MM-DD)
// shortDateYear: which year to use for short dates like "Jan 17"
function parseDate(dateStr, shortDateYear = 2026) {
  if (!dateStr) return null;

  const str = dateStr.trim();

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Full format: "January 29, 2025" or "September 9, 2025"
  const fullMatch = str.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (fullMatch) {
    const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
                     july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
    const month = months[fullMatch[1].toLowerCase()];
    const day = fullMatch[2].padStart(2, '0');
    return fullMatch[3] + '-' + month + '-' + day;
  }

  // Short format: "Jan 17" (use provided year - 2026 for current articles)
  const shortMatch = str.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$/i);
  if (shortMatch) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
                     jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const month = months[shortMatch[1].toLowerCase()];
    const day = shortMatch[2].padStart(2, '0');
    return shortDateYear + '-' + month + '-' + day;
  }

  // Try to parse with Date
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return null;
}

// Parse CSV line handling quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// Build title->date map from CSV files
function buildDateMapFromCSVs() {
  const titleToDate = new Map();

  // Process YM CSV - short dates here are 2026
  if (fs.existsSync(YM_CSV)) {
    const ymLines = fs.readFileSync(YM_CSV, 'utf-8').split('\n').slice(1);
    for (const line of ymLines) {
      if (!line.trim()) continue;
      const fields = parseCSVLine(line);
      const title = fields[0];
      const originalDate = fields[1];
      const isoDate = parseDate(originalDate, 2026); // Short dates = 2026
      if (title && isoDate) {
        titleToDate.set(title.toLowerCase().trim(), isoDate);
      }
    }
    console.log('  Loaded ' + titleToDate.size + ' dates from YM CSV');
  }

  // Process Persuasion CSV - has explicit years, override YM if conflict
  if (fs.existsSync(PERSUASION_CSV)) {
    const pLines = fs.readFileSync(PERSUASION_CSV, 'utf-8').split('\n').slice(1);
    let count = 0;
    for (const line of pLines) {
      if (!line.trim()) continue;
      const fields = parseCSVLine(line);
      const title = fields[0];
      const originalDate = fields[1];
      const isoDate = parseDate(originalDate, 2026);
      if (title && isoDate) {
        // Persuasion dates with explicit year should override
        if (originalDate.includes('202')) {
          titleToDate.set(title.toLowerCase().trim(), isoDate);
        } else if (!titleToDate.has(title.toLowerCase().trim())) {
          titleToDate.set(title.toLowerCase().trim(), isoDate);
        }
        count++;
      }
    }
    console.log('  Processed ' + count + ' dates from Persuasion CSV');
  }

  return titleToDate;
}

async function fixArticleData() {
  console.log('🔧 Fixing article data...\n');

  // Step 1: Build date map from original CSVs
  console.log('📅 Loading dates from CSV files...');
  const titleToDate = buildDateMapFromCSVs();
  console.log('  Total unique titles: ' + titleToDate.size + '\n');

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buffer);

  // Step 2: Get all articles
  const articles = db.exec('SELECT id, title, published_date, source, views, open_rate, new_paid_subs FROM articles');
  if (!articles.length) {
    console.log('No articles found');
    return;
  }

  const rows = articles[0].values;
  console.log('📊 Found ' + rows.length + ' total articles\n');

  // Step 3: Fix dates using CSV data
  console.log('📅 Fixing dates from CSV data...');
  let datesFixed = 0;
  let notFound = 0;
  for (const row of rows) {
    const [id, title, currentDate, source, views] = row;
    const correctDate = titleToDate.get(title.toLowerCase().trim());

    if (correctDate && correctDate !== currentDate) {
      try {
        db.run('UPDATE articles SET published_date = ? WHERE id = ?', [correctDate, id]);
        datesFixed++;
      } catch (e) {
        // Ignore constraint errors
      }
    } else if (!correctDate) {
      notFound++;
    }
  }
  console.log('  Fixed: ' + datesFixed + ' dates');
  console.log('  Not in CSV: ' + notFound + ' articles\n');

  // Step 3: Find and merge duplicates
  console.log('🔄 Finding duplicates...');
  const duplicates = db.exec(`
    SELECT LOWER(title) as ltitle, COUNT(*) as cnt
    FROM articles
    GROUP BY LOWER(title)
    HAVING cnt > 1
  `);

  if (duplicates.length && duplicates[0].values.length) {
    const dupeCount = duplicates[0].values.length;
    console.log(`   Found ${dupeCount} duplicate titles\n`);

    let merged = 0;
    for (const [ltitle] of duplicates[0].values) {
      // Get all versions of this article
      const versions = db.exec(`
        SELECT id, title, source, views, open_rate, new_paid_subs, published_date
        FROM articles
        WHERE LOWER(title) = ?
        ORDER BY views DESC
      `, [ltitle]);

      if (versions.length && versions[0].values.length > 1) {
        const allVersions = versions[0].values;
        // Keep the one with most views
        const [keepId, keepTitle, keepSource, keepViews, keepOpenRate, keepSubs, keepDate] = allVersions[0];

        // Sum up stats from all versions
        let totalViews = keepViews;
        let maxOpenRate = keepOpenRate;
        let totalSubs = keepSubs || 0;
        const idsToDelete = [];

        for (let i = 1; i < allVersions.length; i++) {
          const [delId, , , delViews, delOpenRate, delSubs] = allVersions[i];
          // For duplicates where one has 0 views, only count the non-zero version
          // (0 views usually means it was incorrectly scraped)
          if (delViews > 0 && keepViews > 0) {
            // If both have real view counts, keep the higher one (don't sum - they're the same article)
            totalViews = Math.max(totalViews, delViews);
          } else if (delViews > 0) {
            totalViews = delViews;
          }
          maxOpenRate = Math.max(maxOpenRate || 0, delOpenRate || 0);
          totalSubs += delSubs || 0;
          idsToDelete.push(delId);
        }

        // Determine best source - prefer the one with more views, or 'ym' if the article is from YM
        const ymVersion = allVersions.find(v => v[2] === 'ym' && v[3] > 0);
        const bestSource = ymVersion ? 'ym' : keepSource;

        // Update the keeper with merged stats
        db.run(`
          UPDATE articles
          SET views = ?, open_rate = ?, new_paid_subs = ?, source = ?
          WHERE id = ?
        `, [totalViews, maxOpenRate, totalSubs, bestSource, keepId]);

        // Delete duplicates
        for (const delId of idsToDelete) {
          db.run('DELETE FROM articles WHERE id = ?', [delId]);
          merged++;
        }
      }
    }
    console.log(`   Merged ${merged} duplicate articles\n`);
  } else {
    console.log('   No duplicates found\n');
  }

  // Step 4: Update import metadata
  console.log('📝 Updating import metadata...');

  // Create metadata table if needed
  db.run(`CREATE TABLE IF NOT EXISTS article_import_metadata (
    source TEXT PRIMARY KEY,
    last_updated TEXT,
    records_count INTEGER DEFAULT 0
  )`);

  // Count articles by source
  const counts = db.exec(`SELECT source, COUNT(*) as count FROM articles GROUP BY source`);
  const now = new Date().toISOString();

  if (counts.length) {
    for (const [source, count] of counts[0].values) {
      db.run(`INSERT OR REPLACE INTO article_import_metadata (source, last_updated, records_count) VALUES (?, ?, ?)`,
        [source, now, count]);
      console.log(`   ${source}: ${count} articles`);
    }
  }

  // Step 5: Verify results
  console.log('\n✅ Verification:');
  const finalCount = db.exec('SELECT COUNT(*) FROM articles');
  console.log(`   Total articles: ${finalCount[0].values[0][0]}`);

  const sampleDates = db.exec('SELECT published_date FROM articles ORDER BY published_date DESC LIMIT 5');
  console.log('   Latest dates:', sampleDates[0].values.map(r => r[0]).join(', '));

  const dupeCheck = db.exec(`
    SELECT LOWER(title) as t, COUNT(*) as c FROM articles GROUP BY t HAVING c > 1 LIMIT 3
  `);
  if (dupeCheck.length && dupeCheck[0].values.length) {
    console.log('   ⚠️ Some duplicates remain:', dupeCheck[0].values.length);
  } else {
    console.log('   No duplicates remaining');
  }

  // Save
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  db.close();

  console.log('\n✅ Database updated successfully!');
  console.log('   Restart the server to see changes in the dashboard.');
}

fixArticleData().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
