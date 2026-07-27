// Builds workflows/wf34-manage-sources.json.
// Adding a feed now bootstraps it: whatever is already on the feed is recorded
// as seen, without scraping or triaging, so a new subscription never arrives as
// a page of "discoveries". Only items published after you subscribe get through.
const fs = require('fs');
const path = require('path');

const CRED_PG = { id: 'tzBuhu9KEXlaRRfW', name: 'Postgres account' };

const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
  .replace(/module\.exports[\s\S]*$/, '');

const COLLECT_SEEN = inline('canonicalize.js') + `
const src = $('Add source').first().json;
const seen = [];
for (const item of $input.all()) {
  const j = item.json || {};
  if (j.error) continue;
  const link = j.link || j.url;
  const c = link ? canon(link) : null;
  if (c) seen.push(c);
}
const uniq = [...new Set(seen)];
if (!uniq.length) return [{ json: { source_id: src.id, count: 0, values: '' } }];
const esc = (u) => String(u).replace(/'/g, "''");
// one multi-row VALUES list rather than a round trip per URL
const values = uniq.map(u => "('" + esc(u) + "','rss')").join(',');
return [{ json: { source_id: src.id, count: uniq.length, values } }];
`.trim();

const workflow = {
  name: 'WF-34 manage_sources',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: [
        { name: 'action', type: 'string' }, { name: 'url', type: 'string' },
        { name: 'label', type: 'string' }, { name: 'id', type: 'string' } ] } } },

    { id: 'switch', name: 'Action', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [200, 0],
      parameters: { rules: { values: ['add', 'remove', 'list'].map((a, i) => ({
        conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
          combinator: 'and',
          conditions: [{ id: 'c' + i, leftValue: '={{ $json.action }}', rightValue: a,
            operator: { type: 'string', operation: 'equals' } }] },
        renameOutput: true, outputKey: a })) }, options: {} } },

    { id: 'add', name: 'Add source', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [420, -160],
      parameters: { operation: 'executeQuery',
        query: "insert into sources (kind, url, label) values ('rss', $1, nullif($2,'')) on conflict (url) do update set active = true, label = coalesce(nullif($2,''), sources.label) returning id, url, label, active, coalesce(to_char(bootstrapped_at, 'YYYY-MM-DD'), '') as bootstrapped_at",
        options: { queryReplacement: "={{ $json.url }},{{ $json.label || '' }}" } },
      credentials: { postgres: CRED_PG } },

    { id: 'needsboot', name: 'Needs bootstrap?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [620, -160],
      parameters: { options: {}, conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [{ id: 'nb1', leftValue: '={{ $json.bootstrapped_at }}', rightValue: '',
          operator: { type: 'string', operation: 'equals' } }] } } },

    { id: 'readfeed', name: 'Read feed once', type: 'n8n-nodes-base.rssFeedRead', typeVersion: 1.2, position: [820, -240],
      parameters: { url: '={{ $json.url }}', options: {} },
      onError: 'continueRegularOutput', alwaysOutputData: true },

    { id: 'collect', name: 'Collect seen', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1020, -240],
      parameters: { mode: 'runOnceForAllItems', jsCode: COLLECT_SEEN } },

    // Marks the feed bootstrapped in the same statement that records the URLs,
    // so a failure here cannot leave it half-done and silently re-dump later.
    { id: 'recordseen', name: 'Record as seen', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1220, -240],
      parameters: { operation: 'executeQuery',
        query: "with ins as (insert into seen_urls (canonical_url, source) select v.u, v.s from (values {{ $json.values || \"('','')\" }}) as v(u,s) where v.u <> '' on conflict (canonical_url) do nothing) update sources set bootstrapped_at = now() where id = {{ $json.source_id }}::bigint returning id, url, label, active",
        options: {} },
      credentials: { postgres: CRED_PG } },

    { id: 'remove', name: 'Remove source', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [420, 0],
      parameters: { operation: 'executeQuery',
        query: "update sources set active = false where (nullif($1,'') is not null and id = nullif($1,'')::bigint) or (nullif($2,'') is not null and url = $2) returning id, url, label, active",
        options: { queryReplacement: "={{ $json.id || '' }},{{ $json.url || '' }}" } },
      credentials: { postgres: CRED_PG } },

    { id: 'list', name: 'List sources', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [420, 160],
      parameters: { operation: 'executeQuery',
        query: 'select id, url, label, active from sources order by id', options: {} },
      credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },

    { id: 'shape', name: 'Shape result', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1440, 0],
      parameters: { mode: 'runOnceForAllItems', jsCode: `
const rows = $input.all().map(i => i.json).filter(j => j && Object.keys(j).length);
let bootstrapped = null;
try { bootstrapped = $('Collect seen').first().json.count; } catch (e) {}
const out = { count: rows.length, result: rows };
if (bootstrapped !== null) {
  out.bootstrapped = bootstrapped;
  out.note = bootstrapped + ' existing items marked as already seen; only new posts from now on';
}
return [{ json: out }];
`.trim() } }
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Action', type: 'main', index: 0 }]] },
    'Action': { main: [
      [{ node: 'Add source', type: 'main', index: 0 }],
      [{ node: 'Remove source', type: 'main', index: 0 }],
      [{ node: 'List sources', type: 'main', index: 0 }]
    ] },
    'Add source': { main: [[{ node: 'Needs bootstrap?', type: 'main', index: 0 }]] },
    'Needs bootstrap?': { main: [
      [{ node: 'Read feed once', type: 'main', index: 0 }],
      [{ node: 'Shape result', type: 'main', index: 0 }]
    ] },
    'Read feed once': { main: [[{ node: 'Collect seen', type: 'main', index: 0 }]] },
    'Collect seen': { main: [[{ node: 'Record as seen', type: 'main', index: 0 }]] },
    'Record as seen': { main: [[{ node: 'Shape result', type: 'main', index: 0 }]] },
    'Remove source': { main: [[{ node: 'Shape result', type: 'main', index: 0 }]] },
    'List sources': { main: [[{ node: 'Shape result', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};

const out = path.join(__dirname, '..', 'workflows', 'wf34-manage-sources.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
console.log('wrote', out);
