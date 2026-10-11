// Does passage search find answers that summary search misses?
// Run: node scripts/eval-passages.js              runs the eval + a cutoff sweep
//      node scripts/eval-passages.js --questions  only publishes the questions for review
// Reads eval/passage-eval.json (local only); writes workbench/data/eval.json
// (the workbench's Eval page). Read-only against the database.
//
// Every question runs twice: as asked (q) and as the router would plausibly
// pass it (tag). Passage search runs the shipping SQL (shared/passage-search.js
// passageCtes) with its cutoffs off, then the cutoffs are applied here, so one
// pass of queries can sweep them. Summary search = feed_items.embedding, what
// WF-31 matched on before passages.
// Pass = the expected page (or an accepted alternate) is in the top 3 hits.
// Absent topics pass when nothing clears the cutoffs.
const fs = require('fs');
const path = require('path');
const { EMBED_MODEL, vectorLiteral } = require('../shared/embed.js');
const { PASSAGE_SIM, KW_COVER, KW_WEIGHT, passageCtes } = require('../shared/passage-search.js');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const OUT = path.join(ROOT, 'workbench', 'data', 'eval.json');
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'passage-eval.json'), 'utf8'));
const TOP = 3;
const ITEM_INSTRUCT = 'Given a topic, retrieve news articles and reports about that topic';
const { queryText } = require('../shared/embed.js');
const b64 = (s) => "convert_from(decode('" + Buffer.from(String(s), 'utf8').toString('base64') + "', 'base64'), 'UTF8')";

async function sql(query) {
  const r = await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60000) });
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

// All candidate pages for one query, best passage each, cutoffs off.
const passagesSql = (text, v) => 'with t as (select 1 as ord, ' + b64(text) + " as kw, '" + v + "'::vector(1024) as qv), " +
  passageCtes({ sim: -1, cover: 0 }) +
  " select coalesce(json_agg(x), '[]')::text as j from (select p.raw_doc_id as doc, p.n, p.start_s, round(p.sim::numeric, 3) as sim, " +
  'round(p.cover::numeric, 3) as cover, left(p.text, 300) as text, d.title from pdoc p join raw_docs d on d.id = p.raw_doc_id ' +
  'order by p.pscore desc limit 80) x';
const itemsSql = (v) => "select coalesce(json_agg(x order by x.sim desc), '[]')::text as j from (select f.raw_doc_id as doc, " +
  "round((1 - (f.embedding <=> '" + v + "'::vector))::numeric, 3) as sim, f.title, left(f.summary, 300) as text from feed_items f " +
  "where f.embedding is not null order by f.embedding <=> '" + v + "'::vector limit 5) x";

function hits(cands, c) {
  return cands.filter((p) => p.sim >= c.sim || p.cover >= c.cover)
    .map((p) => ({ ...p, pscore: p.sim + c.weight * p.cover })).sort((a, b) => b.pscore - a.pscore);
}
const wanted = (x) => [x.doc, ...(x.also || [])];
function rankOf(list, x) {
  const docs = [...new Set(list.map((r) => r.doc))];
  const k = docs.findIndex((d) => wanted(x).includes(d));
  return k < 0 ? null : k + 1;
}
function score(rows, c) {
  let found = 0, total = 0, absentOk = 0, absentN = 0;
  for (const r of rows) {
    for (const key of ['cand_q', 'cand_tag']) {
      if (!r[key]) continue;
      if (r.doc) { total++; const k = rankOf(hits(r[key], c), r); if (k && k <= TOP) found++; }
      else if (!r.near) { absentN++; if (!hits(r[key], c).length) absentOk++; }
    }
  }
  return { found, total, absentOk, absentN };
}

(async () => {
  const out = { generated_at: new Date().toISOString(), status: 'questions only, not run yet', top: TOP,
    questions: SET.questions.map((x) => ({ ...x })), absent: SET.absent.map((x) => ({ ...x })) };
  if (!process.argv.includes('--questions')) {
    const all = [...out.questions, ...out.absent];
    const texts = all.flatMap((x) => [x.q, x.tag || x.q]);
    const pv = await embed(texts.map(queryText));
    const iv = await embed(all.map((x) => 'Instruct: ' + ITEM_INSTRUCT + '\nQuery: ' + x.q));
    for (let i = 0; i < all.length; i++) {
      const x = all[i];
      x.cand_q = JSON.parse((await sql(passagesSql(x.q, vectorLiteral(pv[2 * i])))).j).map((p) => ({ ...p, sim: Number(p.sim), cover: Number(p.cover) }));
      x.cand_tag = x.tag ? JSON.parse((await sql(passagesSql(x.tag, vectorLiteral(pv[2 * i + 1])))).j).map((p) => ({ ...p, sim: Number(p.sim), cover: Number(p.cover) })) : null;
      x.items = JSON.parse((await sql(itemsSql(vectorLiteral(iv[i])))).j);
      process.stdout.write('.');
    }
    console.log();
    // Sweep.
    const grid = [];
    for (const sim of [0.45, 0.48, 0.50, 0.52, 0.55]) for (const cover of [0.6, 0.7, 0.75, 0.8, 0.9, 1.01])
      for (const weight of [0, 0.15, 0.3, 0.5]) grid.push({ sim, cover, weight, ...score(all, { sim, cover, weight }) });
    grid.sort((a, b) => (b.found + b.absentOk) - (a.found + a.absentOk) || b.absentOk - a.absentOk);
    console.log('best settings (found = questions in top 3, q + tag runs; absent = topics with no hit):');
    for (const g of (process.env.GRID_ALL ? grid.filter((g) => g.weight === 0.3) : grid.slice(0, 8))) console.log('  sim', g.sim, 'cover', g.cover, 'weight', g.weight, ' found', g.found + '/' + g.total, ' absent', g.absentOk + '/' + g.absentN);
    const shipped = { sim: PASSAGE_SIM, cover: KW_COVER, weight: KW_WEIGHT };
    const s = score(all, shipped);
    console.log('shipped', JSON.stringify(shipped), 'found', s.found + '/' + s.total, 'absent', s.absentOk + '/' + s.absentN);
    for (const x of all) {
      x.passages = hits(x.cand_q, shipped).slice(0, 5);
      x.passages_tag = x.cand_tag ? hits(x.cand_tag, shipped).slice(0, 5) : [];
      if (x.doc) { x.passage_rank = rankOf(x.passages, x); x.tag_rank = rankOf(x.passages_tag, x); x.item_rank = rankOf(x.items, x); }
      delete x.cand_q; delete x.cand_tag;
    }
    for (const x of out.questions) console.log(String(x.id).padStart(3), 'asked:', x.passage_rank || '-', ' tag:', x.tag_rank || '-', ' summaries:', x.item_rank || '-', ' ', x.q);
    for (const x of out.absent) console.log(String(x.id).padStart(3), x.near ? 'near  ' : 'absent', 'hits asked/tag:', x.passages.length + '/' + x.passages_tag.length,
      x.passages[0] ? '(top ' + x.passages[0].sim + '/' + x.passages[0].cover + ' #' + x.passages[0].doc + ')' : '', ' ', x.q);
    out.summary = { passage_hits: out.questions.filter((x) => x.passage_rank && x.passage_rank <= TOP).length,
      tag_hits: out.questions.filter((x) => x.tag_rank && x.tag_rank <= TOP).length,
      item_hits: out.questions.filter((x) => x.item_rank && x.item_rank <= TOP).length, total: out.questions.length,
      absent_clean: out.absent.filter((x) => !x.near && !x.passages.length).length, absent_total: out.absent.filter((x) => !x.near).length };
    out.status = 'run';
    console.log(JSON.stringify(out.summary));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  if (!out.summary) console.log('questions published to the workbench Eval page');
})().catch((e) => { console.error(e.message); process.exit(1); });
