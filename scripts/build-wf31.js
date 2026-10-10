// Builds workflows/wf31-query-feed.json — the router's read path.
// Run: node scripts/build-wf31.js
//
// Two modes, picked by the inputs:
//  - LIST (default): filter the feed by time/quality and, optionally, up to 3
//    topics. A topic matches an item by keyword overlap (the original rule) OR
//    by embedding similarity >= SIM_CUTOFF. Each topic gets a fair share of the
//    limit, so "compare X and Y" cannot come back as twenty X items. Results are
//    numbered n = 1, 2, 3... and the ids stored per chat in chat_results.
//  - ITEM (item = "3"): return item n of that chat's last list, with an excerpt
//    of the saved page. No new search — that was the follow-up failure mode.
//
// If embedding fails (LM Studio down), topics fall back to keyword-only and
// the result says so; the read never fails because of it.
const fs = require('fs');
const path = require('path');

const I = require('./instance.json');
const CRED_PG = I.credentials.postgres;
const CRED_LM = I.credentials.lmstudio;

const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
  .replace(/module\.exports[\s\S]*$/, '');
const { SIM_CUTOFF: DEFAULT_CUTOFF } = require('../shared/feed-search.js');
// Tuning hook for scripts/eval-search.js sweeps; the shipped value is the shared constant.
const SIM_CUTOFF = Number(process.env.SIM_CUTOFF || DEFAULT_CUTOFF);
// A keyword hit outranks a meaning-only match of similar strength: exact words
// are the stronger evidence (names, acronyms), but meaning still orders them.
const KW_BOOST = 0.15;
const { EMBED_DIM } = require('../shared/embed.js');

const PREP = inline('embed.js') + inline('feed-search.js') + `
// Every input leaves as a string: queryReplacement inlines numbers UNQUOTED, and
// nullif(-75, '') then makes Postgres cast '' to integer and fail. The router
// passes chat_id as a number, so this is the live path, not an edge case.
const raw = $input.first().json;
const j = {};
for (const k of ${JSON.stringify(['since', 'min_relevance', 'tag', 'limit', 'min_score', 'max_age_days', 'group_stories', 'item', 'chat_id'])}) {
  j[k] = raw[k] == null ? '' : String(raw[k]).trim();
}
const item = parseItemRef(j.item);
const topics = item ? [] : parseTopics(j.tag);
// Always embed something so the flow stays linear; with no topics the vector is ignored.
const input = topics.length ? topics.map(queryText) : ['-'];
return [{ json: { ...j, item_n: item ? String(item) : '', topics, embed_body: JSON.stringify({ model: EMBED_MODEL, input }) } }];
`.trim();

const PARAMS = inline('feed-search.js') + `
const p = $('Prep').first().json;
let vecs = null;
try { vecs = $input.first().json.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding); } catch (e) {}
const embedded = Boolean(vecs) && p.topics.length > 0;
return [{ json: { ...p, topics_param: p.topics.join('|'), vectors_param: p.topics.length ? packVectors(vecs, p.topics.length) : '',
  semantic: p.topics.length ? (embedded ? 'on' : 'off (embedding unavailable, keyword match only)') : '' } }];
`.trim();

// Keyword rule, unchanged from the hand-written WF-31: a tag contains the
// topic, or >= 60% of the topic's (english, stemmed, "ai"-less) words appear in
// title/summary/angle/tags.
const kw = (k) => `(exists (select 1 from unnest(c.tags) tg where tg like '%' || lower(${k}) || '%')
  or (select count(*) from unnest(array_remove(tsvector_to_array(to_tsvector('english', ${k})), 'ai')) x
      where x = any(tsvector_to_array(to_tsvector('english', coalesce(c.title,'') || ' ' || coalesce(c.summary,'') || ' ' || coalesce(c.angle,'') || ' ' || coalesce(array_to_string(c.tags,' '),'')))))
     >= greatest(1, ceil(coalesce(array_length(array_remove(tsvector_to_array(to_tsvector('english', ${k})), 'ai'), 1), 0) * 0.6)))`;

// $1 since  $2 min_relevance  $3 topics ('|')  $4 limit  $5 min_score
// $6 max_age_days  $7 group_stories  $8 vectors ('|', space-separated)
// $9 item n  $10 chat_id
const COLS = 'id, canonical_url, title, summary, angle, relevance, specificity, angle_strength, score, tags, created_at, published_at, structured, articles';
const SQL = `
with t as (
  select x.ord::int as ord, trim(x.kw) as kw,
    case when nullif(trim(coalesce(x.v, '')), '') is null then null
         else ('[' || replace(trim(x.v), ' ', ',') || ']')::vector(${EMBED_DIM}) end as qv
  from unnest(coalesce(string_to_array(nullif($3, ''), '|'), '{}'::text[]),
              coalesce(string_to_array(nullif($8, ''), '|'), '{}'::text[])) with ordinality as x(kw, v, ord)
  where nullif(trim(coalesce(x.kw, '')), '') is not null
),
nt as (select count(*)::int as n from t),
lim as (select coalesce(nullif($4, '')::int, 20) as n),
c0 as (
  select f.id, f.canonical_url, f.title, f.summary, f.angle, f.relevance, f.specificity, f.angle_strength, f.score,
         f.tags, f.created_at, f.published_at, f.structured, 1 as articles, f.embedding
  from feed_items f where nullif($7, '') is null
  union all
  select r.id, s.canonical_url, s.title, s.summary, s.angle, null::int, s.specificity, s.angle_strength, s.score,
         s.tags, s.created_at, s.last_published, s.structured, s.articles, r.embedding
  from feed_stories s
  left join lateral (select id, embedding from feed_items fi where fi.canonical_url = s.canonical_url order by fi.id desc limit 1) r on true
  where nullif($7, '') is not null
),
c as (
  select * from c0
  where nullif($9, '') is null
    and (nullif($1, '') is null or coalesce(published_at, created_at) >= nullif($1, '')::timestamptz)
    and (nullif($2, '') is null or relevance >= nullif($2, '')::int)
    and (nullif($5, '') is null or score >= nullif($5, '')::int)
    and (nullif($6, '') is null or coalesce(published_at, created_at) >= now() - (nullif($6, '')::int * interval '1 day'))
),
m as (
  select c.*, t.ord, t.kw as topic,
    case when t.qv is null or c.embedding is null then null else 1 - (c.embedding <=> t.qv) end as sim,
    ${kw('t.kw')} as kw_hit
  from c cross join t
),
best as (
  select distinct on (id) * from m
  where kw_hit or sim >= ${SIM_CUTOFF}
  order by id, ord
),
ranked as (
  select best.*, row_number() over (partition by ord order by coalesce(sim, 0) + case when kw_hit then ${KW_BOOST} else 0 end desc, score desc nulls last, published_at desc nulls last) as rn
  from best
),
listed as (
  select ${COLS}, ord, topic, sim, kw_hit, null::text as page, rn from ranked
  where rn <= ceil((select n from lim)::numeric / greatest(1, (select n from nt)))
  union all
  select ${COLS}, null::int, null::text, null::float8, null::boolean, null::text, null::bigint from c
  where (select n from nt) = 0
),
item as (
  select f.id, f.canonical_url, f.title, f.summary, f.angle, f.relevance, f.specificity, f.angle_strength, f.score,
         f.tags, f.created_at, f.published_at, f.structured, 1 as articles,
         null::int as ord, null::text as topic, null::float8 as sim, null::boolean as kw_hit, left(d.markdown, 6000) as page, null::bigint as rn
  from chat_results cr
  join feed_items f on f.id = cr.item_ids[nullif($9, '')::int]
  left join raw_docs d on d.id = f.raw_doc_id
  where nullif($9, '') is not null and cr.chat_id = nullif($10, '')::bigint
)
select *, case when published_at is null then null else greatest(0, extract(day from now() - published_at)::int) end as age_days
from (select * from listed order by ord nulls first, rn nulls last, score desc nulls last, published_at desc nulls last limit (select n from lim)) l
union all
select *, case when published_at is null then null else greatest(0, extract(day from now() - published_at)::int) end
from item
`.replace(/\s+/g, ' ').trim();

const SHAPE = `
const p = $('Params').first().json;
const rows = $input.all().map((i) => i.json).filter((j) => j && (j.canonical_url || j.id));
const round = (x) => (x == null ? undefined : Math.round(Number(x) * 1000) / 1000);
const clean = (r, n) => ({ n, id: r.id, title: r.title, canonical_url: r.canonical_url, summary: r.summary, angle: r.angle,
  score: r.score, specificity: r.specificity, angle_strength: r.angle_strength, tags: r.tags,
  published_at: r.published_at, age_days: r.age_days, structured: r.structured,
  articles: Number(r.articles) > 1 ? Number(r.articles) : undefined,
  topic: r.topic || undefined,
  match: r.topic ? (r.kw_hit && r.sim >= ${SIM_CUTOFF} ? 'keyword+meaning' : r.kw_hit ? 'keyword' : 'meaning') : undefined,
  similarity: round(r.sim) });

if (p.item_n) {
  if (!rows.length) return [{ json: { remember: 'select 1 as skipped', out: { found: false,
    note: 'There is no item #' + p.item_n + ' in the last list shown in this chat. Ask which item they mean, or read query_feed again.' } } }];
  const r = rows[0];
  return [{ json: { remember: 'select 1 as skipped', out: { found: true, item: { ...clean(r, Number(p.item_n)), page_excerpt: r.page || '' },
    note: 'This is item #' + p.item_n + ' from the last list, with an excerpt of the saved page. Answer from it; do not search again.' } } }];
}

const items = rows.map((r, i) => clean(r, i + 1));
const chat = String(p.chat_id || '').trim();
const ids = items.map((i) => Number(i.id)).filter((x) => Number.isInteger(x) && x > 0);
const remember = /^-?\\d+$/.test(chat) && ids.length === items.length && ids.length
  ? 'insert into chat_results (chat_id, item_ids, topic, created_at) values (' + chat + ', array[' + ids.join(',') + ']::bigint[], null, now()) ' +
    'on conflict (chat_id) do update set item_ids = excluded.item_ids, topic = excluded.topic, created_at = excluded.created_at'
  : 'select 1 as skipped';
const out = { count: items.length, items };
if (p.topics.length) { out.topics = p.topics; out.semantic = p.semantic; }
if (!items.length) out.note = p.topics.length ? 'nothing in the feed matches ' + p.topics.join(' / ') : 'no feed items matched the filters';
else out.note = 'Each item has n. Show n with each item you list; the user can say "#3" or "the first one" and get_item will fetch it.' +
  (items.some((i) => i.articles) ? ' articles > 1 means several outlets covered the same story.' : '');
return [{ json: { remember, out } }];
`.trim();

const pg = (name, id, pos, query, replacement, extra = {}) => Object.assign({
  id, name, type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: pos,
  parameters: { operation: 'executeQuery', query, options: replacement ? { queryReplacement: replacement } : {} },
  credentials: { postgres: CRED_PG } }, extra);
const code = (name, id, pos, jsCode) => ({ id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: { mode: 'runOnceForAllItems', jsCode } });

const INPUTS = ['since', 'min_relevance', 'tag', 'limit', 'min_score', 'max_age_days', 'group_stories', 'item', 'chat_id'];

const wf = {
  name: 'WF-31 query_feed',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: INPUTS.map((name) => ({ name, type: 'string' })) } } },
    code('Prep', 'prep', [200, 0], PREP),
    { id: 'embed', name: 'Embed topics', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 0],
      parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/embeddings',
        authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.embed_body }}', options: { timeout: 20000 } },
      credentials: { httpBearerAuth: CRED_LM }, retryOnFail: false, onError: 'continueRegularOutput' },
    code('Params', 'params', [600, 0], PARAMS),
    pg('Select feed', 'select', [800, 0], SQL,
      "={{ $json.since || '' }},{{ $json.min_relevance || '' }},{{ $json.topics_param }},{{ $json.limit || '' }},{{ $json.min_score || '' }},{{ $json.max_age_days || '' }},{{ $json.group_stories || '' }},{{ $json.vectors_param }},{{ $json.item_n }},{{ $json.chat_id || '' }}",
      { executeOnce: true, alwaysOutputData: true }),
    code('Shape result', 'shape', [1000, 0], SHAPE),
    pg('Remember list', 'remember', [1200, 0], '={{ $json.remember }}', null,
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' }),
    code('Return', 'ret', [1400, 0], "return [{ json: $('Shape result').first().json.out }];")
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Prep', type: 'main', index: 0 }]] },
    'Prep': { main: [[{ node: 'Embed topics', type: 'main', index: 0 }]] },
    'Embed topics': { main: [[{ node: 'Params', type: 'main', index: 0 }]] },
    'Params': { main: [[{ node: 'Select feed', type: 'main', index: 0 }]] },
    'Select feed': { main: [[{ node: 'Shape result', type: 'main', index: 0 }]] },
    'Shape result': { main: [[{ node: 'Remember list', type: 'main', index: 0 }]] },
    'Remember list': { main: [[{ node: 'Return', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};

const out = path.join(__dirname, '..', 'workflows', 'wf31-query-feed.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
console.log('wrote', out);
