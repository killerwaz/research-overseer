// Step 6 of #12: does passage search find answers that summary search misses?
// Run: node scripts/eval-passages.js              runs the eval
//      node scripts/eval-passages.js --questions  only publishes the questions for review
// Reads eval/passage-eval.json (local only); writes workbench/data/eval.json
// (the workbench's Eval page). Read-only against the database.
//
// For each question: the top passages by meaning (doc_chunks) and the top
// feed items by meaning (feed_items.embedding, what WF-31 searches today).
// Pass = the expected article is in the top 3. Absent questions report their
// best passage score, which sets the "nothing found" cutoff.
const fs = require('fs');
const path = require('path');
const { EMBED_MODEL, vectorLiteral } = require('../shared/embed.js');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const OUT = path.join(ROOT, 'workbench', 'data', 'eval.json');
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'passage-eval.json'), 'utf8'));
const TOP = 3;
// Passages answer questions; feed items are about topics (shared/embed.js).
const PASSAGE_INSTRUCT = 'Given a question, retrieve passages from news articles, reports and video transcripts that answer it';
const ITEM_INSTRUCT = 'Given a topic, retrieve news articles and reports about that topic';
const q = (instruct, text) => 'Instruct: ' + instruct + '\nQuery: ' + text;

async function sql(query) {
  const r = await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.message || j.code) throw new Error('sql failed: ' + JSON.stringify(j).slice(0, 300));
  return j;
}
async function embed(texts) {
  const r = await fetch('http://localhost:1234/v1/embeddings', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }) });
  const j = await r.json();
  if (!j.data) throw new Error('embed failed: ' + JSON.stringify(j).slice(0, 300));
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const passagesSql = (v) => "select coalesce(json_agg(x order by x.sim desc), '[]')::text as j from (select c.raw_doc_id as doc, c.n, c.start_s, " +
  "round((1 - (c.embedding <=> '" + v + "'::vector))::numeric, 3) as sim, left(c.text, 400) as text, d.title from doc_chunks c " +
  "join raw_docs d on d.id = c.raw_doc_id where c.embedding is not null order by c.embedding <=> '" + v + "'::vector limit 5) x";
const itemsSql = (v) => "select coalesce(json_agg(x order by x.sim desc), '[]')::text as j from (select f.raw_doc_id as doc, " +
  "round((1 - (f.embedding <=> '" + v + "'::vector))::numeric, 3) as sim, f.title, left(f.summary, 300) as text from feed_items f " +
  "where f.embedding is not null order by f.embedding <=> '" + v + "'::vector limit 5) x";

(async () => {
  const out = { generated_at: new Date().toISOString(), status: 'questions only, not run yet', top: TOP,
    questions: SET.questions.map((x) => ({ ...x })), absent: SET.absent.map((x) => ({ ...x })) };
  if (!process.argv.includes('--questions')) {
    const all = [...out.questions, ...out.absent];
    const pv = await embed(all.map((x) => q(PASSAGE_INSTRUCT, x.q)));
    const iv = await embed(all.map((x) => q(ITEM_INSTRUCT, x.q)));
    for (let i = 0; i < all.length; i++) {
      const x = all[i];
      x.passages = JSON.parse((await sql(passagesSql(vectorLiteral(pv[i])))).j);
      x.items = JSON.parse((await sql(itemsSql(vectorLiteral(iv[i])))).j);
      if (x.doc) {
        const rank = (list) => { const k = [...new Set(list.map((r) => r.doc))].indexOf(x.doc); return k < 0 ? null : k + 1; };
        x.passage_rank = rank(x.passages);
        x.item_rank = rank(x.items);
      }
    }
    const hit = (r) => r != null && r <= TOP;
    const found = out.questions.filter((x) => x.passage_rank);
    out.summary = {
      passage_hits: out.questions.filter((x) => hit(x.passage_rank)).length,
      item_hits: out.questions.filter((x) => hit(x.item_rank)).length,
      total: out.questions.length,
      lowest_hit_sim: Math.min(...found.map((x) => x.passages.find((p) => p.doc === x.doc).sim)),
      highest_absent_sim: Math.max(...out.absent.map((x) => (x.passages[0] || { sim: 0 }).sim))
    };
    out.status = 'run';
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  if (out.summary) {
    for (const x of out.questions) console.log(String(x.id).padStart(3), 'passages:', x.passage_rank || '-', ' summaries:', x.item_rank || '-', ' ', x.q);
    for (const x of out.absent) console.log(String(x.id).padStart(3), 'absent, best passage', x.passages[0] && x.passages[0].sim, ' ', x.q);
    console.log(JSON.stringify(out.summary));
  } else console.log('questions published to the workbench Eval page');
})().catch((e) => { console.error(e.message); process.exit(1); });
