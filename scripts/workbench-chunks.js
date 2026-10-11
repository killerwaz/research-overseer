// Feeds the workbench's "Cleaning" page: pulls a fixed sample of saved pages,
// runs shared/chunk.js on them and writes workbench/data/chunks.json.
// Run: npm run workbench:chunks   (read-only against the database)
// The sample is stable (ordered by md5 of the id), so reruns compare like with
// like while the cleaning rules are tuned.
const fs = require('fs');
const path = require('path');
const { classifyLines, chunkDoc } = require('../shared/chunk.js');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const SQL_URL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;

const SAMPLE = { firecrawl: 8, crawl4ai: 8, media: 4 };

async function sql(query) {
  const r = await fetch(SQL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }) });
  if (!r.ok) throw new Error('SQL runner HTTP ' + r.status);
  return r.json();
}

async function main() {
  const parts = Object.entries(SAMPLE).map(([s, n]) =>
    "(select id, scraper, title, canonical_url, markdown from raw_docs where " +
    (s === 'media' ? "scraper like 'media:%'" : "scraper = '" + s + "'") +
    " order by md5(id::text) limit " + n + ")");
  const res = await sql('select json_agg(x order by x.scraper, x.id)::text as j from (' + parts.join(' union all ') + ') x');
  const docs = JSON.parse(res.j || '[]');

  const pages = docs.map((d) => {
    const lines = classifyLines(d.markdown);
    const out = chunkDoc(d);
    return {
      id: d.id, scraper: d.scraper, title: d.title, url: d.canonical_url,
      raw_chars: (d.markdown || '').length, cleaned_chars: out.cleaned_chars,
      lines, chunks: out.chunks.map((c) => ({ n: c.n, start_s: c.start_s, chars: c.text.length, text: c.text }))
    };
  });

  const file = path.join(ROOT, 'workbench', 'data', 'chunks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), pages }));
  const raw = pages.reduce((a, p) => a + p.raw_chars, 0), kept = pages.reduce((a, p) => a + p.cleaned_chars, 0);
  console.log(pages.length + ' pages, ' + raw + ' -> ' + kept + ' chars (' + Math.round(100 * kept / (raw || 1)) + '% kept), ' +
    pages.reduce((a, p) => a + p.chunks.length, 0) + ' passages -> ' + path.relative(ROOT, file));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
