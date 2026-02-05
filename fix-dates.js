const fs = require('fs');
const initSqlJs = require('sql.js');

function parseDate(dateStr) {
  if (!dateStr) return null;
  const str = dateStr.trim();

  // Already ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // Full format: 'January 29, 2025' or 'November 29, 2025'
  const fullMatch = str.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (fullMatch) {
    const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
                     july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
    const month = months[fullMatch[1].toLowerCase()];
    const day = fullMatch[2].padStart(2, '0');
    return fullMatch[3] + '-' + month + '-' + day;
  }

  return null;
}

(async () => {
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync('./data/articles.db');
  const db = new SQL.Database(buffer);

  // Find all non-ISO dates
  const nonIso = db.exec("SELECT id, published_date FROM articles WHERE published_date NOT LIKE '____-__-__'");
  console.log('Found', nonIso[0]?.values?.length || 0, 'non-ISO dates');

  let fixed = 0;
  if (nonIso.length && nonIso[0].values) {
    for (const [id, date] of nonIso[0].values) {
      const isoDate = parseDate(date);
      if (isoDate) {
        db.run('UPDATE articles SET published_date = ? WHERE id = ?', [isoDate, id]);
        fixed++;
      } else {
        console.log('Could not parse:', date);
      }
    }
  }

  console.log('Fixed', fixed, 'dates');

  // Save
  const data = db.export();
  fs.writeFileSync('./data/articles.db', Buffer.from(data));
  db.close();

  // Verify
  const SQL2 = await initSqlJs();
  const db2 = new SQL2.Database(fs.readFileSync('./data/articles.db'));
  const check = db2.exec('SELECT published_date FROM articles ORDER BY published_date DESC LIMIT 10');
  console.log('\nLatest dates after fix:');
  check[0].values.forEach(r => console.log('  ' + r[0]));
})();
