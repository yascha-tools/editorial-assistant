const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'data', 'articles.db');
const YM_CSV = path.join(__dirname, 'data', 'ym-articles.csv');
const PERSUASION_CSV = path.join(__dirname, 'data', 'persuasion-articles.csv');

function parseCSV(csvPath, source) {
  if (!fs.existsSync(csvPath)) {
    console.log('CSV not found:', csvPath);
    return [];
  }

  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').slice(1); // Skip header

  return lines.filter(l => l.trim()).map(line => {
    const matches = line.match(/"([^"]*)"|([^,]+)/g) || [];
    const fields = matches.map(f => f.replace(/^"|"$/g, ''));

    return {
      title: fields[0] || '',
      date: fields[1] || '',
      views: fields[2] || '0',
      open_rate: fields[3] || '0',
      new_paid_subs: fields[4] || '0',
      source
    };
  });
}

async function main() {
  const SQL = await initSqlJs();
  let db;

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

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
    article_type TEXT DEFAULT 'essay',
    author TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(title, published_date, source)
  )`);

  const ymArticles = parseCSV(YM_CSV, 'ym');
  const persuasionArticles = parseCSV(PERSUASION_CSV, 'persuasion');

  console.log(`Found ${ymArticles.length} YM articles, ${persuasionArticles.length} Persuasion articles`);

  let imported = 0;
  for (const article of [...ymArticles, ...persuasionArticles]) {
    try {
      let views = 0;
      if (article.views) {
        const viewStr = article.views.toString().toLowerCase();
        if (viewStr.includes('k')) {
          views = Math.round(parseFloat(viewStr.replace('k', '')) * 1000);
        } else {
          views = parseInt(viewStr.replace(/,/g, '')) || 0;
        }
      }

      let openRate = 0;
      if (article.open_rate) {
        openRate = parseFloat(article.open_rate.toString().replace('%', '')) / 100;
      }

      db.run(`INSERT OR REPLACE INTO articles
        (title, published_date, source, views, open_rate, new_paid_subs, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [article.title, article.date, article.source, views, openRate, parseInt(article.new_paid_subs) || 0]
      );
      imported++;
    } catch (e) {
      console.log('Error importing:', article.title, e.message);
    }
  }

  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  db.close();

  console.log(`✅ Imported ${imported} articles to database`);
}

main().catch(console.error);
