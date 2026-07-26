// Builds WF-00 agent_router. Emits:
//   workflows/wf00-agent-router.json  (committed, __TG_TOKEN__ placeholder)
//   <scratchpad>/wf00-deploy.json     (real token, deploy this) — pass dir as argv[2]
// Inbound Telegram uses getUpdates POLLING (no public webhook URL needed on this
// stack; the old ngrok tunnel is dead). Update ids dedupe through tg_updates.
const fs = require('fs');
const path = require('path');

const CRED_PG = { id: 'tzBuhu9KEXlaRRfW', name: 'Postgres account' };
const CRED_OR = { id: 'CZJ5Mo20Hr8BNBxG', name: 'openrouter-api' };
const CRED_TG = { id: '6RLwMp4ODoesGE4v', name: 'telegram-scout-bot' };
const CHAT_ID = '__TG_CHAT__';

const WF = {
  run_discovery: 'ccdGJn47aX7PHBti',
  full_sweep: 'du4KagpWdi5AT84v',
  scrape_url: 'fzgIhUYkPOaSdCUu',
  query_feed: 'VaA4YM6N4ni7F6CB',
  run_status: 'Ni3bddpEPN91ISg2',
  manage_schedule: 'GiJSUs1kqil1jtsp',
  manage_sources: 'qAGxheHskgw3Ki9A'
};

const SYSTEM = `=You are The Scout's dispatcher on Telegram. Route requests to tools; never do research yourself; never fabricate results or data — if a tool returns nothing, say so.

Rules:
1. Cheap and unambiguous requests run immediately, no confirmation: a pasted URL -> scrape_url; status questions -> run_status; reading existing findings -> query_feed; a search on a clearly named topic ('search around for X', 'anything on X') -> run_discovery with source brave, immediately.
2. Vague or conceptual digs ('what's happening with X', 'explore X', fuzzy themes) -> run_discovery with source exa, but ask a one-line confirmation first. full_sweep always needs confirmation. If the user's next message is an affirmative, execute what you proposed.
3. Questions about existing findings are ALWAYS query_feed or run_status — never trigger a new run for them. If the question names a time ('today', 'last night', 'this week'), compute the ISO timestamp for the start of that window from the current time below and pass it to query_feed as the since parameter. Never answer a time-scoped question from an unfiltered read.
4. When uncertain between search sources, fail WIDE: prefer full_sweep (with confirmation) or brave. Never guess narrow.
4b. Call at most ONE discovery tool per user request. After full_sweep or run_discovery returns, summarize its result and stop — do not chain additional searches on your own.
5. manage_schedule: parse natural language into cron, timezone Asia/Dhaka (UTC+6). 'every day at 8am' -> cron '0 8 * * *' via action create_recurring. Relative one-times ('in 3 hours') -> action create_onetime with an ISO timestamp you compute from the current time below. If phrasing is ambiguous ('tomorrow morning'), ask ONE clarifying question. Always echo the parsed schedule back and get a yes before creating. Other actions: cancel (needs id), list.
6. manage_sources actions: add (url, optional label), remove (id or url), list.
7. Reply tersely — this is Telegram. Plain text, no markdown formatting.

Current time: {{ $now.setZone('Asia/Dhaka').toFormat('cccc yyyy-MM-dd HH:mm') }} (Asia/Dhaka, UTC+6). This is the local date and time — use it directly, do not convert it.`;

function tool(name, description, workflowId, inputs, pos) {
  const value = {};
  const schema = [];
  for (const [field, spec] of Object.entries(inputs)) {
    // 4th $fromAI arg = default: without it the model MUST supply every param
    // (omitting one hard-fails the tool call with a schema error)
    value[field] = spec.fixed !== undefined ? spec.fixed
      : "={{ $fromAI('" + field + "', '" + spec.desc.replace(/'/g, "\\'") + "', 'string', '') }}";
    schema.push({ id: field, displayName: field, required: false, defaultMatch: false,
      display: true, canBeUsedToMatch: true, type: 'string' });
  }
  return {
    id: 'tool_' + name, name, type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2, position: pos,
    parameters: {
      description,
      workflowId: { __rl: true, value: workflowId, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value, matchingColumns: [], schema }
    }
  };
}

const nodes = [
  { id: 'poll', name: 'Poll updates', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
    parameters: { rule: { interval: [ { field: 'seconds', secondsInterval: 20 } ] } } },

  { id: 'offset', name: 'Get offset', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [180, 0],
    parameters: { operation: 'executeQuery',
      query: 'select coalesce(max(update_id), 0) + 1 as tg_offset from tg_updates', options: {} },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },

  { id: 'fetch', name: 'Fetch updates', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [360, 0],
    parameters: { method: 'GET',
      url: "=https://api.telegram.org/bot__TG_TOKEN__/getUpdates?offset={{ $json.tg_offset || 1 }}&timeout=0",
      options: { timeout: 10000 } },
    retryOnFail: false, onError: 'continueRegularOutput' },

  { id: 'extract', name: 'Extract messages', type: 'n8n-nodes-base.code', typeVersion: 2, position: [540, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const j = $input.first().json;
if (!j.ok || !Array.isArray(j.result)) return [];
const out = [];
for (const u of j.result) {
  const m = u.message || u.edited_message || {};
  out.push({ json: {
    update_id: u.update_id,
    chat_id: (m.chat && m.chat.id) || 0,
    text: (m.text || '').slice(0, 4000)
  } });
}
return out;`.trim() } },

  // atomic dedupe: only rows actually inserted flow onward
  { id: 'record', name: 'Record update', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [720, 0],
    parameters: { operation: 'executeQuery',
      query: 'insert into tg_updates (update_id, chat_id, text) values ($1::bigint, $2::bigint, $3) on conflict (update_id) do nothing returning update_id, chat_id, text',
      options: { queryReplacement: '={{ $json.update_id }},{{ $json.chat_id }},{{ $json.text }}' } },
    credentials: { postgres: CRED_PG } },

  { id: 'allow', name: 'Allowlisted?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [900, 0],
    parameters: { options: {}, conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      combinator: 'and',
      conditions: [
        { id: 'a1', leftValue: '={{ String($json.chat_id) }}', rightValue: CHAT_ID, operator: { type: 'string', operation: 'equals' } },
        { id: 'a2', leftValue: '={{ ($json.text || "").length }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } }
      ] } } },

  // ZZ test entry — same agent, returns the reply in the webhook response
  { id: 'testwh', name: 'Test webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [720, 200],
    parameters: { httpMethod: 'POST', path: 'scout-router-test-__ZZ_SECRET__', responseMode: 'lastNode', options: {} } },

  { id: 'testnorm', name: 'Test normalize', type: 'n8n-nodes-base.code', typeVersion: 2, position: [900, 200],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const b = $input.first().json.body || {};
return [{ json: { chat_id: Number(b.chat_id) || ${CHAT_ID}, text: String(b.text || ''), test: true } }];`.trim() } },

  // Deterministic switch, handled before the LLM: no tokens, no mis-routing,
  // and it keeps the router at the 7 tools the spec caps it at.
  { id: 'iscmd', name: 'Feed switch?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1060, 100],
    parameters: { options: {}, conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
      combinator: 'and',
      conditions: [ { id: 'k1',
        leftValue: "={{ ($json.text || '').trim().toLowerCase().replace(/[.!]+$/, '') }}",
        rightValue: '^(fix|stop) feed$',
        operator: { type: 'string', operation: 'regex' } } ] } } },

  { id: 'toggle', name: 'Toggle drain', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1240, -60],
    parameters: { operation: 'executeQuery',
      // Switching OFF also mutes the backlog notice for a week — an explicit
      // "stop feed" means stop asking, not ask again in six hours.
      query: "with t as (insert into settings (key, value, updated_at) values ('drain_enabled', $1, now()) on conflict (key) do update set value = excluded.value, updated_at = now() returning value), m as (insert into notices (kind, last_sent) select 'feed_backlog', now() + interval '7 days' where $1 = 'false' on conflict (kind) do update set last_sent = now() + interval '7 days') select (select value from t) as value, (select count(*) from (select rd.id from raw_docs rd left join feed_items f on f.raw_doc_id = rd.id group by rd.id having count(f.id) <> 1) a) as backlog_total",
      options: { queryReplacement: "={{ ($json.text || '').trim().toLowerCase().startsWith('fix') ? 'true' : 'false' }}" } },
    credentials: { postgres: CRED_PG } },

  { id: 'switchreply', name: 'Switch reply', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1420, -60],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const r = $input.first().json;
const n = Number(r.backlog_total) || 0;
const on = String(r.value) === 'true';
let text;
if (on && n === 0) text = "Nothing to fix — every saved page already has a summary.";
else if (on) text = "On it. Working through " + n + " page" + (n === 1 ? '' : 's') +
  ", about " + Math.max(1, Math.round(n * 20 / 60)) + " min while your PC stays on. Say \\"stop feed\\" to stop.";
else text = "Stopped. I won't bring it up again — say \\"fix feed\\" whenever you want.";
let chat_id = ${CHAT_ID};
try { chat_id = $('Record update').first().json.chat_id || chat_id; } catch (e) {
  try { chat_id = $('Test normalize').first().json.chat_id || chat_id; } catch (e2) {}
}
return [{ json: { chat_id, output: text } }];
`.trim() } },

  { id: 'agent', name: 'Scout Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [1120, 100],
    parameters: { promptType: 'define', text: '={{ $json.text }}',
      options: { systemMessage: SYSTEM, maxIterations: 6 } } },

  { id: 'model', name: 'OpenRouter Haiku', type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, position: [1000, 320],
    parameters: { model: 'anthropic/claude-haiku-4.5', options: { temperature: 0 } },
    credentials: { openRouterApi: CRED_OR } },

  { id: 'memory', name: 'Chat memory', type: '@n8n/n8n-nodes-langchain.memoryPostgresChat', typeVersion: 1.3, position: [1160, 320],
    parameters: { sessionIdType: 'customKey', sessionKey: '={{ $json.chat_id }}', contextWindowLength: 10 },
    credentials: { postgres: CRED_PG } },

  tool('run_discovery',
    "Run ONE search source now. Params: source (exa|tavily|brave|rss), query. exa = conceptual or thematic digs ('explore', 'dig into', fuzzy themes). tavily = a specific named topic. brave = broad general sweep ('anything on X', 'search around for'). rss = recency from known feeds ('anything new today'). Does NOT read past results.",
    WF.run_discovery,
    { source: { desc: 'one of exa, tavily, brave, rss' },
      query: { desc: 'the search query (empty for rss)' },
      trigger: { fixed: 'agent' } }, [1300, 320]),

  tool('full_sweep',
    "Run ALL discovery sources (exa, tavily, brave, rss). Only for 'sweep', 'go wide', 'full run'. Expensive — always confirm with the user first. Only call after the user has confirmed.",
    WF.full_sweep,
    { query: { desc: 'optional focus query; empty string runs the default sweep' },
      trigger: { fixed: 'agent' } }, [1440, 320]),

  tool('scrape_url',
    'Ingest one URL the user pasted. Use whenever the message contains a link. Cheap — execute immediately, no confirmation.',
    WF.scrape_url,
    { url: { desc: 'the full URL to scrape' },
      trigger: { fixed: 'agent' } }, [1580, 320]),

  tool('query_feed',
    "Read EXISTING triaged results. Use for 'what did you find', 'show me', 'anything good last night'. NEVER triggers a new run. " +
    "CRITICAL: if the question implies ANY time window — today, tonight, last night, this morning, yesterday, this week, recently, just now — you MUST pass `since` as an ISO timestamp you compute from the current time given above. Omitting it returns the whole archive, and you will report old items as if they were new. " +
    "Only omit `since` for questions with no time element at all ('show me the best stuff', 'anything on agents'). " +
    "Items are scored on two axes: specificity (1-5, how concrete and verifiable the claims are — vendor SEO content scores low) and angle_strength (1-5, how non-obvious the publishable hook is). score = the two added, 2-10. Use min_score 7+ for 'the good stuff', 8+ for 'only the best'. " +
    "Quality and recency are separate knobs and combine freely: min_score filters how good, max_age_days filters how fresh. 'anything good this week' = min_score 7 + max_age_days 7. Results always come back best-first. " +
    "Params: max_age_days (days since publication), min_score (2-10), since (ISO timestamp, for an exact cutoff), tag, limit (default 20), min_relevance (legacy, leave empty).",
    WF.query_feed,
    { max_age_days: { desc: 'only items published within this many days, empty for any age' },
      min_score: { desc: 'minimum combined score 2-10, empty for none' },
      since: { desc: 'ISO timestamp lower bound, empty for none' },
      tag: { desc: 'single lowercase tag to filter by, empty for none' },
      limit: { desc: 'max items to return, empty for default 20' },
      min_relevance: { desc: 'legacy 1-5 filter, leave empty' } }, [1720, 320]),

  tool('run_status',
    "Report recent runs: when, scope, counts, ok/partial/failed. Use for 'did last night's run work', 'when did you last run', 'did anything break'.",
    WF.run_status,
    { limit: { desc: 'how many recent runs to return, empty for default 5' } }, [1860, 320]),

  tool('manage_schedule',
    "Create, cancel or list schedules. Params: action (create_recurring|create_onetime|cancel|list); cron (for create_recurring, 5-field, Asia/Dhaka); run_at (for create_onetime, ISO timestamp); label; id (for cancel). Echo the parsed schedule back for confirmation BEFORE calling create.",
    WF.manage_schedule,
    { action: { desc: 'create_recurring, create_onetime, cancel, or list' },
      cron: { desc: '5-field cron expression for create_recurring, else empty' },
      run_at: { desc: 'ISO timestamp for create_onetime, else empty' },
      label: { desc: 'short human label for the schedule, optional' },
      id: { desc: 'schedule id for cancel, else empty' } }, [2000, 320]),

  tool('manage_sources',
    "Add, remove or list RSS feeds. Use for 'add this feed', 'stop following X', 'what feeds are you watching'. Params: action (add|remove|list); url (for add/remove); label (optional); id (for remove).",
    WF.manage_sources,
    { action: { desc: 'add, remove, or list' },
      url: { desc: 'feed URL for add or remove, else empty' },
      label: { desc: 'short label for the feed, optional' },
      id: { desc: 'source id for remove, else empty' } }, [2140, 320]),

  { id: 'prepreply', name: 'Prep reply', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1400, 100],
    parameters: { mode: 'runOnceForEachItem', jsCode: `
let chat_id = ${CHAT_ID};
try { chat_id = $('Record update').item.json.chat_id || chat_id; } catch (e) {
  try { chat_id = $('Test normalize').item.json.chat_id || chat_id; } catch (e2) {}
}
// Telegram node sends parse_mode HTML — escape or any < > & kills the send.
// Also strip markdown the model emits despite instructions: under HTML mode
// **bold** and _italics_ would show up as literal punctuation.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const demd = (s) => String(s)
  .replace(/\\*\\*(.+?)\\*\\*/g, '$1')
  .replace(/(^|\\s)\\*(?!\\s)(.+?)(?<!\\s)\\*(?=\\s|$)/g, '$1$2')
  .replace(/(^|\\s)_(?!\\s)(.+?)(?<!\\s)_(?=\\s|$)/g, '$1$2')
  .replace(/^\\s{0,3}#{1,6}\\s+/gm, '');
return { json: { chat_id, output: esc(demd(String($json.output || '').slice(0, 4000))) || '(empty reply)' } };`.trim() } },

  { id: 'reply', name: 'Send reply', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [1600, 100],
    parameters: { chatId: '={{ $json.chat_id }}', text: '={{ $json.output }}',
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' } },
    credentials: { telegramApi: CRED_TG },
    onError: 'continueRegularOutput' }
];

const connections = {
  'Poll updates': { main: [[{ node: 'Get offset', type: 'main', index: 0 }]] },
  'Get offset': { main: [[{ node: 'Fetch updates', type: 'main', index: 0 }]] },
  'Fetch updates': { main: [[{ node: 'Extract messages', type: 'main', index: 0 }]] },
  'Extract messages': { main: [[{ node: 'Record update', type: 'main', index: 0 }]] },
  'Record update': { main: [[{ node: 'Allowlisted?', type: 'main', index: 0 }]] },
  'Allowlisted?': { main: [
    [{ node: 'Feed switch?', type: 'main', index: 0 }],
    []
  ] },
  'Test webhook': { main: [[{ node: 'Test normalize', type: 'main', index: 0 }]] },
  'Test normalize': { main: [[{ node: 'Feed switch?', type: 'main', index: 0 }]] },
  'Feed switch?': { main: [
    [{ node: 'Toggle drain', type: 'main', index: 0 }],
    [{ node: 'Scout Agent', type: 'main', index: 0 }]
  ] },
  'Toggle drain': { main: [[{ node: 'Switch reply', type: 'main', index: 0 }]] },
  'Switch reply': { main: [[{ node: 'Send reply', type: 'main', index: 0 }]] },
  'OpenRouter Haiku': { ai_languageModel: [[{ node: 'Scout Agent', type: 'ai_languageModel', index: 0 }]] },
  'Chat memory': { ai_memory: [[{ node: 'Scout Agent', type: 'ai_memory', index: 0 }]] },
  'run_discovery': { ai_tool: [[{ node: 'Scout Agent', type: 'ai_tool', index: 0 }]] },
  'full_sweep': { ai_tool: [[{ node: 'Scout Agent', type: 'ai_tool', index: 0 }]] },
  'scrape_url': { ai_tool: [[{ node: 'Scout Agent', type: 'ai_tool', index: 0 }]] },
  'query_feed': { ai_tool: [[{ node: 'Scout Agent', type: 'ai_tool', index: 0 }]] },
  'run_status': { ai_tool: [[{ node: 'Scout Agent', type: 'ai_tool', index: 0 }]] },
  'manage_schedule': { ai_tool: [[{ node: 'Scout Agent', type: 'ai_tool', index: 0 }]] },
  'manage_sources': { ai_tool: [[{ node: 'Scout Agent', type: 'ai_tool', index: 0 }]] },
  'Scout Agent': { main: [[{ node: 'Prep reply', type: 'main', index: 0 }]] },
  'Prep reply': { main: [[{ node: 'Send reply', type: 'main', index: 0 }]] }
};

const workflow = { name: 'WF-00 agent_router', nodes, connections,
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' } };

const repoOut = path.join(__dirname, '..', 'workflows', 'wf00-agent-router.json');
fs.writeFileSync(repoOut, JSON.stringify(workflow, null, 2));
console.log('wrote', repoOut);

const deployDir = process.argv[2];
if (deployDir) {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const token = (env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m) || [])[1];
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not in .env');
  const deployOut = path.join(deployDir, 'wf00-deploy.json');
  fs.writeFileSync(deployOut, JSON.stringify(workflow).replaceAll('__TG_TOKEN__', token));
  console.log('wrote', deployOut);
}
