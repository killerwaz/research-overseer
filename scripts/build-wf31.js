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
// Passage search (sql/014-015, shared/passage-search.js): a topic also matches
// an item when a passage of its saved page matches — by meaning or by rare
// keywords — and that passage comes back as the item's evidence. Measured
// 2026-10-12 (scripts/eval-passages.js): answers found 25/26 vs 7/13 from
// summaries alone, absent topics 4/4 clean.
const { passageCtes, KW_WEIGHT } = require('../shared/passage-search.js');
// Fix 1 switches (settings table) and the 9B reranker: shared/rerank.js.

const PREP = inline('embed.js') + inline('feed-search.js') + `
// Every input leaves as a string: queryReplacement inlines numbers UNQUOTED, and
// nullif(-75, '') then makes Postgres cast '' to integer and fail. The router
// passes chat_id as a number, so this is the live path, not an edge case.
const raw = $('WF Input').first().json;
const j = {};
for (const k of ${JSON.stringify(['since', 'min_relevance', 'tag', 'limit', 'min_score', 'max_age_days', 'group_stories', 'item', 'chat_id', 'user_text'])}) {
  j[k] = raw[k] == null ? '' : String(raw[k]).trim();
}
// Filters the user's message never asked for are dropped (shared/feed-search.js).
const uf = userFilters(j.user_text, j);
j.min_score = uf.min_score; j.max_age_days = uf.max_age_days; j.since = uf.since;
j.filters_dropped = uf.dropped.join(',');
j.question = j.user_text;   /* the reranker judges passages against the real question */
delete j.user_text;
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
// $6 max_age_days  $7 group_stories ('false' = every article; anything else
//    = one row per story, the default since sql/012 dedupes by meaning)
// $8 vectors ('|', space-separated)
// $9 item n  $10 chat_id
/* get_item reads the cleaned passages (no menus/footers), falling back to the raw page. */
const PCOLS = 'pn, pstart, psim, pcover, ptext, phl, pn2, ptext2';
const PNULLS = 'null::int as pn, null::int as pstart, null::float8 as psim, null::float8 as pcover, null::text as ptext, null::text as phl, null::int as pn2, null::text as ptext2';
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
${passageCtes()},
pmap as materialized (
  select p.ord, p.n as pn, p.start_s as pstart, p.sim as psim, p.cover as pcover, p.pscore, p.text as ptext, p.headline as phl,
    s2.pn2, s2.ptext2,
    'it:' || f.id as it_key, 'st:' || coalesce(f.dup_of, f.id) as st_key
  from pdoc p join feed_items f on f.raw_doc_id = p.raw_doc_id
  left join lateral (select x.n as pn2, x.text as ptext2 from ph x where x.ord = p.ord and x.raw_doc_id = p.raw_doc_id and x.n <> p.n
    order by coalesce(x.sim, 0) + ${KW_WEIGHT} * coalesce(x.cover, 0) desc limit 1) s2 on true
),
nt as (select count(*)::int as n from t),
lim as (select coalesce(nullif($4, '')::int, 20) as n),
c0 as (
  select f.id, f.canonical_url, f.title, f.summary, f.angle, f.relevance, f.specificity, f.angle_strength, f.score,
         f.tags, f.created_at, f.published_at, f.structured, 1 as articles, f.embedding, 'it:' || f.id as match_key
  from feed_items f where $7 = 'false'
  union all
  select r.id, s.canonical_url, s.title, s.summary, s.angle, null::int, s.specificity, s.angle_strength, s.score,
         s.tags, s.created_at, s.last_published, s.structured, s.articles, r.embedding, s.story_key
  from feed_stories s
  left join lateral (select id, embedding from feed_items fi where fi.canonical_url = s.canonical_url order by fi.id desc limit 1) r on true
  where coalesce($7, '') <> 'false'
),
/* in_filter = passes the time/quality filters. Topic matching runs over ALL
   items so the matches the filters excluded can be reported separately
   (outside = true) instead of the read looking empty. (Block comments only:
   the query is collapsed to one line.) */
call as (
  select c0.*,
    (nullif($1, '') is null or coalesce(published_at, created_at) >= nullif($1, '')::timestamptz)
    and (nullif($2, '') is null or relevance >= nullif($2, '')::int)
    and (nullif($5, '') is null or score >= nullif($5, '')::int)
    and (nullif($6, '') is null or coalesce(published_at, created_at) >= now() - (nullif($6, '')::int * interval '1 day')) as in_filter
  from c0 where nullif($9, '') is null
),
c as (select * from call where in_filter),
m as (
  select c.*, t.ord, t.kw as topic,
    case when t.qv is null or c.embedding is null then null else 1 - (c.embedding <=> t.qv) end as sim,
    ${kw('t.kw')} as kw_hit,
    pm.pn, pm.pstart, pm.psim, pm.pcover, pm.pscore, pm.ptext, pm.phl, pm.pn2, pm.ptext2
  from call c cross join t
  left join lateral (select * from pmap where pmap.ord = t.ord and c.match_key in (pmap.it_key, pmap.st_key)
    order by pmap.pscore desc limit 1) pm on true
),
best as (
  /* rel: an item whose title/summary matches ranks as before (+0.05 when its
     text agrees); one found ONLY in its article text ranks by that passage's
     meaning score, so passing mentions ("weather" in a transport list) sink
     below real topic matches instead of pushing them out of the top 5. */
  select distinct on (id) *,
    case when kw_hit or sim >= ${SIM_CUTOFF}
      then coalesce(sim, 0) + case when kw_hit then ${KW_BOOST} else 0 end + case when pscore is not null then 0.05 else 0 end
      else coalesce(psim, 0) end as rel
  from m
  where kw_hit or sim >= ${SIM_CUTOFF} or pscore is not null
  order by id, ord
),
ranked as (
  select best.*, row_number() over (partition by ord, in_filter order by rel desc, score desc nulls last, published_at desc nulls last) as rn
  from best
),
listed as (
  select ${COLS}, ord, topic, sim, kw_hit, null::text as page, rn, false as outside, ${PCOLS} from ranked
  where in_filter and rn <= ceil((select n from lim)::numeric / greatest(1, (select n from nt)))
  union all
  select ${COLS}, null::int, null::text, null::float8, null::boolean, null::text, null::bigint, false, ${PNULLS} from c
  where (select n from nt) = 0
),
/* Best 5 topic matches the filters excluded, so "nothing this week" can still
   say "but N older / lower-scored ones". Never mixed into the main list. */
outside as (
  select ${COLS}, ord, topic, sim, kw_hit, null::text as page, rn, true as outside, ${PCOLS} from ranked
  where not in_filter order by rel desc limit 5
),
outside_n as (select count(*)::int as n from best where not in_filter),
item as (
  select f.id, f.canonical_url, f.title, f.summary, f.angle, f.relevance, f.specificity, f.angle_strength, f.score,
         f.tags, f.created_at, f.published_at, f.structured, 1 as articles,
         null::int as ord, null::text as topic, null::float8 as sim, null::boolean as kw_hit,
         coalesce((select left(string_agg(dc.text, chr(10) || chr(10) order by dc.n), 6000) from doc_chunks dc where dc.raw_doc_id = d.id), left(d.markdown, 6000)) as page,
         null::bigint as rn, null::boolean as outside, ${PNULLS}
  from chat_results cr
  join feed_items f on f.id = cr.item_ids[nullif($9, '')::int]
  left join raw_docs d on d.id = f.raw_doc_id
  where nullif($9, '') is not null and cr.chat_id = nullif($10, '')::bigint
)
select *, case when published_at is null then null else greatest(0, extract(day from now() - published_at)::int) end as age_days,
  (select n from outside_n) as outside_total
from (select * from listed order by ord nulls first, rn nulls last, score desc nulls last, published_at desc nulls last limit (select n from lim)) l
union all
select *, case when published_at is null then null else greatest(0, extract(day from now() - published_at)::int) end, (select n from outside_n)
from outside
union all
select *, case when published_at is null then null else greatest(0, extract(day from now() - published_at)::int) end, null::int
from item
`.replace(/\s+/g, ' ').trim();

const RERANK_PREP = inline('rerank.js') + `
const sw = switchesFrom($('Switches').first().json);
const p = $('Params').first().json;
const rows = $('Select feed').all().map((i) => i.json).filter((j) => j && (j.canonical_url || j.id));
const off = [{ json: { go: 'off', map: [] } }];
if (sw.rerank === 'off' || p.item_n || !p.topics.length) return off;
const c = rerankCandidates(rows, sw.rerank, sw.two);
if (!c.docs.length) return off;
const q = p.question || p.topics.join(' / ');
return [{ json: { go: sw.rerank, map: c.map,
  llm_body: JSON.stringify(rerankLlmBody('qwen/qwen3.5-9b', q, c.docs)) } }];
`.trim();

const SHAPE = inline('passage-search.js') + inline('rerank.js') + `
const p = $('Params').first().json;
const words = (p.topics || []).join(' ').split(/\\s+/).filter((w) => w.length > 2);
// The best matching passage; videos get a link to the moment (YouTube t=).
// The first FULL_EVIDENCE listed matches carry the whole passage (~2,500
// chars): fragments missed "usually 50-100 tokens" in the end-to-end test.
// The rest, and items outside the filters, carry fragments around the
// topic's words.
const FULL_EVIDENCE = 3;
let fullLeft = FULL_EVIDENCE;
const sw = switchesFrom($('Switches').first().json);
function evidence(r) {
  if (!r.ptext) return undefined;
  const hl = String(r.phl || '').replace(/\\s+/g, ' ').trim();
  let text;
  const tidy = (t) => String(t).replace(/[ \\t]+/g, ' ').replace(/\\n{2,}/g, '\\n').trim().slice(0, 2600);
  if (fullLeft > 0 && r.outside !== true) {
    fullLeft--; text = tidy(r.ptext);
    if (sw.two && r.ptext2) text += '\\n[another passage of the same article]\\n' + tidy(r.ptext2);
  }
  else text = hl ? (hl.length > 900 ? hl.slice(0, 900) + '…' : hl) : evidenceSnippet(r.ptext, words, 450);
  const ev = { text, passage: Number(r.pn) };
  if (r.pstart != null) {
    const s = Number(r.pstart);
    ev.at = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    if (/youtube\\.com\\/watch|youtu\\.be\\//.test(r.canonical_url || '')) ev.link = r.canonical_url + (r.canonical_url.includes('?') ? '&' : '?') + 't=' + s;
  }
  return ev;
}
let rows = $('Select feed').all().map((i) => i.json).filter((j) => j && (j.canonical_url || j.id));
// 1d: reranker scores (either service), applied to the listed rows.
let rrScores = null, rrMap = [];
try { rrMap = $('Rerank prep').first().json.map || []; } catch (e) {}
try { rrScores = parseLlmScores($('Rerank (9B)').first().json.choices[0].message, rrMap.length); } catch (e) {}
if (rrScores && rrMap.length) rows = applyRerank(rows, rrMap, rrScores);
// 1e: weak text-only matches go last, labelled.
if (sw.mentions) {
  rows = rows.map((r) => ({ ...r, mention: r.outside !== true && isPassingMention({ ...r, sim_cutoff: ${SIM_CUTOFF} }) }));
  rows = [...rows.filter((r) => !r.mention), ...rows.filter((r) => r.mention)];
}
const round = (x) => (x == null ? undefined : Math.round(Number(x) * 1000) / 1000);
const clean = (r, n) => ({ n, id: r.id, title: r.title, canonical_url: r.canonical_url, summary: r.summary, angle: r.angle,
  score: r.score, specificity: r.specificity, angle_strength: r.angle_strength, tags: r.tags,
  published_at: r.published_at, age_days: r.age_days, structured: r.structured,
  articles: Number(r.articles) > 1 ? Number(r.articles) : undefined,
  topic: r.topic || undefined,
  match: r.mention ? 'mentioned in passing' : r.topic ? [r.kw_hit ? 'keyword' : '', r.sim >= ${SIM_CUTOFF} ? 'meaning' : '', r.ptext ? 'passage' : ''].filter(Boolean).join('+') || undefined : undefined,
  rerank: r.rr != null ? round(r.rr) : undefined,
  similarity: round(r.sim), evidence: evidence(r) });

if (p.item_n) {
  if (!rows.length) return [{ json: { remember: 'select 1 as skipped', out: { found: false,
    note: 'There is no item #' + p.item_n + ' in the last list shown in this chat. Ask which item they mean, or read query_feed again.' } } }];
  const r = rows[0];
  return [{ json: { remember: 'select 1 as skipped', out: { found: true, item: { ...clean(r, Number(p.item_n)), page_excerpt: r.page || '' },
    note: 'This is item #' + p.item_n + ' from the last list, with an excerpt of the saved page. Answer from it; do not search again.' } } }];
}

const outsideRows = rows.filter((r) => r.outside === true);
const outsideTotal = rows.length ? Number(rows[0].outside_total || 0) : 0;
const items = rows.filter((r) => r.outside !== true).map((r, i) => clean(r, i + 1));
const chat = String(p.chat_id || '').trim();
const ids = items.map((i) => Number(i.id)).filter((x) => Number.isInteger(x) && x > 0);
const remember = /^-?\\d+$/.test(chat) && ids.length === items.length && ids.length
  ? 'insert into chat_results (chat_id, item_ids, topic, created_at) values (' + chat + ', array[' + ids.join(',') + ']::bigint[], null, now()) ' +
    'on conflict (chat_id) do update set item_ids = excluded.item_ids, topic = excluded.topic, created_at = excluded.created_at'
  : 'select 1 as skipped';
const out = { count: items.length, items };
if (p.filters_dropped) out.filters_ignored = p.filters_dropped + ' (the user did not ask for them; never add filters they did not ask for)';
if (p.topics.length) { out.topics = p.topics; out.semantic = p.semantic; }
if (outsideRows.length) {
  // Evidence travels with these too: with only a title, the 9B filled the gap
  // from memory (end-to-end test 2026-10-12: "Langfuse was acquired by
  // Databricks" when a stray min_score hid the article that says ClickHouse).
  out.outside_filters = { total: outsideTotal, examples: outsideRows.map((r) => ({ title: r.title, published_at: r.published_at,
    age_days: r.age_days, score: r.score, canonical_url: r.canonical_url, evidence: evidence(r) })) };
}
const outsideNote = outsideRows.length ? ' ' + outsideTotal + ' more items match the topic but are outside your time/score filters (outside_filters) — mention them as older or lower-scored, never as matching the filter. If one has evidence that answers the question, answer from that evidence and say it comes from an older or lower-scored item. Never state a fact about them that is not in their title or evidence.' : '';
if (!items.length) out.note = (p.topics.length ? 'nothing in the feed matches (titles, summaries or article text) ' + p.topics.join(' / ') + ' within these filters.' : 'no feed items matched the filters.') + outsideNote;
else out.note = 'Each item has n. Show n with each item you list; the user can say "#3" or "the first one" and get_item will fetch it.' +
  (items.some((i) => i.articles) ? ' articles > 1 means several outlets covered the same story: write "(N sources)" after that title.' : '') +
  (items.some((i) => i.match === 'mentioned in passing') ? ' Items with match "mentioned in passing" only mention the words somewhere in the article; they are not about the topic. List them after the others under "also mentioned in", or leave them out.' : '') +
  (items.some((i) => i.evidence) ? ' evidence = the passage of that article that matched the topic: answer specific questions (who, how much, when) from it, quoting its numbers and names; it is the article text, the summary may not contain it. evidence.link opens a video at that moment.' : '') + outsideNote;
return [{ json: { remember, out } }];
`.trim();

const pg = (name, id, pos, query, replacement, extra = {}) => Object.assign({
  id, name, type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: pos,
  parameters: { operation: 'executeQuery', query, options: replacement ? { queryReplacement: replacement } : {} },
  credentials: { postgres: CRED_PG } }, extra);
const code = (name, id, pos, jsCode) => ({ id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: { mode: 'runOnceForAllItems', jsCode } });

const INPUTS = ['since', 'min_relevance', 'tag', 'limit', 'min_score', 'max_age_days', 'group_stories', 'item', 'chat_id', 'user_text'];

const wf = {
  name: 'WF-31 query_feed',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: INPUTS.map((name) => ({ name, type: 'string' })) } } },
    pg('Switches', 'switches', [100, -150], "select coalesce(max(value) filter (where key = 'fix_two_passages'), '') as fix_two_passages, coalesce(max(value) filter (where key = 'fix_rerank'), '') as fix_rerank, coalesce(max(value) filter (where key = 'fix_mentions'), '') as fix_mentions, coalesce(max(value) filter (where key = 'fix_answer_check'), '') as fix_answer_check from settings", null,
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' }),
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
    code('Rerank prep', 'rrprep', [900, -150], RERANK_PREP),
    { id: 'rron', name: 'Rerank?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1000, -150],
      parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
        conditions: [{ id: 'r1', leftValue: '={{ $json.go }}', rightValue: 'off', operator: { type: 'string', operation: 'notEquals' } }] } } },
    { id: 'rrllm', name: 'Rerank (9B)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1200, -150],
      parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
        authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.llm_body }}', options: { timeout: 60000 } },
      credentials: { httpBearerAuth: CRED_LM }, retryOnFail: false, onError: 'continueRegularOutput' },
    code('Shape result', 'shape', [1300, 0], SHAPE),
    pg('Remember list', 'remember', [1200, 0], '={{ $json.remember }}', null,
      { executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' }),
    code('Return', 'ret', [1400, 0], "return [{ json: $('Shape result').first().json.out }];")
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Switches', type: 'main', index: 0 }]] },
    'Switches': { main: [[{ node: 'Prep', type: 'main', index: 0 }]] },
    'Prep': { main: [[{ node: 'Embed topics', type: 'main', index: 0 }]] },
    'Embed topics': { main: [[{ node: 'Params', type: 'main', index: 0 }]] },
    'Params': { main: [[{ node: 'Select feed', type: 'main', index: 0 }]] },
    'Select feed': { main: [[{ node: 'Rerank prep', type: 'main', index: 0 }]] },
    'Rerank prep': { main: [[{ node: 'Rerank?', type: 'main', index: 0 }]] },
    'Rerank?': { main: [[{ node: 'Rerank (9B)', type: 'main', index: 0 }], [{ node: 'Shape result', type: 'main', index: 0 }]] },
    'Rerank (9B)': { main: [[{ node: 'Shape result', type: 'main', index: 0 }]] },
    'Shape result': { main: [[{ node: 'Remember list', type: 'main', index: 0 }]] },
    'Remember list': { main: [[{ node: 'Return', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};

const out = path.join(__dirname, '..', 'workflows', 'wf31-query-feed.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
console.log('wrote', out);
