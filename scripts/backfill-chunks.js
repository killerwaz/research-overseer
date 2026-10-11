// Cuts and embeds every saved page that has no passages yet (sql/014).
// Run: node scripts/backfill-chunks.js            dry run: counts only, writes nothing
//      node scripts/backfill-chunks.js --apply    does it
// Resumable: a page that already has passages is skipped, so it can be
// stopped and rerun. Pages that clean to nothing are counted, not stored.
// Progress goes to workbench/data/backfill.json (the workbench's Backfill page).
// Needs LM Studio with the embedding model. SQL goes through the ZZ runner,
// which returns only the first row, hence the json_agg.
const fs = require('fs');
const path = require('path');
const { chunkDoc, passageText, chunkStoreSql } = require('../shared/chunk.js');
const { EMBED_MODEL, vectorLiteral } = require('../shared/embed.js');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const LM = 'http://localhost:1234/v1/embeddings';
const APPLY = process.argv.includes('--apply');
const DOCS_PER_FETCH = 25;
const EMBED_BATCH = 32;
const PROGRESS = path.join(ROOT, 'workbench', 'data', 'backfill.json');

async function sql(query) {
  const r = await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const j = await r.json();
  if (j.message || j.code) throw new Error('sql failed: ' + JSON.stringify(j).slice(0, 300));
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

const p = { mode: APPLY ? 'apply' : 'dry run', started_at: new Date().toISOString(), docs_total: 0, docs_done: 0,
  passages: 0, empty: 0, failed: 0, failures: [], recent: [], eta_s: null, finished: false };
function save() {
  p.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(PROGRESS), { recursive: true });
  fs.writeFileSync(PROGRESS, JSON.stringify(p));
}

(async () => {
  const ids = JSON.parse((await sql('select coalesce(json_agg(d.id order by d.id), \'[]\')::text as j from raw_docs d ' +
    'where not exists (select 1 from doc_chunks c where c.raw_doc_id = d.id)')).j);
  p.docs_total = ids.length;
  console.log(p.mode + ': ' + ids.length + ' pages without passages');
  save();
  const t0 = Date.now();
  for (let i = 0; i < ids.length; i += DOCS_PER_FETCH) {
    const batch = ids.slice(i, i + DOCS_PER_FETCH);
    const docs = JSON.parse((await sql('select json_agg(x order by x.id)::text as j from (select id, scraper, title, markdown ' +
      'from raw_docs where id in (' + batch.join(',') + ')) x')).j || '[]');
    for (const d of docs) {
      const out = chunkDoc(d);
      const label = '#' + d.id + ' ' + String(d.title || '').replace(/\s+/g, ' ').slice(0, 80);
      try {
        if (!out.chunks.length) { p.empty++; }
        else if (APPLY) {
          const vecs = [];
          for (let k = 0; k < out.chunks.length; k += EMBED_BATCH) {
            vecs.push(...await embed(out.chunks.slice(k, k + EMBED_BATCH).map((c) => passageText(d.title, c.text))));
          }
          await sql(chunkStoreSql(d.id, out.chunks, vecs, vectorLiteral));
        }
        p.passages += out.chunks.length;
        p.recent.unshift({ doc: label, passages: out.chunks.length });
      } catch (e) {
        p.failed++;
        p.failures.push({ doc: label, error: e.message.slice(0, 200) });
      }
      p.recent = p.recent.slice(0, 12);
      p.docs_done++;
      const per = (Date.now() - t0) / p.docs_done;
      p.eta_s = Math.round(per * (p.docs_total - p.docs_done) / 1000);
      save();
      if (p.docs_done % 25 === 0 || p.docs_done === p.docs_total) console.log(p.docs_done + '/' + p.docs_total + ' pages, ' + p.passages + ' passages, ' + p.failed + ' failed');
    }
  }
  p.finished = true;
  p.elapsed_s = Math.round((Date.now() - t0) / 1000);
  if (APPLY) p.check = (await sql('select count(*) || \' passages on \' || count(distinct raw_doc_id) || \' pages, \' || ' +
    'count(*) filter (where embedding is null) || \' without embedding\' as r from doc_chunks')).r;
  save();
  console.log('\n' + (p.check || 'dry run: nothing written') + ' (' + p.elapsed_s + ' s, ' + p.empty + ' empty pages, ' + p.failed + ' failed)');
})().catch((e) => { p.error = e.message; save(); console.error(e.message); process.exit(1); });
