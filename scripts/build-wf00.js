// Builds WF-00 agent_router. Emits:
//   workflows/wf00-agent-router.json  (committed, __TG_TOKEN__ placeholder)
//   <scratchpad>/wf00-deploy.json     (real token, deploy this) — pass dir as argv[2]
// Inbound Telegram uses getUpdates POLLING (no public webhook URL needed on this
// stack; the old ngrok tunnel is dead). Update ids dedupe through tg_updates.
const fs = require('fs');
const path = require('path');

// Inlined from shared/ so the committed tests cover what actually ships.
const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
  .replace(/module\.exports[\s\S]*$/, '');

// Instance-local ids live in instance.json; personal values (chat id, webhook
// secret) stay out of the committed JSON entirely — deploy.js substitutes them.
const I = require('./instance.json');
const CRED_PG = I.credentials.postgres;
const CRED_OR = I.credentials.openrouter;
const CRED_TG = I.credentials.telegram;
const CHAT_ID = '__TG_CHAT__';

// Router model. Default is local Qwen in LM Studio (free); ROUTER_MODEL=haiku
// at build time switches back to paid Haiku over OpenRouter.
//
// Qwen only works here with thinking OFF: with thinking on it returns an empty
// reply after a tool result in most configurations (benched 2026-10-09; LM
// Studio bug class #1592). n8n's chat-model node cannot send the one field that
// switches thinking off (reasoning_effort 'none' — the node drops it for any
// model not named like o1/o3/gpt-5), so LM Studio's DEFAULT for this model must
// be thinking off, and triage opts back in (shared/triage-config.js). Chat
// Completions, not the Responses API: n8n sends `text: {}` on Responses, which
// LM Studio rejects ("text.format Required").
const ROUTER_MODEL = (process.env.ROUTER_MODEL || 'qwen').toLowerCase();
const MODEL_NODE = ROUTER_MODEL === 'haiku'
  ? { id: 'model', name: 'OpenRouter Haiku', type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, position: [1000, 320],
      parameters: { model: 'anthropic/claude-haiku-4.5', options: { temperature: 0 } },
      credentials: { openRouterApi: CRED_OR } }
  : { id: 'model', name: 'LM Studio Qwen', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.3, position: [1000, 320],
      parameters: { model: { __rl: true, mode: 'id', value: 'qwen/qwen3.5-9b' }, responsesApiEnabled: false,
        // first message after LM Studio's idle unload pays a ~19s model load
        options: { temperature: 0, timeout: 120000, maxRetries: 1 } },
      credentials: { openAiApi: I.credentials.lmstudio_openai } };

const WF = {
  run_discovery: I.workflows['wf41-run-discovery'],
  full_sweep: I.workflows['wf40-full-sweep'],
  scrape_url: I.workflows['wf42-scrape-url'],
  query_feed: I.workflows['wf31-query-feed'],
  run_status: I.workflows['wf32-run-status'],
  manage_sources: I.workflows['wf34-manage-sources']
};

const SYSTEM = `=You are Research Overseer's dispatcher on Telegram. Route requests to tools; never do research yourself; never fabricate results or data — if a tool returns nothing, say so.

Rules:
0. You know NOTHING about the feeds, runs or findings except what a tool returns in this conversation. Any question about them MUST call the matching tool first, every time — never answer from memory or general knowledge.
1. Free and instant actions run immediately, no confirmation: a pasted URL -> scrape_url; status questions -> run_status; 'what feeds/sources are you watching' -> manage_sources with action list; reading existing findings -> query_feed; 'anything new today' -> run_discovery with source rss. These touch nothing that costs money.
2. Anything that starts a web search costs money and about six minutes, so it needs the user's word first. Run it immediately ONLY if they used an explicit search verb (search, find me, look up, go get, dig into). If they merely asked a question — 'what's happening with X', 'anything on X', 'how is X going' — answer it from query_feed first (free), then end your reply with a one-line offer naming the search source and query you would run. Do NOT start the search; execute it on their next message if they say yes. full_sweep always needs confirmation.
3. Retrospective questions are ALWAYS query_feed or run_status, and this OVERRIDES everything else even when a topic is named. Retrospective phrasing includes: catch me up, what did you find, what's new, anything good, show me, what did I miss, brief me, recap. "Catch me up on funding this week" is query_feed with max_age_days 7 — NOT a search, and NOT a confirmation prompt either; just read the feed and answer.
3b. If a topic read comes back thin, retry query_feed once with fewer, broader keywords in tag. Never present items as being about the topic unless they are, and never answer a thin result by starting a search — say what the feed has and offer the search. If the question names a time ('today', 'last night', 'this week'), compute the ISO timestamp for the start of that window from the current time below and pass it to query_feed as the since parameter. Never answer a time-scoped question from an unfiltered read.
4. When uncertain between search sources, fail WIDE: prefer full_sweep (with confirmation) or brave. Never guess narrow.
4b. Call at most ONE discovery tool per user request, ever. After full_sweep or run_discovery returns, summarize what it returned and stop. If it found little, say so — do NOT run it again with different wording. Each run costs money and minutes.
5. Scheduling is OFF — this is a live chat agent; nothing runs on a timer. If asked to schedule, repeat, or run something later or every day, say scheduling is switched off and offer to run it now (searches still need their usual yes).
6. manage_sources actions: add (url, optional label), remove (id or url), list.
7. Reply tersely — this is Telegram. Plain text, no markdown formatting.

Feeds you are watching right now (read from the database this message — authoritative, the ONLY true list): {{ $json.sources }}

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
    parameters: { httpMethod: 'POST', path: 'overseer-router-test-__ZZ_SECRET__', responseMode: 'lastNode', options: {} } },

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
      // Switching OFF mutes the backlog notice for the standard 6h window.
      // WF-30 also clears the mute early when LM Studio comes back up, since
      // that is the moment the work becomes possible again.
      query: "with t as (insert into settings (key, value, updated_at) values ('drain_enabled', $1, now()) on conflict (key) do update set value = excluded.value, updated_at = now() returning value), m as (insert into notices (kind, last_sent) select 'feed_backlog', now() where $1 = 'false' on conflict (kind) do update set last_sent = now()) select (select value from t) as value, (select count(*) from (select rd.id from raw_docs rd left join feed_items f on f.raw_doc_id = rd.id group by rd.id having count(f.id) <> 1) a) as backlog_total",
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
else text = "Stopped. I'll leave it alone — say \\"fix feed\\" whenever you want.";
let chat_id = ${CHAT_ID};
try { chat_id = $('Record update').first().json.chat_id || chat_id; } catch (e) {
  try { chat_id = $('Test normalize').first().json.chat_id || chat_id; } catch (e2) {}
}
return [{ json: { chat_id, output: text } }];
`.trim() } },

  // Facts the model must not invent. Without thinking, the 9B answers "which
  // sources do you follow?" with a confident made-up list (benched 2026-10-09:
  // BBC, The Verge, Reuters...) however the rules are worded. Handing it the real
  // list each message removes the gap it fills. One cheap query per message.
  { id: 'ctx', name: 'Agent context', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1000, -100],
    parameters: { operation: 'executeQuery',
      query: "select coalesce((select string_agg(coalesce(nullif(label, ''), url) || ' <' || url || '>', '; ' order by id) from sources where active and kind = 'rss'), 'none') as sources",
      options: {} },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },

  // Re-attach the context to every message item (Feed switch? output 1 = not a
  // feed-switch command); chat memory keys on $json.chat_id, so it must survive.
  { id: 'ctxmerge', name: 'Agent input', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1060, 100],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const sources = ($('Agent context').first().json.sources) || 'none';
return $('Feed switch?').all(1).map(i => ({ json: { ...i.json, sources } }));`.trim() } },

  { id: 'agent', name: 'Overseer Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [1120, 100],
    parameters: { promptType: 'define', text: '={{ $json.text }}',
      options: { systemMessage: SYSTEM, maxIterations: 6 } } },

  MODEL_NODE,

  { id: 'memory', name: 'Chat memory', type: '@n8n/n8n-nodes-langchain.memoryPostgresChat', typeVersion: 1.3, position: [1160, 320],
    parameters: { sessionIdType: 'customKey', sessionKey: '={{ $json.chat_id }}', contextWindowLength: 10 },
    credentials: { postgres: CRED_PG } },

  tool('run_discovery',
    "Run ONE search source now. COSTS MONEY AND ~6 MINUTES. " +
    "Call it immediately ONLY when the user used an explicit search verb — search, find me, look up, go get, dig into, run a search. " +
    "For anything phrased as a question ('what's happening with X', 'anything on X', 'how is X going') do NOT call this tool: read query_feed instead and offer this search in one line. Call it on their next message only if they said yes. Asking costs one line; guessing wrong costs six minutes of their machine. " +
    "Params: source (exa|tavily|brave|rss), query. exa = conceptual or thematic digs. tavily = a specific named topic. brave = broad general sweep. rss = recency from known feeds ('anything new today', cheap, no confirmation needed). Does NOT read past results.",
    WF.run_discovery,
    { source: { desc: 'one of exa, tavily, brave, rss' },
      query: { desc: 'the search query (empty for rss)' },
      trigger: { fixed: 'agent' } }, [1300, 320]),

  tool('full_sweep',
    "Run ALL discovery sources (exa, tavily, brave, rss). The most expensive action there is. NEVER call it in response to the message that first asks for it — 'sweep', 'go wide', 'full run on X' get a one-line confirmation question and nothing else. " +
    "Call it ONLY when your previous message asked to confirm a sweep and the user's reply is a yes.",
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
    "Set group_stories to 'true' when the user wants an overview rather than every article — it collapses multiple outlets covering the same event into one row with an articles count. Prefer it for 'what's happening with X', 'catch me up', 'what did I miss'. Leave empty when they want individual pieces to read. " +
    "Put the question's topic in tag as plain keywords ('nvidia export control'); it matches tags, titles and summaries by keyword overlap. If a topic search comes back empty, say the feed has nothing on it and offer a search. Time words and quality belong in max_age_days and min_score, never in tag. " +
    "Params: max_age_days (days since publication), min_score (2-10), since (ISO timestamp, for an exact cutoff), tag, limit (default 20), group_stories, min_relevance (legacy, leave empty).",
    WF.query_feed,
    { group_stories: { desc: "'true' to collapse duplicate coverage of one event into a single row, empty for every article" },
      max_age_days: { desc: 'only items published within this many days, empty for any age' },
      min_score: { desc: 'minimum combined score 2-10, empty for none' },
      since: { desc: 'ISO timestamp lower bound, empty for none' },
      tag: { desc: 'topic keywords from the question (e.g. \'nvidia export control\'), empty for no topic. Matches tags, titles and summaries by keyword overlap. Never put time words or quality words here' },
      limit: { desc: 'max items to return, empty for default 20' },
      min_relevance: { desc: 'legacy 1-5 filter, leave empty' } }, [1720, 320]),

  tool('run_status',
    "Report recent runs: when, scope, counts, ok/partial/failed. Use for 'did last night's run work', 'when did you last run', 'did anything break'.",
    WF.run_status,
    { limit: { desc: 'how many recent runs to return, empty for default 5' } }, [1860, 320]),

  tool('manage_sources',
    "Add, remove or list RSS feeds. Use for 'add this feed', 'stop following X', 'what feeds are you watching'. Params: action (add|remove|list); url (for add/remove); label (optional); id (for remove).",
    WF.manage_sources,
    { action: { desc: 'add, remove, or list' },
      url: { desc: 'feed URL for add or remove, else empty' },
      label: { desc: 'short label for the feed, optional' },
      id: { desc: 'source id for remove, else empty' } }, [2140, 320]),

  { id: 'prepreply', name: 'Prep reply', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1400, 100],
    parameters: { mode: 'runOnceForEachItem', jsCode: inline('telegram-format.js') + `
let chat_id = ${CHAT_ID};
try { chat_id = $('Record update').item.json.chat_id || chat_id; } catch (e) {
  try { chat_id = $('Test normalize').item.json.chat_id || chat_id; } catch (e2) {}
}
return { json: { chat_id, output: forTelegram($json.output) || '(empty reply)' } };`.trim() } },

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
    [{ node: 'Agent context', type: 'main', index: 0 }]
  ] },
  'Toggle drain': { main: [[{ node: 'Switch reply', type: 'main', index: 0 }]] },
  'Switch reply': { main: [[{ node: 'Send reply', type: 'main', index: 0 }]] },
  [MODEL_NODE.name]: { ai_languageModel: [[{ node: 'Overseer Agent', type: 'ai_languageModel', index: 0 }]] },
  'Chat memory': { ai_memory: [[{ node: 'Overseer Agent', type: 'ai_memory', index: 0 }]] },
  'run_discovery': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }]] },
  'full_sweep': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }]] },
  'scrape_url': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }]] },
  'query_feed': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }]] },
  'run_status': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }]] },
  'manage_sources': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }]] },
  'Agent context': { main: [[{ node: 'Agent input', type: 'main', index: 0 }]] },
  'Agent input': { main: [[{ node: 'Overseer Agent', type: 'main', index: 0 }]] },
  'Overseer Agent': { main: [[{ node: 'Prep reply', type: 'main', index: 0 }]] },
  'Prep reply': { main: [[{ node: 'Send reply', type: 'main', index: 0 }]] }
};

const workflow = { name: 'WF-00 agent_router', nodes, connections,
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' } };

const repoOut = path.join(__dirname, '..', 'workflows', 'wf00-agent-router.json');
fs.writeFileSync(repoOut, JSON.stringify(workflow, null, 2));
console.log('wrote', repoOut);

// The old `build-wf00.js <dir>` deploy-copy flow is superseded by
// scripts/deploy.js, which substitutes every placeholder from .env and PUTs.
if (process.argv[2]) {
  console.error('deploy copies are gone — run: node scripts/deploy.js wf00-agent-router');
  process.exit(1);
}
