// Embeds every feed item that has no embedding yet (or all of them, with --all).
// Run: node scripts/backfill-embeddings.js [--all]
// Needs LM Studio up; nomic loads on demand. Goes through the ZZ SQL runner,
// which returns only the first row, hence the json_agg.
const fs = require('fs');
const path = require('path');
const { EMBED_MODEL, docText, vectorLiteral } = require('../shared/embed.js');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const LM = 'http://localhost:1234/v1/embeddings';
const BATCH = 16;

async function sql(query) {
  const r = await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.message || j.code) throw new Error('sql failed: ' + JSON.stringify(j));
  return j;
}

async function embed(texts) {
  const r = await fetch(LM, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }) });
  const j = await r.json();
  if (!j.data) throw new Error('embed failed: ' + JSON.stringify(j).slice(0, 300));
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

(async () => {
  const where = process.argv.includes('--all') ? '' : 'where embedding is null';
  const res = await sql(`select coalesce(json_agg(json_build_object('id', id, 'title', title, 'summary', summary, 'angle', angle, 'tags', tags) order by id), '[]')::text as r from feed_items ${where}`);
  const items = JSON.parse(res.r);
  console.log(items.length, 'items to embed');
  let done = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const vecs = await embed(chunk.map(docText));
    // One UPDATE per batch: ids are integers from our own DB, vectors are
    // validated numeric by vectorLiteral, so nothing user-supplied is spliced.
    const values = chunk.map((it, k) => `(${Number(it.id)}, '${vectorLiteral(vecs[k])}'::vector)`).join(',');
    await sql(`update feed_items f set embedding = v.e from (values ${values}) as v(id, e) where f.id = v.id`);
    done += chunk.length;
    process.stdout.write(`\r${done}/${items.length}`);
  }
  const check = await sql("select count(*) filter (where embedding is null) || ' missing of ' || count(*) as r from feed_items");
  console.log('\n' + check.r);
})().catch((e) => { console.error(e.message); process.exit(1); });
