// Builds workflows/wf46-deep-research.json. Run: node scripts/build-wf46.js
//
// Deep research (2026-10-19): "deep search: <question>" in Telegram -> WF-00 routes it
// here in code (shared/deep-trigger.js) and does not wait. One job at a time:
//   Has question? -> Deep lock (settings 'deep_running', expires after 16 min) -> Free?
//   -> Deep start ("🔬 Researching…") -> Deep run (ONE Code node: shared/deep-research.js,
//   ~6.5 min, edits the start message as it goes) -> Deep send (the answer, a new
//   message so it notifies) -> Deep memory (his question + the answer, frees the lock).
// Deep run needs N8N_RUNNERS_TASK_TIMEOUT=900 (docker/docker-compose.yml): the default
// stops any Code node at 300 s. It stops checking facts at 10 min so it always writes
// (a live run sharing the GPU with an eval took 12.4 min, 2026-10-19).
// Keys (__EXA_KEY__ ...) are filled in by scripts/deploy.js from .env; committed JSON
// never carries them. Called by WF-00 'Deep research'; must stay PUBLISHED.
const fs = require('fs');
const path = require('path');

const I = require('./ids.js').PLACEHOLDERS;
const CRED_PG = I.credentials.postgres;
const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8').replace(/module\.exports[\s\S]*$/, '');
const TG = 'https://api.telegram.org/bot__TG_TOKEN__/';

// One statement, the staleness check inside the conflict update: Postgres re-checks the WHERE on the
// locked row, so two jobs at once cannot both take it (a separate read-then-write let both through).
const LOCK_SQL = "with upd as (insert into settings (key, value, updated_at) values ('deep_running', now()::text, now()) " +
  "on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at " +
  "where coalesce(nullif(settings.value, ''), '1970-01-01')::timestamptz < now() - interval '16 minutes' returning 1) " +
  "select (select count(*) from upd) > 0 as ok, (select count(*) from upd) as took";

const PREP = inline('telegram-format.js') + `
const j = $input.first().json;
const q = String(j.question || '').trim(), chat = String(j.chat_id || '');
const short = q.length > 140 ? q.slice(0, 137) + '...' : q;
return [{ json: { question: q, text: String(j.text || q), chat_id: chat, has_q: String(q.length >= 8),
  ask: { chat_id: chat, text: 'Deep search on what? Send it with the question, e.g. "deep search: which startups are building on n8n?"' },
  busy: { chat_id: chat, text: '🔬 A deep search is already running. Send this again when its answer arrives (up to about 10 minutes).' },
  start: { chat_id: chat, parse_mode: 'HTML', text: '🔬 Researching: <i>' + escapeHtml(short) + '</i>\\nAbout 6 minutes. I will send the answer here.' } } }];`.trim();

const RUN = inline('deep-checks.js') + inline('deep-research.js') + inline('telegram-format.js') + `
const inp = $('Deep prep').first().json;
let statusId = null;
try { statusId = ($('Deep start').first().json.result || {}).message_id || null; } catch (e) {}
const helpers = this.helpers;
const TG = '${TG}';
// n8n has no fetch: every request in the pipeline goes through this
async function http(req) {
  const r = await helpers.httpRequest({ method: req.method, url: req.url, headers: req.headers || {}, body: req.body,
    json: true, timeout: req.timeout || 60000, returnFullResponse: true, ignoreHttpStatusErrors: true });
  return { status: r.statusCode, body: r.body };
}
const STAGES = 7;
let stage = 0;
const t0 = Date.now();
async function progress(text) {
  stage++;
  if (!statusId) return;
  const mins = Math.floor((Date.now() - t0) / 60000);
  try { await http({ method: 'POST', url: TG + 'editMessageText', body: { chat_id: inp.chat_id, message_id: statusId, parse_mode: 'HTML',
    text: '🔬 Researching: <i>' + escapeHtml(inp.question.slice(0, 140)) + '</i>\\n' + Math.min(stage, STAGES) + '/' + STAGES + ' ' + escapeHtml(text) + '…' + (mins ? ' (' + mins + ' min so far)' : '') }, timeout: 10000 }); } catch (e) {}
}
let r = null, failed = '';
try {
  r = await deepResearch(inp.question, { http, progress,
    keys: { exa: '__EXA_KEY__', brave: '__BRAVE_KEY__', firecrawl: '__FIRECRAWL_KEY__', lmstudio: '__LM_KEY__' },
    lmUrl: 'http://host.docker.internal:1234/v1/chat/completions',
    today: new Date().toISOString().slice(0, 10),
    deadline: t0 + 10 * 60000 });
} catch (e) { failed = String((e && e.message) || e).slice(0, 300); }
const mins = ((Date.now() - t0) / 60000).toFixed(1);
const reply = r ? r.reply : 'Sorry, the deep search failed before it could answer (' + failed + '). Try again in a few minutes.';
if (statusId) { try { await http({ method: 'POST', url: TG + 'editMessageText', body: { chat_id: inp.chat_id, message_id: statusId, parse_mode: 'HTML',
  text: (r ? '🔬 Researched in ' + mins + ' min. Answer below.' : '🔬 The deep search failed.') + '\\n<i>' + escapeHtml(inp.question.slice(0, 140)) + '</i>' }, timeout: 10000 }); } catch (e) {} }
// memory: his question and the answer (tagged, so the sweep/web follow-up readers skip it), then free the lock
const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');
const chat = String(inp.chat_id).replace(/[^0-9-]/g, '');
const plain = stripMarkdown(reply);
const memory_sql = /^-?\\d+$/.test(chat)
  ? "with h as (insert into n8n_chat_histories (session_id, message) values ('" + chat + "', jsonb_build_object('type', 'human', 'content', convert_from(decode('" + b64(inp.text) + "', 'base64'), 'UTF8'), 'additional_kwargs', '{}'::jsonb, 'response_metadata', '{}'::jsonb)) returning id), " +
    "a as (insert into n8n_chat_histories (session_id, message) select '" + chat + "', jsonb_build_object('type', 'ai', 'content', convert_from(decode('" + b64(plain) + "', 'base64'), 'UTF8'), 'tool_calls', '[]'::jsonb, 'invalid_tool_calls', '[]'::jsonb, 'additional_kwargs', jsonb_build_object('source', 'deep'), 'response_metadata', '{}'::jsonb) from h returning id), " +
    "u as (update settings set value = '', updated_at = now() where key = 'deep_running' returning 1) select (select id from a) as id"
  : "update settings set value = '', updated_at = now() where key = 'deep_running' returning 1 as ok";
const t = r ? r.trace : {};
return [{ json: { send: { chat_id: inp.chat_id, text: forTelegram(reply, 4000), parse_mode: 'HTML', disable_web_page_preview: true },
  memory_sql, failed, minutes: Number(mins), reply, sources: r ? r.sources : [],
  trace: { plan: t.plan, calls: t.calls, empty: t.empty, stages: t.stages, spend: t.spend, rulings: t.rulings, queries: t.queries, queries2: t.queries2,
    pages: t.pages, unchecked: t.unchecked, writeProblems: t.writeProblems, softened: t.softened, droppedOutOfScope: t.droppedOutOfScope, ruledOutShown: t.ruledOutShown, seconds: t.seconds } } }];`.trim();

const tg = (id, name, pos, method, body) => ({ id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  parameters: { method: 'POST', url: TG + method, sendBody: true, specifyBody: 'json', jsonBody: body, options: { timeout: 15000 } },
  retryOnFail: false, onError: 'continueRegularOutput' });
const iff = (id, name, pos, left) => ({ id, name, type: 'n8n-nodes-base.if', typeVersion: 2, position: pos,
  parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
    conditions: [{ id: id + '1', leftValue: left, rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } });

const wf = {
  name: 'WF-46 deep_research',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: [{ name: 'question', type: 'string' }, { name: 'text', type: 'string' }, { name: 'chat_id', type: 'string' }] } } },
    { id: 'prep', name: 'Deep prep', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { mode: 'runOnceForAllItems', jsCode: PREP } },
    iff('hasq', 'Has question?', [400, 0], '={{ $json.has_q }}'),
    tg('askwhat', 'Ask what', [600, 200], 'sendMessage', "={{ JSON.stringify($('Deep prep').first().json.ask) }}"),
    { id: 'lock', name: 'Deep lock', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [600, 0],
      parameters: { operation: 'executeQuery', query: LOCK_SQL, options: {} },
      credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },
    iff('free', 'Free?', [800, 0], '={{ String($json.ok) }}'),
    tg('busy', 'Busy', [1000, 200], 'sendMessage', "={{ JSON.stringify($('Deep prep').first().json.busy) }}"),
    tg('start', 'Deep start', [1000, 0], 'sendMessage', "={{ JSON.stringify($('Deep prep').first().json.start) }}"),
    { id: 'run', name: 'Deep run', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1200, 0], parameters: { mode: 'runOnceForAllItems', jsCode: RUN } },
    tg('send', 'Deep send', [1400, 0], 'sendMessage', '={{ JSON.stringify($json.send) }}'),
    { id: 'mem', name: 'Deep memory', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1600, 0],
      parameters: { operation: 'executeQuery', query: "={{ $('Deep run').first().json.memory_sql }}", options: {} },
      credentials: { postgres: CRED_PG }, alwaysOutputData: true, onError: 'continueRegularOutput' }
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Deep prep', type: 'main', index: 0 }]] },
    'Deep prep': { main: [[{ node: 'Has question?', type: 'main', index: 0 }]] },
    'Has question?': { main: [[{ node: 'Deep lock', type: 'main', index: 0 }], [{ node: 'Ask what', type: 'main', index: 0 }]] },
    'Deep lock': { main: [[{ node: 'Free?', type: 'main', index: 0 }]] },
    'Free?': { main: [[{ node: 'Deep start', type: 'main', index: 0 }], [{ node: 'Busy', type: 'main', index: 0 }]] },
    'Deep start': { main: [[{ node: 'Deep run', type: 'main', index: 0 }]] },
    'Deep run': { main: [[{ node: 'Deep send', type: 'main', index: 0 }]] },
    'Deep send': { main: [[{ node: 'Deep memory', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: I.workflows['wf99-error-workflow'] }
};

const out = path.join(__dirname, '..', 'workflows', 'wf46-deep-research.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
console.log('wrote', out);
