// Builds workflows/wf30-poller.json, embedding shared/cron-match.js into the
// evaluation Code node. Run: node scripts/build-wf30.js
const fs = require('fs');
const path = require('path');

const CRED_PG = { id: 'tzBuhu9KEXlaRRfW', name: 'Postgres account' };
const WF40_ID = '__WF40_ID__'; // substituted at deploy time

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
      } }
  ],
  connections: {
    'Every 5 min': { main: [[{ node: 'Get candidates', type: 'main', index: 0 }]] },
    'Get candidates': { main: [[{ node: 'Evaluate due', type: 'main', index: 0 }]] },
    'Evaluate due': { main: [[{ node: 'Mark fired', type: 'main', index: 0 }]] },
    'Mark fired': { main: [[{ node: 'Fire full sweep', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};

const out = path.join(__dirname, '..', 'workflows', 'wf30-poller.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
console.log('wrote', out);
