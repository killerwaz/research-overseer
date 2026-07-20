// Builds workflows/wf20-process-urls.json (spec §5.2).
// Run: node scripts/build-wf20.js
const fs = require('fs');
const path = require('path');

const CRED_PG = { id: 'tzBuhu9KEXlaRRfW', name: 'Postgres account' };
const CRED_CRAWL = { id: 'avVVOMOhNmIhsK5n', name: 'crawl4ai-bearer' };
const CRED_LM = { id: 'JsTIc0R9trd31PsV', name: 'lmstudio-bearer' };

// NOTE: no URL/URLSearchParams in the n8n task-runner sandbox — manual parsing only.
const CANONICALIZE = `
const STRIP = /^(utm_.*|fbclid|gclid|ref|source|mc_cid|mc_eid|igshid)$/i;
let lastErr = null;
function canon(rawUrl) {
  try {
    const s = String(rawUrl).trim();
    const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\\/\\/([^/?#]+)([^?#]*)(\\?[^#]*)?(#.*)?$/);
    if (!m) { lastErr = 'unparseable: ' + s.slice(0, 100); return null; }
    const scheme = m[1].toLowerCase();
    let hostport = m[2];
    let path = m[3] || '/';
    const query = m[4] ? m[4].slice(1) : '';
    let userinfo = '';
    const at = hostport.lastIndexOf('@');
    if (at !== -1) { userinfo = hostport.slice(0, at + 1); hostport = hostport.slice(at + 1); }
    let host = hostport;
    let port = '';
    const ci = hostport.lastIndexOf(':');
    if (ci !== -1 && /^\\d+$/.test(hostport.slice(ci + 1))) { host = hostport.slice(0, ci); port = hostport.slice(ci); }
    host = host.toLowerCase();
    if (host.startsWith('amp.')) host = host.slice(4);
    if ((scheme === 'http' && port === ':80') || (scheme === 'https' && port === ':443')) port = '';
    path = path.replace(/\\/amp(\\/|$)/, '$1');
    path = path.replace(/\\/{2,}/g, '/');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (!path) path = '/';
    const params = query ? query.split('&').filter(p => p !== '' && !STRIP.test(p.split('=')[0])) : [];
    const qs = params.length ? '?' + params.join('&') : '';
    return scheme + '://' + userinfo + host + port + path + qs;
  } catch (e) { lastErr = String(e); return null; }
}
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
let reason = 'empty_or_short_markdown';
if ($json.error) reason = 'scrape_error: ' + (typeof $json.error === 'object' ? JSON.stringify($json.error) : String($json.error)).slice(0, 200);
else if ($json.results && $json.results[0] && $json.results[0].error_message) reason = 'crawl4ai: ' + String($json.results[0].error_message).slice(0, 200);
return { json: { failed: true, url: orig.url, canonical_url: orig.canonical_url, reason, run_id: orig.run_id } };
`.trim();

const PREP_DOC = `
const orig = $('Filter new').item.json;
const r = ($json.results && $json.results[0]) || {};
const md = r.markdown || {};
const fit = (typeof md === 'object' ? md.fit_markdown : md) || '';
const raw = (typeof md === 'object' ? md.raw_markdown : '') || '';
const markdown = fit.length >= 400 ? fit : raw;
const title = (r.metadata && r.metadata.title) || orig.title || '';
const sys = __TRIAGE_SYSTEM__;
const user = 'TITLE: ' + title + '\\n' + 'URL: ' + orig.canonical_url + '\\n\\nCONTENT:\\n' + markdown.slice(0, 6000);
const triage_body = JSON.stringify({ model: 'qwen/qwen3.5-9b', temperature: 0.2, max_tokens: 1200,
  response_format: __TRIAGE_SCHEMA__,
  messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ] });
return { json: { canonical_url: orig.canonical_url, source: orig.source || '', title,
  markdown, run_id: orig.run_id, triage_body } };
`.trim();

const BUILD_RETRY = `
const prep = $('Prep doc').item.json;
const base = JSON.parse(prep.triage_body);
let prev = 'no output';
try { prev = $('Triage').item.json.choices[0].message.content || 'no output'; } catch (e) {}
base.messages.push({ role: 'assistant', content: String(prev).slice(0, 2000) });
base.messages.push({ role: 'user', content: 'Your previous output was not valid JSON matching the required schema. Return ONLY the JSON object with fields summary, angle, relevance, tags.' });
return { json: { retry_body: JSON.stringify(base) } };
`.trim();

const TRIAGE_SYSTEM = 'You are a research triage assistant. You read one scraped article and return ONLY a JSON object with exactly these fields: summary (2-3 sentence summary of the article substance), angle (one sentence - the content angle or hook that makes this usable for research/writing, or null), relevance (integer 1-5, 5 = directly useful now, 1 = noise), tags (array of 1-5 short lowercase topic tags). Return nothing except the JSON object.';

const TRIAGE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'triage', strict: true,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        angle: { type: ['string', 'null'] },
        relevance: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 }
      },
      required: ['summary', 'angle', 'relevance', 'tags'],
      additionalProperties: false
    }
  }
};

// Triage request bodies are prebuilt in Code nodes (Prep doc / Build retry) because
// n8n expressions reject multi-statement code. Substitute the constants into PREP_DOC.
const PREP_DOC_FINAL = PREP_DOC
  .replace('__TRIAGE_SYSTEM__', JSON.stringify(TRIAGE_SYSTEM))
  .replace('__TRIAGE_SCHEMA__', JSON.stringify(TRIAGE_SCHEMA));

const VALIDATE_COMMON = `
function parseContent(j) {
  try {
    let c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c) return null;
    c = c.trim().replace(/^\\\`\\\`\\\`(json)?/i, '').replace(/\\\`\\\`\\\`$/, '').trim();
    const o = JSON.parse(c);
    if (o && typeof o.summary === 'string' && Number.isInteger(o.relevance) &&
        o.relevance >= 1 && o.relevance <= 5 && Array.isArray(o.tags) && o.tags.length >= 1) return o;
    return null;
  } catch (e) { return null; }
}
function tagsPg(tags) {
  const clean = (tags || []).slice(0, 5).map(t => String(t).toLowerCase().replace(/[{}",\\\\]/g, '').trim()).filter(Boolean);
  return '{' + clean.join(',') + '}';
}
const doc = $('Prep doc').item.json;
const rawDocId = $('Insert doc').item.json.raw_doc_id;
`.trim();

const VALIDATE_1 = VALIDATE_COMMON + `
const o = parseContent($json);
if (!o) return { json: { __invalid: true } };
return { json: { __invalid: false, raw_doc_id: rawDocId, canonical_url: doc.canonical_url, title: doc.title,
  summary: o.summary, angle: o.angle || '', relevance: o.relevance, tags_pg: tagsPg(o.tags), run_id: doc.run_id } };
`;

const VALIDATE_2 = VALIDATE_COMMON + `
const o = parseContent($json);
if (!o) return { json: { raw_doc_id: rawDocId, canonical_url: doc.canonical_url, title: doc.title,
  summary: 'TRIAGE_FAILED', angle: '', relevance: '', tags_pg: '{}', run_id: doc.run_id } };
return { json: { raw_doc_id: rawDocId, canonical_url: doc.canonical_url, title: doc.title,
  summary: o.summary, angle: o.angle || '', relevance: o.relevance, tags_pg: tagsPg(o.tags), run_id: doc.run_id } };
`;

const COLLECT_STATS = `
const runId = $('Create run').first().json.run_id;
const found = ($('WF Input').first().json.urls || []).length;
let fresh = 0; try { fresh = $('Filter new').all().map(i => i.json).filter(j => !j.__no_new).length; } catch (e) {}
let scraped = 0; try { scraped = $('Insert doc').all().length; } catch (e) {}
let created = 0; try { created = $('Insert feed').all().length; } catch (e) {}
let fails = []; try { fails = $('Log failure').all().map(i => i.json.url + ' (' + i.json.reason + ')'); } catch (e) {}
const status = fails.length ? (scraped ? 'partial' : 'failed') : 'ok';
return [{ json: { run_id: runId, status: fresh === 0 && !fails.length ? 'ok' : status,
  urls_new: fresh, urls_scraped: scraped, items_created: created, error: fails.join('; ').slice(0, 2000) } }];
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
      { name: 'urls', type: 'array' }, { name: 'trigger', type: 'string' }, { name: 'scope', type: 'string' } ] } } },

  pgNode('Create run', 'createrun', [200, 0],
    "insert into runs (trigger, scope, urls_found) values ($1, $2, $3::int) returning id as run_id",
    "={{ $json.trigger }},{{ $json.scope }},{{ ($json.urls || []).length }}",
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
      sendBody: true, specifyBody: 'json', jsonBody: CRAWL_BODY, options: { timeout: 10000 } },
    credentials: { httpBearerAuth: CRED_CRAWL },
    retryOnFail: true, maxTries: 2, waitBetweenTries: 1000, onError: 'continueRegularOutput' },

  { id: 'scrapeok', name: 'Scrape OK?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1600, -100],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      combinator: 'and', conditions: [ { id: 'c1',
        leftValue: "={{ ($json.results?.[0]?.markdown?.fit_markdown || $json.results?.[0]?.markdown?.raw_markdown || '').length }}",
        rightValue: 400, operator: { type: 'number', operation: 'gte' } } ] } } },

  codeNode('Log failure', 'logfail', [1800, 100], 'runOnceForEachItem', LOG_FAILURE),
  codeNode('Prep doc', 'prepdoc', [1800, -200], 'runOnceForEachItem', PREP_DOC_FINAL),

  pgNode('Insert doc', 'insertdoc', [2000, -200],
    "with s as (insert into seen_urls (canonical_url, source) values ($1, nullif($2,'')) on conflict (canonical_url) do nothing) insert into raw_docs (canonical_url, title, markdown, scraper, run_id) values ($1, nullif($3,''), $4, 'crawl4ai', $5::bigint) returning id as raw_doc_id",
    "={{ $json.canonical_url }},{{ $json.source }},{{ $json.title }},{{ $json.markdown }},{{ $json.run_id }}"),

  { id: 'triage', name: 'Triage', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2200, -200],
    parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: "={{ $('Prep doc').item.json.triage_body }}", options: { timeout: 90000 } },
    credentials: { httpBearerAuth: CRED_LM },
    retryOnFail: true, maxTries: 2, waitBetweenTries: 1000, onError: 'continueRegularOutput' },

  codeNode('Validate triage', 'validate1', [2400, -200], 'runOnceForEachItem', VALIDATE_1),

  { id: 'triagevalid', name: 'Triage valid?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [2600, -200],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      combinator: 'and', conditions: [ { id: 'c1', leftValue: '={{ Boolean($json.__invalid) }}', rightValue: false,
        operator: { type: 'boolean', operation: 'equals' } } ] } } },

  codeNode('Build retry', 'buildretry', [2700, -100], 'runOnceForEachItem', BUILD_RETRY),

  { id: 'triage2', name: 'Triage retry', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2850, -100],
    parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.retry_body }}', options: { timeout: 90000 } },
    credentials: { httpBearerAuth: CRED_LM },
    retryOnFail: false, onError: 'continueRegularOutput' },

  codeNode('Validate retry', 'validate2', [3000, -100], 'runOnceForEachItem', VALIDATE_2),

  { id: 'mergetriage', name: 'Merge triaged', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [3200, -200],
    parameters: { mode: 'append', numberInputs: 2 } },

  pgNode('Insert feed', 'insertfeed', [3400, -200],
    "insert into feed_items (raw_doc_id, canonical_url, title, summary, angle, relevance, tags, run_id) values ($1::bigint, $2, nullif($3,''), $4, nullif($5,''), nullif($6::text,'')::int, $7::text[], $8::bigint) returning id as feed_item_id",
    "={{ $json.raw_doc_id }},{{ $json.canonical_url }},{{ $json.title }},{{ $json.summary }},{{ $json.angle }},{{ $json.relevance }},{{ $json.tags_pg }},{{ $json.run_id }}"),

  { id: 'mergestats', name: 'Merge for stats', type: 'n8n-nodes-base.merge', typeVersion: 3, position: [3600, 0],
    parameters: { mode: 'append', numberInputs: 3 } },

  codeNode('Collect stats', 'stats', [3800, 0], 'runOnceForAllItems', COLLECT_STATS),

  pgNode('Finalize run', 'finalize', [4000, 0],
    "update runs set finished_at = now(), status = $2, urls_new = $3::int, urls_scraped = $4::int, items_created = $5::int, error = nullif($6,'') where id = $1::bigint returning id as run_id, status, urls_found, urls_new, urls_scraped, items_created, error",
    "={{ $json.run_id }},{{ $json.status }},{{ $json.urls_new }},{{ $json.urls_scraped }},{{ $json.items_created }},{{ $json.error }}",
    { executeOnce: true })
];

const connections = {
  'WF Input': { main: [[{ node: 'Create run', type: 'main', index: 0 }]] },
  'Create run': { main: [[{ node: 'Canonicalize', type: 'main', index: 0 }]] },
  'Canonicalize': { main: [[{ node: 'Build dedupe query', type: 'main', index: 0 }]] },
  'Build dedupe query': { main: [[{ node: 'Find seen', type: 'main', index: 0 }]] },
  'Find seen': { main: [[{ node: 'Filter new', type: 'main', index: 0 }]] },
  'Filter new': { main: [[{ node: 'Any new?', type: 'main', index: 0 }]] },
  'Any new?': { main: [
    [{ node: 'Scrape', type: 'main', index: 0 }],
    [{ node: 'Merge for stats', type: 'main', index: 2 }]
  ] },
  'Scrape': { main: [[{ node: 'Scrape OK?', type: 'main', index: 0 }]] },
  'Scrape OK?': { main: [
    [{ node: 'Prep doc', type: 'main', index: 0 }],
    [{ node: 'Log failure', type: 'main', index: 0 }]
  ] },
  'Prep doc': { main: [[{ node: 'Insert doc', type: 'main', index: 0 }]] },
  'Insert doc': { main: [[{ node: 'Triage', type: 'main', index: 0 }]] },
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
  'Insert feed': { main: [[{ node: 'Merge for stats', type: 'main', index: 0 }]] },
  'Log failure': { main: [[{ node: 'Merge for stats', type: 'main', index: 1 }]] },
  'Merge for stats': { main: [[{ node: 'Collect stats', type: 'main', index: 0 }]] },
  'Collect stats': { main: [[{ node: 'Finalize run', type: 'main', index: 0 }]] }
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
