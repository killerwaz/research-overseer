// Builds workflows/wf30-poller.json, embedding shared/cron-match.js into the
// evaluation Code node. Run: node scripts/build-wf30.js
const fs = require('fs');
const path = require('path');

const CRED_PG = { id: 'tzBuhu9KEXlaRRfW', name: 'Postgres account' };
const CRED_TG = { id: '6RLwMp4ODoesGE4v', name: 'telegram-scout-bot' };
const WF40_ID = '__WF40_ID__'; // substituted at deploy time
const WF21_ID = 'HISagmvZYi6O7N5u'; // triage_one
const CHAT_ID = '__TG_CHAT__';

const { TRIAGE_SYSTEM, TRIAGE_SCHEMA, TRIAGE_MODEL } = require('../shared/triage-config.js');

// Backlog = any scraped doc that does not have exactly one feed_item: either it
// was never triaged, or it carries stale rows from the mode:'once' fan-out bug.
// Yields entirely while a run is in flight so live triage never queues behind it.
const FIND_BACKLOG = `
with backlog as (
  select rd.id
  from raw_docs rd
  left join feed_items f on f.raw_doc_id = rd.id
  group by rd.id
  having count(f.id) <> 1
)
select rd.id as raw_doc_id,
       rd.canonical_url,
       coalesce(rd.title, '') as title,
       coalesce(to_char(rd.published_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), '') as published_at,
       coalesce(rd.run_id, 0) as run_id,
       left(rd.markdown, 6000) as markdown,
       (select count(*) from backlog) as backlog_total
from raw_docs rd
where rd.id in (select id from backlog)
  -- opt-in: does nothing at all unless the user switched it on ("fix feed")
  and (select value from settings where key = 'drain_enabled') = 'true'
  -- and never competes with a live run
  and not exists (
    select 1 from runs r
    where r.status = 'running' and r.started_at > now() - interval '15 minutes'
  )
order by rd.id
limit 12
`.trim();

// Backlog exists but the switch is off — ask once, then stay quiet for 6h.
const FIND_IDLE_BACKLOG = `
select (select count(*) from (
          select rd.id from raw_docs rd
          left join feed_items f on f.raw_doc_id = rd.id
          group by rd.id having count(f.id) <> 1
        ) a) as backlog_total,
       (select value from settings where key = 'drain_enabled') as drain_enabled
`.trim();

const BUILD_BODY = `
const sys = ${JSON.stringify(TRIAGE_SYSTEM)};
const schema = ${JSON.stringify(TRIAGE_SCHEMA)};
return $input.all().map(i => {
  const d = i.json;
  const user = 'TITLE: ' + (d.title || '') + '\\n' + 'URL: ' + d.canonical_url +
    '\\n\\nCONTENT:\\n' + (d.markdown || '');
  return { json: {
    raw_doc_id: d.raw_doc_id,
    canonical_url: d.canonical_url,
    title: d.title || '',
    published_at: d.published_at || '',
    run_id: d.run_id,
    triage_body: JSON.stringify({
      model: ${JSON.stringify(TRIAGE_MODEL)}, temperature: 0.2, max_tokens: 4000,
      response_format: schema,
      messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ]
    })
  } };
});
`.trim();

let cronLib = fs.readFileSync(path.join(__dirname, '..', 'shared', 'cron-match.js'), 'utf8');
cronLib = cronLib.slice(0, cronLib.indexOf('if (typeof module')); // strip exports

const EVAL = cronLib + `
const nowE = Math.floor(Date.now() / 1000);
const due = [];
for (const item of $input.all()) {
  const j = item.json || {};
  if (!j.id) continue;
  if (j.type === 'onetime') { due.push(j); continue; }
  if (j.type === 'recurring' && j.cron) {
    const lastE = j.last_run_e ? Number(j.last_run_e) : nowE - 330;
    const from = Math.max(lastE, nowE - 6 * 3600);
    if (cronFiredInWindow(j.cron, from, nowE)) due.push(j);
  }
}
return due.map(j => ({ json: { id: j.id, type: j.type, label: j.label || '' } }));
`;

const workflow = {
  name: 'WF-30 poller',
  nodes: [
    { id: 'sched', name: 'Every 5 min', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
      parameters: { rule: { interval: [ { field: 'minutes', minutesInterval: 5 } ] } } },

    { id: 'getdue', name: 'Get candidates', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [200, 0],
      parameters: { operation: 'executeQuery',
        query: "select id, type, cron, label, extract(epoch from last_run) as last_run_e from schedules where active and ((type = 'onetime' and run_at <= now()) or (type = 'recurring' and cron is not null))",
        options: {} },
      credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },

    { id: 'eval', name: 'Evaluate due', type: 'n8n-nodes-base.code', typeVersion: 2, position: [400, 0],
      parameters: { mode: 'runOnceForAllItems', jsCode: EVAL } },

    // last_run is stamped BEFORE firing so a >5min sweep cannot double-fire
    { id: 'mark', name: 'Mark fired', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [600, 0],
      parameters: { operation: 'executeQuery',
        query: "update schedules set last_run = now(), active = case when type = 'onetime' then false else active end where id = $1::bigint returning id",
        options: { queryReplacement: '={{ $json.id }}' } },
      credentials: { postgres: CRED_PG } },

    { id: 'fire', name: 'Fire full sweep', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [800, 0],
      parameters: {
        workflowId: { __rl: true, value: WF40_ID, mode: 'id' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: { query: '', trigger: 'schedule' },
          matchingColumns: [],
          schema: [
            { id: 'query', displayName: 'query', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
            { id: 'trigger', displayName: 'trigger', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
          ]
        },
        options: { waitForSubWorkflow: false }
      } },

    // ---- backlog drain (independent of scheduling) ----
    { id: 'findbacklog', name: 'Find backlog', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [200, 200],
      parameters: { operation: 'executeQuery', query: FIND_BACKLOG, options: {} },
      credentials: { postgres: CRED_PG }, alwaysOutputData: true },

    { id: 'hasbacklog', name: 'Has backlog?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [400, 200],
      parameters: { options: {}, conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [ { id: 'b1', leftValue: '={{ $json.raw_doc_id }}', rightValue: 0,
          operator: { type: 'number', operation: 'gt' } } ] } } },

    { id: 'buildbody', name: 'Build triage body', type: 'n8n-nodes-base.code', typeVersion: 2, position: [600, 140],
      parameters: { mode: 'runOnceForAllItems', jsCode: BUILD_BODY } },

    { id: 'draintriage', name: 'Drain triage', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [800, 140],
      parameters: {
        mode: 'each', // one doc per sub-workflow call — see WF-21 guard
        workflowId: { __rl: true, value: WF21_ID, mode: 'id' },
        workflowInputs: {
          mappingMode: 'defineBelow',
          value: {
            triage_body: '={{ $json.triage_body }}',
            raw_doc_id: '={{ $json.raw_doc_id }}',
            canonical_url: '={{ $json.canonical_url }}',
            title: '={{ $json.title }}',
            published_at: '={{ $json.published_at }}',
            run_id: '={{ $json.run_id }}'
          },
          matchingColumns: [],
          schema: ['triage_body', 'raw_doc_id', 'canonical_url', 'title', 'published_at', 'run_id']
            .map(f => ({ id: f, displayName: f, required: false, defaultMatch: false,
              display: true, canBeUsedToMatch: true, type: 'string' }))
        },
        options: { waitForSubWorkflow: true }
      },
      onError: 'continueRegularOutput' },

    { id: 'idlecheck', name: 'Check idle backlog', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [200, 320],
      parameters: { operation: 'executeQuery', query: FIND_IDLE_BACKLOG, options: {} },
      credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },

    { id: 'shouldask', name: 'Should ask?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [400, 320],
      parameters: { options: {}, conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        combinator: 'and',
        conditions: [
          { id: 's1', leftValue: '={{ Number($json.backlog_total) }}', rightValue: 0,
            operator: { type: 'number', operation: 'gt' } },
          { id: 's2', leftValue: '={{ String($json.drain_enabled) }}', rightValue: 'true',
            operator: { type: 'string', operation: 'notEquals' } }
        ] } } },

    // Fires at most once per 6h even though the condition persists across ticks
    { id: 'noticegate', name: 'Notice due?', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [600, 320],
      parameters: { operation: 'executeQuery',
        query: "insert into notices (kind, last_sent) values ('feed_backlog', now()) on conflict (kind) do update set last_sent = now() where notices.last_sent < now() - interval '6 hours' returning kind",
        options: {} },
      credentials: { postgres: CRED_PG }, executeOnce: true },

    { id: 'sendnotice', name: 'Send notice', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [800, 320],
      parameters: {
        chatId: CHAT_ID,
        text: "={{ $('Check idle backlog').first().json.backlog_total }} saved pages never got summarized, so they're missing from your feed.\n\nReply \"fix feed\" and I'll work through them. Reply \"stop feed\" any time to stop.",
        additionalFields: { appendAttribution: false, parse_mode: 'HTML' } },
      credentials: { telegramApi: CRED_TG },
      onError: 'continueRegularOutput' }
  ],
  connections: {
    'Every 5 min': { main: [[
      { node: 'Get candidates', type: 'main', index: 0 },
      { node: 'Find backlog', type: 'main', index: 0 },
      { node: 'Check idle backlog', type: 'main', index: 0 }
    ]] },
    'Find backlog': { main: [[{ node: 'Has backlog?', type: 'main', index: 0 }]] },
    'Has backlog?': { main: [[{ node: 'Build triage body', type: 'main', index: 0 }], []] },
    'Build triage body': { main: [[{ node: 'Drain triage', type: 'main', index: 0 }]] },
    'Check idle backlog': { main: [[{ node: 'Should ask?', type: 'main', index: 0 }]] },
    'Should ask?': { main: [[{ node: 'Notice due?', type: 'main', index: 0 }], []] },
    'Notice due?': { main: [[{ node: 'Send notice', type: 'main', index: 0 }]] },
    'Get candidates': { main: [[{ node: 'Evaluate due', type: 'main', index: 0 }]] },
    'Evaluate due': { main: [[{ node: 'Mark fired', type: 'main', index: 0 }]] },
    'Mark fired': { main: [[{ node: 'Fire full sweep', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};

const out = path.join(__dirname, '..', 'workflows', 'wf30-poller.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
console.log('wrote', out);
