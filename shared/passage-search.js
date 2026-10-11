// Passage search over doc_chunks (#12): meaning + keywords, fused.
//
// Meaning (embedding similarity) finds paraphrases but blurs exact names;
// keywords find names but not paraphrases. Each passage gets both:
//   sim   = cosine similarity to the topic's query vector
//   cover = share of the topic's keyword weight the passage contains. Each
//           word is weighted by how rare it is across all passages (idf), so
//           "Langfuse" counts for far more than "money".
// A passage is a hit when sim >= PASSAGE_SIM or cover >= KW_COVER, and hits
// rank by sim + KW_WEIGHT * cover. Text that appears on 3+ pages (promo
// blocks) is skipped.
//
// Tried and dropped 2026-10-12: query expansion (the 9B adding synonyms)
// fixed "who bought Langfuse" but scored 23/26 vs 25/26 and let one absent
// topic through; its words were generic and once invented names.
//
// The SQL is one CTE chain over a table t(ord, kw, qv) — one row per
// topic — so WF-31 and scripts/eval-passages.js run the exact same query.
// Output CTE: pdoc(ord, raw_doc_id, n, start_s, sim, cover, pscore, text) —
// the best hit passage per (topic, page).

// Tuned 2026-10-12 with scripts/eval-passages.js (26 runs = 13 questions as
// asked + as the router would phrase them; 4 absent topics):
//   sim 0.50-0.55, cover 0.75 -> 25/26 found, 4/4 absent clean
//   cover 0.60 -> one absent leaks; cover 0.80+ -> 24/26; keyword off -> 21/26
// 0.55, not 0.50: on the 39-case scripts/eval-search.js, "crypto regulation in
// Brazil" reached an AI-regulation passage at 0.515. Re-tune there, not by feel.
const PASSAGE_SIM = 0.55;
const KW_COVER = 0.75;
const KW_WEIGHT = 0.3;
const POOL = 40;            // nearest passages considered per topic, by meaning
const BOILER_PAGES = 3;     // same text on this many pages = boilerplate
function passageCtes(o) {
  const opt = Object.assign({ sim: PASSAGE_SIM, cover: KW_COVER, weight: KW_WEIGHT, pool: POOL }, o || {});
  const num = (x, name) => { const v = Number(x); if (!Number.isFinite(v)) throw new Error('bad ' + name); return v; };
  const sim = num(opt.sim, 'sim'), cover = num(opt.cover, 'cover'), weight = num(opt.weight, 'weight');
  const pool = Math.max(1, Math.round(num(opt.pool, 'pool')));
  return `
boiler as (select text_md5 from doc_chunks group by text_md5 having count(distinct raw_doc_id) >= ${BOILER_PAGES}),
nchunks as (select greatest(count(*), 1)::float8 as n from doc_chunks),
pv as (
  select t.ord, x.raw_doc_id, x.n, x.sim from t cross join lateral (
    select c.raw_doc_id, c.n, 1 - (c.embedding <=> t.qv) as sim from doc_chunks c
    where t.qv is not null and c.embedding is not null and c.text_md5 not in (select text_md5 from boiler)
    order by c.embedding <=> t.qv limit ${pool}) x
),
ql0 as (
  select distinct t.ord, l.lex
  from t cross join lateral unnest(tsvector_to_array(to_tsvector('english', coalesce(t.kw, '')))) as l(lex)
  where l.lex <> 'ai' and length(l.lex) > 1
),
ql as (
  select ql0.*, ln((select n from nchunks) / (1 + (select count(*) from doc_chunks c
    where c.tsv @@ quote_literal(ql0.lex)::tsquery))) as idf
  from ql0
),
qt as (select ord, sum(greatest(idf, 0)) as total from ql group by ord),
pk as (
  select ql.ord, c.raw_doc_id, c.n,
    sum(greatest(ql.idf, 0)) / nullif(max(qt.total), 0) as cover
  from ql join qt on qt.ord = ql.ord
  join doc_chunks c on c.tsv @@ quote_literal(ql.lex)::tsquery
  where c.text_md5 not in (select text_md5 from boiler)
  group by ql.ord, c.raw_doc_id, c.n
),
pf as (
  select ord, raw_doc_id, n, max(sim) as sim, max(cover) as cover
  from (select ord, raw_doc_id, n, sim, null::float8 as cover from pv
        union all select ord, raw_doc_id, n, null::float8, cover from pk) u
  group by ord, raw_doc_id, n
),
ph as (
  select pf.ord, pf.raw_doc_id, pf.n, pf.cover,
    coalesce(pf.sim, 1 - (c.embedding <=> t.qv)) as sim, c.start_s, c.text
  from pf join doc_chunks c on c.raw_doc_id = pf.raw_doc_id and c.n = pf.n
  join t on t.ord = pf.ord
),
pdoc0 as (
  select distinct on (ord, raw_doc_id) ord, raw_doc_id, n, start_s, sim, coalesce(cover, 0) as cover,
    coalesce(sim, 0) + ${weight} * coalesce(cover, 0) as pscore, text
  from ph
  where coalesce(sim, 0) >= ${sim} or coalesce(cover, 0) >= ${cover}
  order by ord, raw_doc_id, coalesce(sim, 0) + ${weight} * coalesce(cover, 0) desc
),
/* headline: up to 4 short fragments around the query words, so the router
   sees every place they occur. One fragment centred on a single word missed
   answers in the end-to-end test: "Langfuse acquisition" centred on
   "acquisitions" and skipped "ClickHouse acquires Langfuse". Null when the
   topic has no usable words. */
pdoc as (
  select pdoc0.*, (select ts_headline('english', pdoc0.text, string_agg(quote_literal(q.lex), ' | ')::tsquery,
      'MaxFragments=4, MaxWords=30, MinWords=12, StartSel="", StopSel="", FragmentDelimiter=" … "')
    from ql q where q.ord = pdoc0.ord) as headline
  from pdoc0
)`.trim();
}

// The few hundred characters of a passage around its best keyword, for the
// router to read: whole passages are ~2,500 chars and 20 of them would swamp
// a 9B's context. Falls back to the passage's start.
function evidenceSnippet(text, terms, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = Math.max(80, Number(max) || 500);
  if (t.length <= m) return t;
  const lower = t.toLowerCase();
  let at = -1;
  for (const w of terms || []) {
    const k = String(w || '').toLowerCase().trim();
    if (k.length < 3) continue;
    const i = lower.indexOf(k.slice(0, Math.max(3, k.length - 2)));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return t.slice(0, m).trim() + '…';
  const start = Math.max(0, at - Math.floor(m / 3));
  const end = Math.min(t.length, start + m);
  return (start > 0 ? '…' : '') + t.slice(start, end).trim() + (end < t.length ? '…' : '');
}

module.exports = { PASSAGE_SIM, KW_COVER, KW_WEIGHT, POOL, BOILER_PAGES, passageCtes, evidenceSnippet };
