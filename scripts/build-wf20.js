// Builds workflows/wf20-process-urls.json (spec §5.2).
// Run: node scripts/build-wf20.js
const fs = require('fs');
const path = require('path');

// Instance-local ids live in instance.json; the chat id is substituted at
// deploy time by scripts/deploy.js so it never lands in committed JSON.
const I = require('./instance.json');
const CRED_PG = I.credentials.postgres;
const CRED_CRAWL = I.credentials.crawl4ai;
const CRED_LM = I.credentials.lmstudio;
const CRED_FC = I.credentials.firecrawl;
// WF-21 triage_one — per-item Execute Workflow calls run sequentially, which
// serializes LM Studio traffic without a SplitInBatches loop (that loop
// silently skipped items when scrape branches produced multiple batches).
const WF21_ID = I.workflows['wf21-triage-one'];

// Pure functions are inlined from shared/ rather than duplicated here, so the
// committed tests exercise exactly the code that ships into the n8n nodes.
// (readFileSync, not a template literal — these modules contain backticks.)
const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
  .replace(/module\.exports[\s\S]*$/, '');

const CANONICALIZE = inline('canonicalize.js') + `
let lastErr = null;
const runId = $input.first().json.run_id;
const urls = $('WF Input').first().json.urls || [];
const out = [];
for (const item of urls) {
  const obj = typeof item === 'string' ? { url: item } : (item || {});
  const c = obj.url ? canon(obj.url) : null;
  if (!c) continue;
  out.push({ json: { url: obj.url, title: obj.title || null, source: obj.source || null,
    published_at: obj.published_at || null, canonical_url: c, run_id: runId } });
}
if (!out.length) return [{ json: { __no_new: true, run_id: runId, debug: lastErr } }];
return out;
`.trim();

const BUILD_DEDUPE = `
const first = $input.first().json;
if (first.__no_new) return [{ json: { query: 'select null as canonical_url where false', __no_new: true } }];
const esc = (u) => String(u).replace(/'/g, "''");
const urls = $input.all().map(i => i.json.canonical_url);
const query = 'select canonical_url from seen_urls where canonical_url in (' +
  urls.map(u => "'" + esc(u) + "'").join(',') + ')';
return [{ json: { query } }];
`.trim();

const FILTER_NEW = `
const runId = $('Create run').first().json.run_id;
const seen = new Set($input.all().map(i => i.json && i.json.canonical_url).filter(Boolean));
let candidates = [];
try { candidates = $('Canonicalize').all().map(i => i.json).filter(j => !j.__no_new); } catch (e) {}
const byCanon = new Map();
for (const c of candidates) if (!seen.has(c.canonical_url) && !byCanon.has(c.canonical_url)) byCanon.set(c.canonical_url, c);
const fresh = [...byCanon.values()];
if (!fresh.length) return [{ json: { __no_new: true, run_id: runId } }];
return fresh.map(j => ({ json: j }));
`.trim();

const LOG_FAILURE = `
const orig = $('Filter new').item.json;
let reason = 'both_scrapers_failed_or_short_markdown';
if ($json.error) {
  const msg = (typeof $json.error === 'object' && $json.error.message) ? $json.error.message : String($json.error);
  reason = 'firecrawl_error: ' + String(msg).slice(0, 120);
} else if ($json.data) reason = 'firecrawl_short_markdown';
return { json: { failed: true, url: orig.url, canonical_url: orig.canonical_url, reason, run_id: orig.run_id } };
`.trim();

const PREP_DOC = `
const orig = $('Filter new').item.json;
let markdown = '';
let title = '';
let scraper = 'crawl4ai';
if ($json.results) {
  const r = ($json.results && $json.results[0]) || {};
  const md = r.markdown || {};
  const fit = (typeof md === 'object' ? md.fit_markdown : md) || '';
  const raw = (typeof md === 'object' ? md.raw_markdown : '') || '';
  markdown = fit.length >= 400 ? fit : raw;
  title = (r.metadata && r.metadata.title) || orig.title || '';
} else {
  scraper = 'firecrawl';
  const d = $json.data || {};
  markdown = d.markdown || '';
  title = (d.metadata && d.metadata.title) || orig.title || '';
}
// A skill (resolved from the run's query) appends to the prompt and widens the
// schema — one model call still, standard fields unchanged.
const run = $('Create run').first().json;
const sys = TRIAGE_SYSTEM + (run.skill_prompt ? '\\n\\nADDITIONAL EXTRACTION\\n' + run.skill_prompt : '');
let schema = TRIAGE_SCHEMA;
if (run.skill_schema) {
  try { schema = withSkill(TRIAGE_SCHEMA, JSON.parse(run.skill_schema)); } catch (e) {}
}
const prof = profileFor(orig.source);
// Dates are stated, never inferred: the sandbox clock is UTC and the model has
// none, so without these it invents recency inside the summary.
const dhaka = new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
const pub = orig.published_at ? String(orig.published_at).slice(0, 10) : 'unknown';
const user = 'TODAY: ' + dhaka + '\\n' + 'PUBLISHED: ' + pub + '\\n' +
  'TITLE: ' + title + '\\n' + 'URL: ' + orig.canonical_url +
  '\\n\\nCONTENT:\\n' + markdown.slice(0, prof.content_chars);
const triage_body = JSON.stringify({ model: prof.model, temperature: 0.2, max_tokens: prof.max_tokens,
  reasoning_effort: prof.reasoning_effort, response_format: schema,
  messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] });
return { json: { canonical_url: orig.canonical_url, source: orig.source || '', title,
  markdown, scraper, run_id: orig.run_id, triage_body, triage_profile: prof.model + '/' + prof.content_chars,
  published_at: orig.published_at || '' } };
`.trim();

// WF-21 runs one doc per execution, so .first() is always the right item
const BUILD_RETRY = `
const doc = $('WF Input').first().json;
const base = JSON.parse(doc.triage_body);
let prev = 'no output';
try { prev = $('Triage').first().json.choices[0].message.content || 'no output'; } catch (e) {}
base.messages.push({ role: 'assistant', content: String(prev).slice(0, 2000) });
base.messages.push({ role: 'user', content: 'Your previous output was not valid JSON matching the required schema. Return ONLY the JSON object with fields summary, angle, relevance, tags.' });
return { json: { retry_body: JSON.stringify(base) } };
`.trim();

const { TRIAGE_SYSTEM, TRIAGE_SCHEMA } = require('../shared/triage-config.js');

// Triage request bodies are prebuilt in Code nodes (Prep doc / Build retry) because
// n8n expressions reject multi-statement code. Substitute the constants into PREP_DOC.
const PREP_DOC_FINAL = inline('triage-config.js') + '\n' + inline('triage-validate.js') + '\n' + PREP_DOC;

const VALIDATE_COMMON = inline('triage-validate.js') + `
const doc = $('WF Input').first().json;
const rawDocId = doc.raw_doc_id;
`.trim();

const VALIDATE_1 = VALIDATE_COMMON + `
const o = parseContent($json);
if (!o) return { json: { __invalid: true } };
return { json: { __invalid: false, raw_doc_id: rawDocId, canonical_url: doc.canonical_url, title: doc.title,
  summary: o.summary, angle: o.angle || '', relevance: o.relevance,
  specificity: o.specificity, angle_strength: o.angle_strength, tags_pg: tagsPg(o.tags),
  structured_json: (splitStructured(o).structured ? JSON.stringify(splitStructured(o).structured) : ''),
  published_at: doc.published_at || '', run_id: doc.run_id } };
`;

const VALIDATE_2 = VALIDATE_COMMON + `
const o = parseContent($json);
if (!o) return { json: { raw_doc_id: rawDocId, canonical_url: doc.canonical_url, title: doc.title,
  summary: 'TRIAGE_FAILED', angle: '', relevance: '', specificity: '', angle_strength: '', tags_pg: '{}',
  structured_json: '', published_at: doc.published_at || '', run_id: doc.run_id } };
return { json: { raw_doc_id: rawDocId, canonical_url: doc.canonical_url, title: doc.title,
  summary: o.summary, angle: o.angle || '', relevance: o.relevance,
  specificity: o.specificity, angle_strength: o.angle_strength, tags_pg: tagsPg(o.tags),
  structured_json: (splitStructured(o).structured ? JSON.stringify(splitStructured(o).structured) : ''),
  published_at: doc.published_at || '', run_id: doc.run_id } };
`;

// Embedding runs after the feed row exists and can never fail the triage: the
// HTTP and Postgres nodes continue on error and Build vector update falls back
// to a no-op query. A missed embedding is picked up by
// scripts/backfill-embeddings.js. TRIAGE_FAILED rows are skipped — the WF-30
// drain re-triages them, and that pass embeds them.
const EMBED = inline('embed.js');
const BUILD_EMBED = EMBED + `
const t = $('Merge triaged').first().json;
const id = $('Insert feed').first().json.feed_item_id;
const tags = String(t.tags_pg || '').replace(/[{}]/g, '').split(',').filter(Boolean);
if (!id || t.summary === 'TRIAGE_FAILED') return [{ json: { __skip: true, embed_body: '{}' } }];
return [{ json: { feed_item_id: id, embed_body: JSON.stringify({ model: EMBED_MODEL,
  input: [docText({ title: t.title, summary: t.summary, angle: t.angle, tags })] }) } }];
`.trim();
const BUILD_VECTOR_UPDATE = EMBED + `
const noop = [{ json: { query: 'select 1 as skipped' } }];
const b = $('Build embed').first().json;
if (b.__skip) return noop;
try {
  const vec = $input.first().json.data[0].embedding;
  return [{ json: { query: "update feed_items set embedding = '" + vectorLiteral(vec) +
    "'::vector where id = " + Number(b.feed_item_id) } }];
} catch (e) { return noop; }
`.trim();

// Counts and status are computed in SQL (Finalize run) because nodes fed by two
// branches (crawl4ai + firecrawl paths) execute once per input batch, and
// $('node').all() only returns the LAST batch. Here we only gather urls_new and
// failure strings (walking every run of Log failure via runIndex).
const COLLECT_STATS = `
const runId = $('Create run').first().json.run_id;
let fresh = 0; try { fresh = $('Filter new').all().map(i => i.json).filter(j => !j.__no_new).length; } catch (e) {}
const fails = [];
for (let r = 0; r < 50; r++) {
  let items;
  try { items = $('Log failure').all(0, r); } catch (e) { break; }
  for (const it of items) fails.push({ url: it.json.url, reason: it.json.reason });
}
// full detail -> runs.error (DB); short host list -> Telegram summary
const error = fails.map(f => f.url + ' (' + f.reason + ')').join('; ').slice(0, 2000);
const hosts = [...new Set(fails.map(f => String(f.url).replace(/^https?:\\/\\//, '').split('/')[0]))];
const error_brief = fails.length
  ? fails.length + ' failed: ' + hosts.slice(0, 5).join(', ') + (hosts.length > 5 ? ', …' : '')
  : '';
return [{ json: { run_id: runId, urls_new: fresh, error, error_brief } }];
`.trim();

const CRAWL_BODY = "={{ JSON.stringify({ urls: [$json.canonical_url], crawler_config: { type: 'CrawlerRunConfig', params: { markdown_generator: { type: 'DefaultMarkdownGenerator', params: { content_filter: { type: 'PruningContentFilter', params: {} } } } } } }) }}";

function pgNode(name, id, pos, query, replacement, extra = {}) {
  return Object.assign({
    id, name, type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: pos,
    parameters: { operation: 'executeQuery', query, options: replacement ? { queryReplacement: replacement } : {} },
    credentials: { postgres: CRED_PG }
  }, extra);
}
function codeNode(name, id, pos, mode, jsCode, extra = {}) {
  return Object.assign({
    id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
    parameters: { mode, jsCode }
  }, extra);
}

const nodes = [
  { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
    parameters: { workflowInputs: { values: [
      { name: 'urls', type: 'array' }, { name: 'trigger', type: 'string' },
      { name: 'scope', type: 'string' }, { name: 'query', type: 'string' } ] } } },

  // Resolves the skill in the same statement that opens the run, so Prep doc
  // needs no database access of its own.
  pgNode('Create run', 'createrun', [200, 0],
    "insert into runs (trigger, scope, urls_found, query) values ($1, $2, $3::int, nullif($4,'')) returning id as run_id, (select s.extra_prompt from queries q join skills s on s.name = q.skill where lower(q.text) = lower(nullif($4,''))) as skill_prompt, (select s.extra_schema::text from queries q join skills s on s.name = q.skill where lower(q.text) = lower(nullif($4,''))) as skill_schema, (select q.skill from queries q where lower(q.text) = lower(nullif($4,''))) as skill_name",
    "={{ $json.trigger }},{{ $json.scope }},{{ ($json.urls || []).length }},{{ $json.query || '' }}",
    { executeOnce: true }),

  codeNode('Canonicalize', 'canon', [400, 0], 'runOnceForAllItems', CANONICALIZE),
  codeNode('Build dedupe query', 'builddq', [600, 0], 'runOnceForAllItems', BUILD_DEDUPE),

  pgNode('Find seen', 'findseen', [800, 0], '={{ $json.query }}', null,
    { executeOnce: true, alwaysOutputData: true }),

  codeNode('Filter new', 'filternew', [1000, 0], 'runOnceForAllItems', FILTER_NEW),

  { id: 'anynew', name: 'Any new?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1200, 0],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      combinator: 'and', conditions: [ { id: 'c1', leftValue: '={{ Boolean($json.__no_new) }}', rightValue: false,
        operator: { type: 'boolean', operation: 'equals' } } ] } } },

  { id: 'scrape', name: 'Scrape', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1400, -100],
    parameters: { method: 'POST', url: 'http://crawl4ai:11235/crawl',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: CRAWL_BODY,
      // Crawl4AI runs 4 workers. Firing a whole RSS batch at once queues most
      // requests past the timeout, so they ALL fall through to Firecrawl and
      // trip its rate limit — run 54 lost 50 URLs that way. Single URLs take
      // ~2.4s, so 4 at a time with a pause keeps us inside the timeout.
      options: { timeout: 20000, batching: { batch: { batchSize: 4, batchInterval: 1000 } } } },
    credentials: { httpBearerAuth: CRED_CRAWL },
    retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput' },

  { id: 'scrapeok', name: 'Scrape OK?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1600, -100],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      combinator: 'and', conditions: [ { id: 'c1',
        leftValue: "={{ ($json.results?.[0]?.markdown?.fit_markdown || $json.results?.[0]?.markdown?.raw_markdown || '').length }}",
        rightValue: 400, operator: { type: 'number', operation: 'gte' } } ] } } },

  // PDFs skip Crawl4AI (a headless browser can't markdown them) and go straight here
  { id: 'ispdf', name: 'Is PDF?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1300, -100],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      combinator: 'and', conditions: [ { id: 'c1',
        leftValue: "={{ $json.canonical_url.toLowerCase().split('?')[0].endsWith('.pdf') }}",
        rightValue: true, operator: { type: 'boolean', operation: 'equals' } } ] } } },

  // Firecrawl does its own fetch+render (and PDF parsing) — 10s kills legitimate
  // scrapes of slow enterprise docs; 45s is still an explicit no-stall bound
  { id: 'firecrawl', name: 'Firecrawl', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1700, 50],
    parameters: { method: 'POST', url: 'https://api.firecrawl.dev/v1/scrape',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ url: $('Filter new').item.json.canonical_url, formats: ['markdown'] }) }}",
      // Fallback only, and the free tier is rate limited — one at a time with a
      // 6s gap stays under ~10/min even if a whole batch needs rescuing.
      options: { timeout: 45000, batching: { batch: { batchSize: 1, batchInterval: 6000 } } } },
    credentials: { httpBearerAuth: CRED_FC },
    retryOnFail: true, maxTries: 2, waitBetweenTries: 5000, onError: 'continueRegularOutput' },

  { id: 'fcok', name: 'Firecrawl OK?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1850, 50],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      combinator: 'and', conditions: [ { id: 'c1',
        leftValue: "={{ ($json.data?.markdown || '').length }}",
        rightValue: 200, operator: { type: 'number', operation: 'gte' } } ] } } },

  codeNode('Log failure', 'logfail', [2000, 150], 'runOnceForEachItem', LOG_FAILURE),
  codeNode('Prep doc', 'prepdoc', [1800, -200], 'runOnceForEachItem', PREP_DOC_FINAL),

  pgNode('Insert doc', 'insertdoc', [2000, -200],
    "with s as (insert into seen_urls (canonical_url, source) values ($1, nullif($2,'')) on conflict (canonical_url) do nothing) insert into raw_docs (canonical_url, title, markdown, scraper, run_id, published_at) values ($1, nullif($3,''), $4, $6, $5::bigint, nullif($7,'')::timestamptz) returning id as raw_doc_id",
    "={{ $json.canonical_url }},{{ $json.source }},{{ $json.title }},{{ $json.markdown }},{{ $json.run_id }},{{ $json.scraper }},{{ $json.published_at }}"),

  // Per-item sequential sub-workflow call — serializes LM Studio traffic and is
  // correct no matter how many batches the scrape branches produce.
  { id: 'runtriage', name: 'Run triage', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [2200, -200],
    parameters: {
      // mode MUST be 'each'. The default ('once') passes the whole batch into a
      // single WF-21 execution, where every expression reads WF Input.first() —
      // silently writing N triage results against the FIRST doc and dropping the
      // rest. WF-21 guards against this too. ('each' is deprecation-flagged; if it
      // is ever removed, replace with a Loop Over Items feeding mode 'once'.)
      mode: 'each',
      workflowId: { __rl: true, value: WF21_ID, mode: 'id' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          triage_body: "={{ $('Prep doc').item.json.triage_body }}",
          raw_doc_id: '={{ $json.raw_doc_id }}',
          canonical_url: "={{ $('Prep doc').item.json.canonical_url }}",
          title: "={{ $('Prep doc').item.json.title }}",
          published_at: "={{ $('Prep doc').item.json.published_at }}",
          run_id: "={{ $('Prep doc').item.json.run_id }}"
        },
        matchingColumns: [],
        schema: [
          { id: 'triage_body', displayName: 'triage_body', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'raw_doc_id', displayName: 'raw_doc_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'canonical_url', displayName: 'canonical_url', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'title', displayName: 'title', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'published_at', displayName: 'published_at', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
          { id: 'run_id', displayName: 'run_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
        ]
      },
      options: { waitForSubWorkflow: true }
    },
    onError: 'continueRegularOutput' },

  { id: 'mergestats', name: 'Merge for stats', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [3600, 0],
    parameters: { mode: 'append', numberInputs: 3 } },

  codeNode('Collect stats', 'stats', [3800, 0], 'runOnceForAllItems', COLLECT_STATS),

  pgNode('Finalize run', 'finalize', [4000, 0],
    "update runs set finished_at = now(), urls_new = $2::int, urls_scraped = (select count(*) from raw_docs where run_id = $1::bigint), items_created = (select count(*) from feed_items where run_id = $1::bigint), error = nullif($3,''), status = case when $2::int = 0 and $3 = '' then 'ok' when (select count(*) from raw_docs where run_id = $1::bigint) = 0 and $2::int > 0 then 'failed' when (select count(*) from raw_docs where run_id = $1::bigint) < $2::int then 'partial' when (select count(*) from feed_items where run_id = $1::bigint) < (select count(*) from raw_docs where run_id = $1::bigint) then 'partial' else 'ok' end where id = $1::bigint returning id as run_id, status, scope, urls_found, urls_new, urls_scraped, items_created, error, (select title from feed_items where run_id = $1::bigint order by score desc, relevance desc nulls last, id desc limit 1) as top_title",
    "={{ $json.run_id }},{{ $json.urls_new }},{{ $json.error }}",
    { executeOnce: true }),

  // Plain-language summary. No run numbers, no "items", no scope codes — those
  // are for run_status when something actually needs looking at.
  codeNode('Compose summary', 'compose', [4180, 0], 'runOnceForAllItems', `
const r = $('Finalize run').first().json;
let brief = '';
try { brief = $('Collect stats').first().json.error_brief || ''; } catch (e) {}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const made = Number(r.items_created) || 0;
const failed = Number((brief.match(/^(\\d+) failed/) || [])[1] || 0);
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

let text;
if (made === 0 && failed === 0) {
  text = '\u{1F52D} Nothing new — everything found was already in your feed.';
} else if (made === 0) {
  text = '\u{1F52D} Nothing added. ' + plural(failed, 'page') + " couldn't be read.";
} else {
  text = '\u{1F52D} Found ' + plural(made, 'new page') + ', all summarized.';
  if (failed) text += ' ' + plural(failed, 'other') + " couldn't be read.";
}
if (r.top_title) text += '\\nTop: ' + esc(r.top_title);
if (brief) {
  const hosts = brief.replace(/^\\d+ failed: /, '');
  text += '\\n\u{26A0} ' + esc(hosts);
}
return [{ json: { text } }];
`.trim()),

  { id: 'tgsummary', name: 'Telegram summary', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [4380, 0],
    parameters: {
      chatId: '__TG_CHAT__',
      text: '={{ $json.text }}',
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' } },
    credentials: { telegramApi: I.credentials.telegram },
    onError: 'continueRegularOutput' },

  codeNode('Return summary', 'retsummary', [4400, 0], 'runOnceForAllItems',
    "return $('Finalize run').all();")
];

const connections = {
  'WF Input': { main: [[{ node: 'Create run', type: 'main', index: 0 }]] },
  'Create run': { main: [[{ node: 'Canonicalize', type: 'main', index: 0 }]] },
  'Canonicalize': { main: [[{ node: 'Build dedupe query', type: 'main', index: 0 }]] },
  'Build dedupe query': { main: [[{ node: 'Find seen', type: 'main', index: 0 }]] },
  'Find seen': { main: [[{ node: 'Filter new', type: 'main', index: 0 }]] },
  'Filter new': { main: [[{ node: 'Any new?', type: 'main', index: 0 }]] },
  'Any new?': { main: [
    [{ node: 'Is PDF?', type: 'main', index: 0 }],
    [{ node: 'Merge for stats', type: 'main', index: 2 }]
  ] },
  'Is PDF?': { main: [
    [{ node: 'Firecrawl', type: 'main', index: 0 }],
    [{ node: 'Scrape', type: 'main', index: 0 }]
  ] },
  'Scrape': { main: [[{ node: 'Scrape OK?', type: 'main', index: 0 }]] },
  'Scrape OK?': { main: [
    [{ node: 'Prep doc', type: 'main', index: 0 }],
    [{ node: 'Firecrawl', type: 'main', index: 0 }]
  ] },
  'Firecrawl': { main: [[{ node: 'Firecrawl OK?', type: 'main', index: 0 }]] },
  'Firecrawl OK?': { main: [
    [{ node: 'Prep doc', type: 'main', index: 0 }],
    [{ node: 'Log failure', type: 'main', index: 0 }]
  ] },
  'Prep doc': { main: [[{ node: 'Insert doc', type: 'main', index: 0 }]] },
  'Insert doc': { main: [[{ node: 'Run triage', type: 'main', index: 0 }]] },
  'Run triage': { main: [[{ node: 'Merge for stats', type: 'main', index: 0 }]] },
  'Log failure': { main: [[{ node: 'Merge for stats', type: 'main', index: 1 }]] },
  'Merge for stats': { main: [[{ node: 'Collect stats', type: 'main', index: 0 }]] },
  'Collect stats': { main: [[{ node: 'Finalize run', type: 'main', index: 0 }]] },
  'Finalize run': { main: [[{ node: 'Compose summary', type: 'main', index: 0 }]] },
  'Compose summary': { main: [[{ node: 'Telegram summary', type: 'main', index: 0 }]] },
  'Telegram summary': { main: [[{ node: 'Return summary', type: 'main', index: 0 }]] }
};

const workflow = {
  name: 'WF-20 process_urls',
  nodes, connections,
  settings: { executionOrder: 'v1' }
};

const out = path.join(__dirname, '..', 'workflows', 'wf20-process-urls.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
console.log('wrote', out);

// ---- WF-21 triage_one: one doc per execution (called per item by WF-20) ----
const wf21 = {
  name: 'WF-21 triage_one',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: [
        { name: 'triage_body', type: 'string' }, { name: 'raw_doc_id', type: 'string' },
        { name: 'canonical_url', type: 'string' }, { name: 'title', type: 'string' },
        { name: 'published_at', type: 'string' }, { name: 'run_id', type: 'string' } ] } } },

    // Every expression below assumes exactly one doc per execution. If WF-20's
    // Run triage ever reverts to mode 'once', fail loudly here instead of
    // silently attributing the whole batch to the first document.
    codeNode('Guard single item', 'guard', [100, 0], 'runOnceForAllItems', `
const n = $input.all().length;
if (n !== 1) throw new Error('WF-21 expects exactly 1 item per execution, received ' + n +
  ' — WF-20 "Run triage" must have mode: "each"');
return $input.all();
`.trim()),

    { id: 'triage', name: 'Triage', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [200, 0],
      parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
        authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.triage_body }}',
        options: { timeout: 120000 } },
      credentials: { httpBearerAuth: CRED_LM },
      retryOnFail: true, maxTries: 2, waitBetweenTries: 1000, onError: 'continueRegularOutput' },

    codeNode('Validate triage', 'validate1', [400, 0], 'runOnceForEachItem', VALIDATE_1),

    { id: 'triagevalid', name: 'Triage valid?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [600, 0],
      parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and', conditions: [ { id: 'c1', leftValue: '={{ Boolean($json.__invalid) }}', rightValue: false,
          operator: { type: 'boolean', operation: 'equals' } } ] } } },

    codeNode('Build retry', 'buildretry', [700, 120], 'runOnceForEachItem', BUILD_RETRY),

    { id: 'triage2', name: 'Triage retry', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [850, 120],
      parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
        authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.retry_body }}',
        options: { timeout: 120000 } },
      credentials: { httpBearerAuth: CRED_LM },
      retryOnFail: false, onError: 'continueRegularOutput' },

    codeNode('Validate retry', 'validate2', [1000, 120], 'runOnceForEachItem', VALIDATE_2),

    { id: 'mergetriage', name: 'Merge triaged', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [1200, 0],
      parameters: { mode: 'append', numberInputs: 2 } },

    // Atomic replace: clears any prior rows for this doc, then inserts the fresh
    // one. No-op on the normal path (new docs have none) and makes re-triage
    // idempotent, so the WF-30 drain never needs a separate delete step.
    pgNode('Insert feed', 'insertfeed', [1400, 0],
      "with del as (delete from feed_items where raw_doc_id = $1::bigint) insert into feed_items (raw_doc_id, canonical_url, title, summary, angle, relevance, tags, run_id, published_at, specificity, angle_strength, structured) values ($1::bigint, $2, nullif($3,''), $4, nullif($5,''), nullif($6::text,'')::int, $7::text[], $8::bigint, nullif($9,'')::timestamptz, nullif($10::text,'')::int, nullif($11::text,'')::int, nullif($12,'')::jsonb) returning id as feed_item_id",
      "={{ $json.raw_doc_id }},{{ $json.canonical_url }},{{ $json.title }},{{ $json.summary }},{{ $json.angle }},{{ $json.relevance }},{{ $json.tags_pg }},{{ $json.run_id }},{{ $json.published_at }},{{ $json.specificity }},{{ $json.angle_strength }},{{ $json.structured_json }}"),

    codeNode('Build embed', 'buildembed', [1600, 0], 'runOnceForAllItems', BUILD_EMBED),

    { id: 'embed', name: 'Embed', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1800, 0],
      parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/embeddings',
        authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.embed_body }}',
        options: { timeout: 60000 } },
      credentials: { httpBearerAuth: CRED_LM },
      retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput' },

    codeNode('Build vector update', 'buildvec', [2000, 0], 'runOnceForAllItems', BUILD_VECTOR_UPDATE),

    pgNode('Store embedding', 'storeembed', [2200, 0], '={{ $json.query }}', null,
      { onError: 'continueRegularOutput' })
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Guard single item', type: 'main', index: 0 }]] },
    'Guard single item': { main: [[{ node: 'Triage', type: 'main', index: 0 }]] },
    'Triage': { main: [[{ node: 'Validate triage', type: 'main', index: 0 }]] },
    'Validate triage': { main: [[{ node: 'Triage valid?', type: 'main', index: 0 }]] },
    'Triage valid?': { main: [
      [{ node: 'Merge triaged', type: 'main', index: 0 }],
      [{ node: 'Build retry', type: 'main', index: 0 }]
    ] },
    'Build retry': { main: [[{ node: 'Triage retry', type: 'main', index: 0 }]] },
    'Triage retry': { main: [[{ node: 'Validate retry', type: 'main', index: 0 }]] },
    'Validate retry': { main: [[{ node: 'Merge triaged', type: 'main', index: 1 }]] },
    'Merge triaged': { main: [[{ node: 'Insert feed', type: 'main', index: 0 }]] },
    'Insert feed': { main: [[{ node: 'Build embed', type: 'main', index: 0 }]] },
    'Build embed': { main: [[{ node: 'Embed', type: 'main', index: 0 }]] },
    'Embed': { main: [[{ node: 'Build vector update', type: 'main', index: 0 }]] },
    'Build vector update': { main: [[{ node: 'Store embedding', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};
const out21 = path.join(__dirname, '..', 'workflows', 'wf21-triage-one.json');
fs.writeFileSync(out21, JSON.stringify(wf21, null, 2));
console.log('wrote', out21);
