// Builds WF-00 agent_router. Emits:
//   workflows/wf00-agent-router.json  (committed, __TG_TOKEN__ placeholder)
//   <scratchpad>/wf00-deploy.json     (real token, deploy this) — pass dir as argv[2]
// Inbound Telegram uses getUpdates POLLING (no public webhook URL needed on this
// stack; the old ngrok tunnel is dead). Update ids dedupe through tg_updates.
const fs = require('fs');
const path = require('path');
const { BARE_MEDIA_REPLY } = require('../shared/media.js');

// Inlined from shared/ so the committed tests cover what actually ships.
const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
  .replace(/module\.exports[\s\S]*$/, '');

// Instance-local ids live in instance.json; personal values (chat id, webhook
// secret) stay out of the committed JSON entirely — deploy.js substitutes them.
const I = require('./instance.json');
const CRED_PG = I.credentials.postgres;
const CRED_OR = I.credentials.openrouter;
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
  web_answer: I.workflows['wf44-web-answer'],
  synth_answer: I.workflows['wf45-synth-answer'],
  run_status: I.workflows['wf32-run-status'],
  manage_sources: I.workflows['wf34-manage-sources']
};

const SYSTEM = `=You are Research Overseer's dispatcher on Telegram. Route requests to tools; never do research yourself; never fabricate results or data — if a tool returns nothing, say so.

Rules:
0. You know NOTHING about runs or findings except what a tool returns for the CURRENT message. Earlier tool results in this chat are stale — runs start and finish, items arrive. Every question about runs or findings MUST call the matching tool again, even if you answered the same question a minute ago. Never answer from chat history or general knowledge. (The feed list below is fresh every message.) One exception: a message may carry [earlier chats with this user ...] — what was said in older chats. Use one only if it is about what this message asks, and always say when ("On 13 Oct I told you ..."); it tells what was said then, not what the feed holds now.
1. Free and instant actions run immediately, no confirmation: a pasted URL -> scrape_url; status questions -> run_status; 'what feeds/sources are you watching' -> manage_sources with action list; 'how are my sources/feeds doing', 'which feeds are worth it', 'where do good items come from' -> manage_sources with action scorecard (run status is NOT source quality); reading existing findings -> query_feed; 'anything new today' -> run_discovery with source rss. These touch nothing that costs money.
2. Anything that starts a web search costs money and about six minutes, so it needs the user's word first. Run it immediately ONLY if they used an explicit search verb (search, find me, look up, go get, dig into). If they merely asked a question — 'what's happening with X', 'anything on X', 'how is X going' — answer it from query_feed (free). If the feed does not answer it, say so in one plain sentence and stop: the system answers from the web by itself, automatically. NEVER offer a search, never ask 'would you like me to search', never mention exa, tavily or brave in an answer. Discovery runs (which add items to the feed) happen only when the user asks to search, find or track something. full_sweep always needs confirmation.
3. Retrospective questions are ALWAYS query_feed or run_status, and this OVERRIDES everything else even when a topic is named. Retrospective phrasing includes: catch me up, what did you find, what's new, anything good, show me, what did I miss, brief me, recap. "Catch me up on funding this week" is query_feed with max_age_days 7 — NOT a search, and NOT a confirmation prompt either; just read the feed and answer.
3b. If a topic read comes back thin, retry query_feed once with fewer, broader keywords in tag. Never present items as being about the topic unless they are, and never answer a thin result by starting a search — say what the feed has, and if that does not answer the question, say so plainly (no offer; the web answer follows by itself). If the question names a time ('today', 'last night', 'this week'), compute the ISO timestamp for the start of that window from the current time below and pass it to query_feed as the since parameter. Never answer a time-scoped question from an unfiltered read.
3c. Follow-ups about an item you just listed — 'the first one', '#3', 'tell me more about number 2', '1. especially the X part', 'open the second' — call get_item with that number. Do NOT call query_feed again for these: a fresh query returns a different list. If they describe an item without a number, match it to the list you showed and use its n.
4. When uncertain between search sources, fail WIDE: prefer full_sweep (with confirmation) or brave. Never guess narrow.
4b. Call at most ONE discovery tool per user request, ever. After full_sweep or run_discovery returns, summarize what it returned and stop. If it found little, say so — do NOT run it again with different wording. Each run costs money and minutes.
5. Scheduling is OFF — this is a live chat agent; nothing runs on a timer. If asked to schedule, repeat, or run something later or every day, say scheduling is switched off and offer to run it now (searches still need their usual yes).
6. manage_sources actions: add (url, optional label), remove (id or url), list, scorecard (how well each source and feed is doing; optional days).
7. Reply tersely — this is Telegram. Plain text, no markdown formatting. When you list feed items, start each line with its n from the tool result (e.g. '3. Title — one line why') so the user can say 'tell me about 3'.

Feeds you are watching right now (read from the database this message — authoritative, the ONLY true list): {{ $json.sources }}

Latest runs, newest first (read from the database this message — these OVERRIDE anything said earlier in the chat): {{ $json.runs }}

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
      // allowed_updates is sticky on Telegram's side: it was ["message"] from some
      // earlier call, which silently dropped every 👍/👎 tap (callback_query).
      // Sent on every poll so it can never drift again.
      url: "=https://api.telegram.org/bot__TG_TOKEN__/getUpdates?offset={{ $json.tg_offset || 1 }}&timeout=0&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22callback_query%22%5D",
      options: { timeout: 10000 } },
    retryOnFail: false, onError: 'continueRegularOutput' },

  { id: 'extract', name: 'Extract messages', type: 'n8n-nodes-base.code', typeVersion: 2, position: [540, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const j = $input.first().json;
if (!j.ok || !Array.isArray(j.result)) return [];
const out = [];
for (const u of j.result) {
  // A 👍/👎 tap (shared/feedback.js) arrives as a callback_query; it becomes
  // text "cb:<data>" so the dedupe table and allowlist treat it like a message.
  const cq = u.callback_query;
  if (cq) {
    const cm = cq.message || {};
    out.push({ json: { update_id: u.update_id, chat_id: (cm.chat && cm.chat.id) || 0,
      text: ('cb:' + (cq.data || '')).slice(0, 200), callback_id: cq.id || '', message_id: cm.message_id || 0,
      reply_markup: cm.reply_markup || null } });
    continue;
  }
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

  // ---- 👍/👎 taps (sql/013, shared/feedback.js) — no model involved ----
  { id: 'istap', name: 'Feedback tap?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1000, 300],
    parameters: { options: {}, conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [ { id: 't1', leftValue: "={{ String($json.text || '').startsWith('cb:fb:') }}", rightValue: true,
        operator: { type: 'boolean', operation: 'equals' } } ] } } },

  { id: 'prepfb', name: 'Prep feedback', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1180, 420],
    parameters: { mode: 'runOnceForEachItem', jsCode: inline('feedback.js') + `
const r = $json;
let src = {};
try { src = $('Extract messages').all().map((i) => i.json).find((x) => String(x.update_id) === String(r.update_id)) || {}; } catch (e) {}
const v = parseVote(String(r.text || '').slice(3));
return { json: { vote: v ? v.vote : 0, id: v ? v.id : 0, chat_id: r.chat_id, callback_id: src.callback_id || '',
  message_id: src.message_id || 0, markup: src.reply_markup || null } };`.trim() } },

  // Upsert only if the item still exists; returns its title for the toast.
  { id: 'savefb', name: 'Save feedback', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1360, 420],
    parameters: { operation: 'executeQuery',
      query: "insert into feedback (feed_item_id, vote, chat_id) select $1::bigint, $2::smallint, nullif($3, '')::bigint where exists (select 1 from feed_items where id = $1::bigint) and $2::int in (-1, 1) on conflict (feed_item_id) do update set vote = excluded.vote, chat_id = excluded.chat_id, updated_at = now() returning feed_item_id, vote, (select title from feed_items where id = $1::bigint) as title",
      options: { queryReplacement: "={{ String($json.id) }},{{ String($json.vote) }},{{ String($json.chat_id || '') }}" } },
    credentials: { postgres: CRED_PG }, alwaysOutputData: true, onError: 'continueRegularOutput' },

  { id: 'ackfb', name: 'Ack tap', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1540, 420],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('feedback.js') + `
const p = $('Prep feedback').first().json;
const s = $input.first().json || {};
const saved = Number(s.feed_item_id) > 0;
const mark = saved ? (Number(s.vote) === 1 ? '\\u{1F44D}' : '\\u{1F44E}') : '';
const title = String(s.title || '').slice(0, 80);
return [{ json: {
  answer: { callback_query_id: p.callback_id, text: saved ? mark + ' saved: ' + title : 'Could not save that — the item may be gone.' },
  edit: p.markup && saved ? { chat_id: p.chat_id, message_id: p.message_id, reply_markup: votedKeyboard(p.markup, p.id, Number(s.vote)) } : null,
  saved, title } }];`.trim() } },

  { id: 'answerfb', name: 'Answer tap', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1720, 420],
    parameters: { method: 'POST', url: 'https://api.telegram.org/bot__TG_TOKEN__/answerCallbackQuery',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.answer) }}', options: { timeout: 10000 } },
    retryOnFail: false, onError: 'continueRegularOutput' },

  { id: 'tickfb', name: 'Tick button', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1900, 420],
    parameters: { method: 'POST', url: 'https://api.telegram.org/bot__TG_TOKEN__/editMessageReplyMarkup',
      sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify($('Ack tap').first().json.edit || {}) }}", options: { timeout: 10000 } },
    retryOnFail: false, onError: 'continueRegularOutput' },

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
  // BBC, The Verge, Reuters...) however the rules are worded, and it repeats an
  // old run_status answer from chat memory instead of calling the tool again.
  // Handing it the real list and the latest runs each message removes the gap
  // it fills. One cheap query per message.
  { id: 'ctx', name: 'Agent context', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1000, -100],
    parameters: { operation: 'executeQuery',
      query: "select coalesce((select string_agg(coalesce(nullif(label, ''), url) || ' <' || url || '>', '; ' order by id) from sources where active and kind = 'rss'), 'none') as sources, " +
        "coalesce((select string_agg('run ' || id || ' ' || scope || ' ' || status || ' started ' || to_char(started_at at time zone 'Asia/Dhaka', 'YYYY-MM-DD HH24:MI') || ', ' || coalesce(items_created, 0) || ' items' || coalesce(' (error: ' || left(error, 80) || ')', ''), '; ' order by id desc) from (select * from runs order by id desc limit 3) r), 'no runs yet') as runs, " +
        "coalesce((select value from settings where key = 'fix_answer_check'), '') as fix_check, " +
        "coalesce((select value from settings where key = 'fix_web'), '') as fix_web, " +
        "coalesce((select value from settings where key = 'fix_synth'), 'off') as fix_synth, " +
        "coalesce((select value from settings where key = 'fix_verify'), 'false') as fix_verify, " +
        "coalesce((select value from settings where key = 'fix_recall'), 'true') as fix_recall, " +
        "coalesce((select value from settings where key = 'fix_fit'), 'true') as fix_fit",
      options: {} },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },

  // Re-attach the context to every message item (Feed switch? output 1 = not a
  // feed-switch command); chat memory keys on $json.chat_id, so it must survive.
  { id: 'ctxmerge', name: 'Agent input', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1060, 100],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const ctx = $('Agent context').first().json;
const sources = ctx.sources || 'none', runs = ctx.runs || 'unknown', fix_check = ctx.fix_check || '', fix_web = ctx.fix_web || '', fix_synth = ctx.fix_synth || 'off', fix_verify = ctx.fix_verify || 'false', fix_recall = ctx.fix_recall || 'true', fix_fit = ctx.fix_fit || 'true';
return $('Feed switch?').all(1).map(i => ({ json: { ...i.json, sources, runs, fix_check, fix_web, fix_synth, fix_verify, fix_recall, fix_fit } }));`.trim() } },

  // Links are ingested deterministically, BEFORE the model runs (2026-10-11):
  // the 9B answered a two-link message with "I've ingested both YouTube links"
  // without calling scrape_url, and nothing was queued. WF-42 reads every link
  // and trigger word from the message itself; the model only writes the reply.
  { id: 'haslink', name: 'Has link?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1080, 260],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      // ...or a bare "transcribe" reply, which WF-42 resolves to the last captionless video
      combinator: 'and', conditions: [ { id: 'c1', leftValue: "={{ /https?:\\/\\//i.test($json.text || '') || new RegExp(" +
        JSON.stringify(BARE_MEDIA_REPLY.source) + ", 'i').test($json.text || '') }}", rightValue: true,
        operator: { type: 'boolean', operation: 'equals' } } ] } } },
  // ---- #13 big-picture questions (2026-10-12) ----
  // "what's happening with X?" gets one cited answer from WF-45 instead of the
  // agent's list. Decided in code (shared/synth.js bigPictureQ), switch fix_synth
  // = off | fast | think. Lists, follow-ups, commands and bot questions stay on the agent.
  // the bot's previous message: a "yes"/"no" to its sweep question is routed in
  // code (shared/sweep-confirm.js), never by the 9B
  { id: 'lastbot', name: 'Last bot msg', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1175, 160],
    parameters: { operation: 'executeQuery',
      query: "select coalesce((select message->>'content' from n8n_chat_histories where session_id = $1::text and message->>'type' = 'ai' order by id desc limit 1), '') as last_bot",
      options: { queryReplacement: "={{ String($('Agent input').first().json.chat_id) }}" } },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
  { id: 'bigq', name: 'Big picture?', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1180, 160],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('synth.js') + inline('sweep-confirm.js') + `
let lastBot = '';
try { lastBot = $input.first().json.last_bot || ''; } catch (e) {}
return $('Recall note').all().map(i => {
  const s = sweepDecision(i.json.text || '', lastBot);
  return { json: { ...i.json, ...s,
    synth_go: String(!s.sweep && ['fast', 'think'].includes(i.json.fix_synth) && bigPictureQ(i.json.text || '')) } };
});`.trim() } },
  { id: 'sweepif', name: 'Sweep?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1200, 120],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 'w1', leftValue: '={{ $json.sweep }}', rightValue: 'go', operator: { type: 'string', operation: 'equals' } }] } } },
  { id: 'sweepnoif', name: 'Sweep declined?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1220, 140],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 'w2', leftValue: '={{ $json.sweep }}', rightValue: 'no', operator: { type: 'string', operation: 'equals' } }] } } },
  // WF-40's own gate re-checks the yes against the same memory row
  { id: 'sweepcall', name: 'Run sweep', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [1260, 60],
    parameters: { workflowId: { __rl: true, value: WF.full_sweep, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value: {
        query: "={{ $json.sweep_query }}", trigger: 'agent',
        user_message: "={{ $('Agent input').first().json.text }}", chat_id: "={{ String($('Agent input').first().json.chat_id) }}" },
        matchingColumns: [], schema: ['query', 'trigger', 'user_message', 'chat_id'].map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })) },
      options: { waitForSubWorkflow: true } },
    executeOnce: true, onError: 'continueRegularOutput', alwaysOutputData: true },
  // the agent did not run: write the exchange to memory here, like the synth path
  { id: 'sweepreply', name: 'Sweep reply', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1300, 60],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('sweep-confirm.js') + `
const d = $('Big picture?').first().json;
let r = null;
try { r = $('Run sweep').first().json; } catch (e) {}
const output = sweepReply(d, r);
const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');
return [{ json: { output, chat_id: String(d.chat_id), q_b64: b64(d.text), out_b64: b64(output) } }];`.trim() } },
  { id: 'sweepmem', name: 'Sweep memory', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1330, 60],
    parameters: { operation: 'executeQuery',
      query: "insert into n8n_chat_histories (session_id, message) values ($1::text, jsonb_build_object('type', 'human', 'content', convert_from(decode($2, 'base64'), 'UTF8'), 'additional_kwargs', '{}'::jsonb, 'response_metadata', '{}'::jsonb)), ($1::text, jsonb_build_object('type', 'ai', 'content', convert_from(decode($3, 'base64'), 'UTF8'), 'tool_calls', '[]'::jsonb, 'invalid_tool_calls', '[]'::jsonb, 'additional_kwargs', '{}'::jsonb, 'response_metadata', '{}'::jsonb)) returning id",
      options: { queryReplacement: "={{ $json.chat_id }},{{ $json.q_b64 }},{{ $json.out_b64 }}" } },
    credentials: { postgres: CRED_PG }, alwaysOutputData: true, onError: 'continueRegularOutput', executeOnce: true },
  { id: 'sweepout', name: 'Sweep out', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1360, 60],
    parameters: { mode: 'runOnceForAllItems', jsCode: `return [{ json: { output: $('Sweep reply').first().json.output } }];` } },
  { id: 'synthif', name: 'Synth?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1240, 160],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 's1', leftValue: '={{ $json.synth_go }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } },
  { id: 'synthcall', name: 'Synth answer', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [1300, 240],
    parameters: { workflowId: { __rl: true, value: WF.synth_answer, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value: {
        question: "={{ $('Agent input').first().json.text }}", chat_id: "={{ String($('Agent input').first().json.chat_id) }}",
        mode: "={{ $('Agent input').first().json.fix_synth }}", verify: "={{ $('Agent input').first().json.fix_verify }}" },
        matchingColumns: [], schema: ['question', 'chat_id', 'mode', 'verify'].map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })) },
      options: { waitForSubWorkflow: true } },
    onError: 'continueRegularOutput', alwaysOutputData: true },
  // The agent did not run, so its memory node wrote nothing: record the exchange
  // here (Fix memory later rewrites this ai row if the web answer replaces it).
  // base64 is computed in a Code node: n8n expressions have no Buffer, and the
  // expression version failed on every message ("invalid symbol {"), 2026-10-13.
  { id: 'synthmemtext', name: 'Synth memory text', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1330, 240],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const a = $('Agent input').first().json;
const r = $input.first().json || {};
const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');
return [{ json: { chat_id: String(a.chat_id), q_b64: b64(a.text), out_b64: b64(r.output) } }];`.trim() } },
  { id: 'synthmem', name: 'Synth memory', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1360, 240],
    parameters: { operation: 'executeQuery',
      query: "insert into n8n_chat_histories (session_id, message) values ($1::text, jsonb_build_object('type', 'human', 'content', convert_from(decode($2, 'base64'), 'UTF8'), 'additional_kwargs', '{}'::jsonb, 'response_metadata', '{}'::jsonb)), ($1::text, jsonb_build_object('type', 'ai', 'content', convert_from(decode($3, 'base64'), 'UTF8'), 'tool_calls', '[]'::jsonb, 'invalid_tool_calls', '[]'::jsonb, 'additional_kwargs', '{}'::jsonb, 'response_metadata', '{}'::jsonb)) returning id",
      options: { queryReplacement: "={{ $json.chat_id }},{{ $json.q_b64 }},{{ $json.out_b64 }}" } },
    credentials: { postgres: CRED_PG }, alwaysOutputData: true, onError: 'continueRegularOutput', executeOnce: true },
  // items go out as a tool step, which is where Prep reply looks for 👍/👎 buttons
  { id: 'synthres', name: 'Synth result', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1420, 240],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const r = $('Synth answer').first().json || {};
const output = r.output || "I couldn't put that summary together just now. Try again, or ask 'anything on ...' for the list.";
return [{ json: { output, synth: true, synth_status: r.status || 'failed', synth_secs: r.seconds,
  intermediateSteps: [{ action: { tool: 'synth_answer' }, observation: { items: r.items || [] } }] } }];`.trim() } },

  { id: 'ingest', name: 'Ingest links', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [1100, 400],
    parameters: { workflowId: { __rl: true, value: WF.scrape_url, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value: { url: '', trigger: 'agent', user_message: '={{ $json.text }}' },
        matchingColumns: [], schema: ['url', 'trigger', 'user_message'].map((id) => ({ id, displayName: id, required: false,
          defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })) },
      options: { waitForSubWorkflow: true } },
    onError: 'continueRegularOutput' },
  { id: 'linknote', name: 'Link note', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1110, 520],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const base = $('Agent input').first().json;
const r = $input.first().json;
const note = String(r.note || (r.error && (r.error.message || r.error)) || 'links handed to the pipeline');
return [{ json: { ...base, ingest_note: note } }];`.trim() } },

  { id: 'agent', name: 'Overseer Agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [1120, 100],
    // Live run data rides in the USER turn, not just the system prompt: with it
    // only in the system prompt the 9B still copied a stale run_status answer
    // from chat history (it saw run 58, answered "run 57"). The latest turn wins.
    parameters: { promptType: 'define', text: '={{ $json.text }}\n\n[live data, fetched just now: latest runs: {{ $json.runs }}]{{ $json.ingest_note ? "\\n[ALREADY DONE for this message, by the system: " + $json.ingest_note + " Do NOT call scrape_url. Reply in one short line.]" : "" }}{{ $json.recall_note ? "\\n" + $json.recall_note : "" }}',
      options: { systemMessage: SYSTEM, maxIterations: 6, returnIntermediateSteps: true } } },

  // ---- answer guard (2026-10-09) ----
  // A reply that talks about the feed without a tool having run this turn is
  // redone by a memoryless agent that is told to look it up. The decision is
  // shared/answer-guard.js (tested); the model cannot argue its way past it.
  { id: 'guard', name: 'Guard check', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1300, 100],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('answer-guard.js') + inline('answer-check.js') + inline('recall.js') + inline('bare-reply.js') + `
const a = $input.first().json;
const ctx = $('Agent input').first().json;
const question = ctx.text || '';
// #14: an answer built on a recalled exchange says so ("On 13 Oct I told you"),
// and only then does the recall count as the lookup (shared/recall.js usesRecall).
let rc = {};
try { rc = $('Recall note').first().json || {}; } catch (e) {}
const recall_note = rc.recall_note || '';
const toolsUsed = (a.intermediateSteps || []).map(s => (s.action && s.action.tool) || '').filter(Boolean);
if (usesRecall(a.output, rc.recall_n)) toolsUsed.push('recall');
let g = needsFreshLookup({ question, reply: a.output, toolsUsed });
// Fix 1a (switch fix_answer_check): figures and names must be in what the tools returned.
if (!g.retry && ctx.fix_check === 'true' && toolsUsed.length) {
  const evidence = (a.intermediateSteps || []).map(s => typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation || '')).join(' ') + ' ' + ctx.sources + ' ' + ctx.runs + ' ' + recall_note;
  const miss = unsupportedFacts(a.output || '', evidence, question);
  if (miss.length) g = { retry: true, reason: 'unsupported: ' + miss.slice(0, 6).join(', ') };
}
// a bare "yes"/"ok" has no topic: a redo would prefetch the feed for "yes" (shared/bare-reply.js)
let output = a.output || '';
if (g.retry && bareReply(question)) { output = bareReplyText(question); g = { retry: false, reason: 'bare reply: asked what it refers to' }; }
const pf = prefetchFor(question);
const sq = String(g.reason || '').startsWith('source quality');
return [{ json: { output, retry: String(g.retry), guard_reason: g.reason, tools_used: toolsUsed.join(','), prefetch_item: pf.item, prefetch_tag: pf.tag,
  source_q: String(sq), scorecard_days: scorecardDays(question), recall_note } }];`.trim() } },

  { id: 'retryif', name: 'Redo?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1460, 100],
    parameters: { options: {}, conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 'r1', leftValue: '={{ $json.retry }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } },

  // The lookup the rejected answer skipped, run deterministically so the redo
  // does not depend on the model choosing to call a tool (it was seen not to).
  { id: 'prefetch', name: 'Prefetch', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [1540, -120],
    parameters: { workflowId: { __rl: true, value: WF.query_feed, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value: {
        item: '={{ $json.prefetch_item }}', tag: '={{ $json.prefetch_tag }}', limit: '10',
        chat_id: "={{ String($('Agent input').first().json.chat_id) }}",
        since: '', min_relevance: '', min_score: '', max_age_days: '', group_stories: '' },
        matchingColumns: [], schema: ['item', 'tag', 'limit', 'chat_id', 'since', 'min_relevance', 'min_score', 'max_age_days', 'group_stories']
          .map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })) },
      options: { waitForSubWorkflow: true } },
    onError: 'continueRegularOutput', alwaysOutputData: true },

  // #9 (2026-10-12): a source-quality question gets the scorecard, run here for
  // the same reason as Prefetch — the 9B answered 4/4 from the run list instead.
  // It never runs Prefetch: no feed buttons, and his saved "#3" list is kept.
  { id: 'srcq', name: 'Source question?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1500, -220],
    parameters: { options: {}, conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 'sq1', leftValue: '={{ $json.source_q }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } },

  { id: 'scprefetch', name: 'Scorecard prefetch', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [1580, -220],
    parameters: { workflowId: { __rl: true, value: WF.manage_sources, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value: {
        action: 'scorecard', days: "={{ $('Guard check').first().json.scorecard_days }}",
        url: '', label: '', id: '' },
        matchingColumns: [], schema: ['action', 'url', 'label', 'id', 'days']
          .map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })) },
      options: { waitForSubWorkflow: true } },
    onError: 'continueRegularOutput', alwaysOutputData: true, executeOnce: true },

  // the exchange before this one, so "tell me more about the first one" still
  // works in the memoryless redo. Offset 2 skips the rejected attempt itself.
  { id: 'retryctx', name: 'Redo context', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1620, 0],
    parameters: { operation: 'executeQuery',
      query: "select coalesce((select string_agg(case when t = 'human' then 'You: ' else 'Bot: ' end || left(regexp_replace(c, '\\s*\\[live data, fetched just now:.*$', '', 's'), 600), ' | ' order by id) from (select id, message->>'type' as t, message->>'content' as c from n8n_chat_histories where session_id = $1::text and message->>'type' in ('human', 'ai') order by id desc offset 2 limit 2) h), 'nothing') as previous",
      options: { queryReplacement: "={{ $('Agent input').first().json.chat_id }}" } },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true },

  { id: 'agent2', name: 'Guarded agent', type: '@n8n/n8n-nodes-langchain.agent', typeVersion: 3.1, position: [1780, 0],
    parameters: { promptType: 'define',
      text: "={{ $('Agent input').first().json.text }}\n\n[previous exchange, for reference: {{ $json.previous }}]\n[live data, fetched just now: latest runs: {{ $('Agent input').first().json.runs }}]\n{{ $('Guard check').first().json.recall_note ? $('Guard check').first().json.recall_note + '\\n' : '' }}{{ String($('Guard check').first().json.guard_reason || '').startsWith('source quality') ? '[live data, source scorecard run just now: ' + JSON.stringify($('Scorecard prefetch').first().json).slice(0, 12000) + ']\\n[Your first answer was rejected because it answered a question about how the sources are doing without the scorecard. Answer ONLY from the scorecard above: per source and per RSS feed, good items (score 7+) out of scored, good rate, average score; name the silent feeds (0 items). Do not call any tool and do not switch anything off.]' : '[live data, feed lookup run just now for this message: ' + JSON.stringify($('Prefetch').first().json).slice(0, 20000) + ']\\n' + (String($('Guard check').first().json.guard_reason || '').startsWith('unsupported') ? '[Your first answer was rejected because it stated facts that are not in the feed: ' + String($('Guard check').first().json.guard_reason).slice(13) + '. Answer ONLY from the feed lookup above: quote its figures and names exactly; if it does not contain the answer, say the feed does not say.]' : '[Your first answer to this was rejected because it described the feed without checking it. Answer ONLY from the feed lookup above (list items with their n); call a tool only if the lookup clearly does not answer the question.]') }}",
      options: { systemMessage: SYSTEM.replace(/\{\{ \$json\.(sources|runs) \}\}/g, "{{ $('Agent input').first().json.$1 }}"), maxIterations: 6, returnIntermediateSteps: true } } },

  // Fix 1a, second line: the redo's answer is checked too. Still unsupported =
  // say so and show the closest items, rather than send a figure nobody wrote.
  { id: 'finalcheck', name: 'Final check', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1860, -40],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('answer-check.js') + `
const a = $input.first().json;
const ctx = $('Agent input').first().json;
const steps = a.intermediateSteps;   /* Prep reply builds the 👍/👎 buttons from these */
if (ctx.fix_check !== 'true') return [{ json: { output: a.output || '', intermediateSteps: steps } }];
let pf = {};
try { pf = $('Prefetch').first().json || {}; } catch (e) {}
let sc = {};
try { sc = $('Scorecard prefetch').first().json || {}; } catch (e) {}
let rnote = '';
try { rnote = $('Guard check').first().json.recall_note || ''; } catch (e) {}
const evidence = rnote + ' ' + JSON.stringify(pf) + ' ' + JSON.stringify(sc) + ' ' + (a.intermediateSteps || []).map(s => typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation || '')).join(' ') + ' ' + ctx.sources + ' ' + ctx.runs;
const miss = unsupportedFacts(a.output || '', evidence, ctx.text || '');
if (!miss.length) return [{ json: { output: a.output || '', intermediateSteps: steps } }];
const items = (pf.items || []).slice(0, 3).map(i => i.n + '. ' + i.title).join('\\n');
return [{ json: { output: "I couldn't confirm an answer to that in your feed's articles." + (items ? ' Closest items:\\n' + items + '\\nSay \\"tell me about 1\\" to open one.' : ''), checked_out: miss.join(', '), intermediateSteps: steps } }];`.trim() } },

  // put the corrected answer into memory in place of the rejected one (base64
  // keeps free text out of the comma-split queryReplacement). Computed in a Code
  // node: the old expression used Buffer, which n8n expressions do not have, so
  // this step failed on every message and memory kept the REJECTED reply — the bot
  // forgot its own web answers ("I don't have access to live weather data" after
  // giving the Dhaka weather), found 2026-10-13.
  { id: 'fixmemtext', name: 'Memory text', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1900, -100],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const o = $input.first().json || {};
return [{ json: { chat_id: String($('Agent input').first().json.chat_id), output: String(o.output || ''), out_b64: Buffer.from(String(o.output || ''), 'utf8').toString('base64') } }];`.trim() } },
  { id: 'fixmem', name: 'Fix memory', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1940, -100],
    parameters: { operation: 'executeQuery',
      query: "update n8n_chat_histories set message = jsonb_set(message, '{content}', to_jsonb(convert_from(decode($2, 'base64'), 'UTF8'))) where id = (select max(id) from n8n_chat_histories where session_id = $1::text and message->>'type' = 'ai') returning id",
      options: { queryReplacement: "={{ $json.chat_id }},{{ $json.out_b64 }}" } },
    credentials: { postgres: CRED_PG }, alwaysOutputData: true, onError: 'continueRegularOutput' },

  // ---- Fix 2: answers from the web when the feed has none (2026-10-12) ----
  // Wasim's call: automatic, no cap, Tavily, answer only. Decided in code from
  // the final reply (shared/web-fallback.js), never by the model; at most one
  // web search per message. WF-44 does the search and the cited answer.
  // ---- feed replies that list items (2026-10-17, shared/feed-fit.js) ----
  // "The feed has 10 items on products using the REA repo" + 7 items, none of them
  // a product built with it. Code fixes the count; the 9B checks the shown items
  // against the question: one call, or for "products built with X" one call per
  // item that must name the thing and quote the sentence. eval: scripts/eval-fit.js
  // (12/12 misses caught, 39/41 answers kept). Switch fix_fit (default on).
  { id: 'fitprep', name: 'Fit prep', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1980, 120],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('feed-fit.js') + inline('bare-reply.js') + `
const a = $input.first().json;
const ctx = $('Agent input').first().json;
const output = fixCount(a.output || '');
const sources = [];
if (a.intermediateSteps) sources.push(a.intermediateSteps);
try { sources.push($('Prefetch').all().map((i) => i.json)); } catch (e) {}
try { sources.push($('Overseer Agent').first().json.intermediateSteps); } catch (e) {}
const shown = ctx.fix_fit === 'false' || a.synth || bareReply(ctx.text) ? [] : shownFeedItems(output, sources).slice(0, 8);
const base = { ...a, output, fit_go: 'false', fit_mode: '' };
if (!shown.length) return [{ json: base }];
const MODEL = 'qwen/qwen3.5-9b';
if (relationQ(ctx.text)) return shown.map((i) => ({ json: { ...base, fit_go: 'true', fit_mode: 'named', fit_item: i, llm_body: JSON.stringify(namedBody(MODEL, ctx.text, i)) } }));
return [{ json: { ...base, fit_go: 'true', fit_mode: 'fit', llm_body: JSON.stringify(fitBody(MODEL, ctx.text, shown)) } }];`.trim() } },
  { id: 'fitif', name: 'Fit?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1990, 200],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 'f1', leftValue: '={{ $json.fit_go }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } },
  // one request per item (named mode sends up to 8, each ~0.5 s with thinking off)
  { id: 'fitjudge', name: 'Fit judge', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2000, 280],
    parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.llm_body }}', options: { timeout: 30000 } },
    credentials: { httpBearerAuth: I.credentials.lmstudio }, retryOnFail: false, onError: 'continueRegularOutput' },
  // unreadable or failed verdicts = the reply stands as it is
  { id: 'fitapply', name: 'Fit apply', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2010, 280],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('feed-fit.js') + `
const preps = $('Fit prep').all().map((i) => i.json);
const res = $input.all().map((i) => { try { return i.json.choices[0].message.content; } catch (e) { return null; } });
const ctx = $('Agent input').first().json;
const p = preps[0];
let miss = false, detail = '', gap = '';
if (p.fit_mode === 'named') {
  const named = preps.map((x, k) => readNamed(res[k], x.fit_item, ctx.text)).filter(Boolean);
  const answered = res.filter((r) => r != null).length;
  miss = answered === preps.length && named.length === 0;
  detail = 'named: ' + (named.join('; ') || 'none') + ' (' + answered + '/' + preps.length + ' read)';
} else {
  const v = readFit(res[0]);
  miss = !!v && !v.answers;
  gap = v ? v.gap : '';
  detail = v ? 'yes ' + v.yes + ' partly ' + v.partly + ' no ' + v.no : 'unreadable';
}
const { fit_item, llm_body, ...a } = p;
return [{ json: { ...a, output: miss ? missNote(gap) + a.output : a.output, fit_miss: String(miss), fit_detail: detail } }];`.trim() } },

  { id: 'webneed', name: 'Web needed?', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2020, 120],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('web-fallback.js') + inline('recall.js') + inline('bare-reply.js') + `
const a = $input.first().json;
const ctx = $('Agent input').first().json;
// #13: items a synthesis answer showed (none for "Your feed has nothing on this yet.")
const feedItems = a.synth ? (((a.intermediateSteps || [])[0] || {}).observation || {}).items?.length || 0 : 0;
// a bare "no" was searched on the web (a Meghan Trainor song): never (shared/bare-reply.js)
let n = bareReply(ctx.text) ? { web: false, reason: 'bare reply' } : ctx.fix_web === 'true' ? needsWeb({ question: ctx.text || '', reply: a.output || '', feedItems }) : { web: false, reason: 'switch fix_web off' };
// the fit check found that none of the listed items answers the question
if (!n.web && a.fit_miss === 'true' && ctx.fix_web === 'true' && !bareReply(ctx.text)) n = { web: true, reason: 'feed items do not answer' };
// the wording let it through, but it offers a search or says something is missing: ask the 9B
let judge = ctx.fix_web === 'true' && !bareReply(ctx.text) && !n.web && n.reason === 'the feed answered' && !a.synth && judgeNeeded(a.output || '');
// #14: the reply is built on an earlier chat that answered, yet says the feed has
// nothing — the 9B judges whether it answered (Pathao: yes; "still nothing": no).
let rc = {};
try { rc = $('Recall note').first().json || {}; } catch (e) {}
if (n.web && !a.synth && !bareReply(ctx.text) && answeredFromRecall(a.output || '', rc.recall_rows, (r) => needsWeb({ question: r.question, reply: r.answer }).web)) {
  n = { web: false, reason: 'earlier chat: the judge decides' }; judge = true;
}
return [{ json: { ...a, web_go: String(n.web), web_reason: n.reason, judge_go: String(judge),
  llm_body: judge ? JSON.stringify(judgeBody('qwen/qwen3.5-9b', ctx.text || '', a.output || '', n.reason === 'earlier chat: the judge decides')) : '' } }];`.trim() } },
  { id: 'judgeif', name: 'Judge?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [2060, 220],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 'j1', leftValue: '={{ $json.judge_go }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } },
  { id: 'judge', name: 'Judge', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2100, 300],
    parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.llm_body }}', options: { timeout: 60000 } },
    credentials: { httpBearerAuth: I.credentials.lmstudio }, retryOnFail: false, onError: 'continueRegularOutput' },
  // unreadable verdict = the wording rule stands (answered)
  { id: 'judgeverdict', name: 'Judge verdict', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2140, 300],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('web-fallback.js') + `
const d = $('Web needed?').first().json;
let content = '';
try { content = $input.first().json.choices[0].message.content; } catch (e) {}
const v = readJudge(content);
return [{ json: { ...d, web_go: String(v === false), web_reason: v === false ? 'judge: not answered' : 'judge: answered' } }];`.trim() } },
  { id: 'webif', name: 'Web?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [2180, 120],
    parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
      conditions: [{ id: 'w1', leftValue: '={{ $json.web_go }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } },
  // A follow-up ("what's your advice during this weather?") is searched as a full
  // question built from the previous exchange (memory rows 3-4 from the end: the
  // current turn's two rows are already written).
  { id: 'webctx', name: 'Web context', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [2220, 40],
    parameters: { operation: 'executeQuery',
      query: "with h as (select message->>'type' as t, message->>'content' as c from n8n_chat_histories where session_id = $1::text and message->>'type' in ('human', 'ai') order by id desc offset 2 limit 2) select coalesce((select c from h where t = 'human' limit 1), '') as prev_user, coalesce((select c from h where t = 'ai' limit 1), '') as prev_bot",
      options: { queryReplacement: "={{ $('Agent input').first().json.chat_id }}" } },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
  { id: 'standaloneprep', name: 'Standalone prep', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2240, 40],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('web-fallback.js') + `
const c = $input.first().json || {};
const q = $('Agent input').first().json.text || '';
return [{ json: { llm_body: JSON.stringify(standaloneBody('qwen/qwen3.5-9b', q, c.prev_user || '(none)', c.prev_bot || '(none)')) } }];`.trim() } },
  { id: 'standalone', name: 'Standalone question', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2260, 40],
    parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.llm_body }}', options: { timeout: 60000 } },
    credentials: { httpBearerAuth: I.credentials.lmstudio }, retryOnFail: false, onError: 'continueRegularOutput' },
  { id: 'webquery', name: 'Web query', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2280, 40],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('web-fallback.js') + `
const q = $('Agent input').first().json.text || '';
let content = '';
try { content = $input.first().json.choices[0].message.content; } catch (e) {}
return [{ json: { web_q: readStandalone(content, q) } }];`.trim() } },
  // Like the big chat apps: say what is happening at once, then turn that same
  // message into the answer (Send reply edits it). His call, 2026-10-13.
  { id: 'webstatus', name: 'Searching status', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2300, 40],
    parameters: { method: 'POST', url: 'https://api.telegram.org/bot__TG_TOKEN__/sendMessage',
      sendBody: true, specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ chat_id: $('Agent input').first().json.chat_id, text: '🔎 Not in your feed — searching the web…' }) }}",
      options: { timeout: 10000 } },
    retryOnFail: false, onError: 'continueRegularOutput' },
  { id: 'webcall', name: 'Web answer', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [2340, 40],
    parameters: { workflowId: { __rl: true, value: WF.web_answer, mode: 'id' },
      workflowInputs: { mappingMode: 'defineBelow', value: { question: "={{ $('Web query').first().json.web_q }}" },
        matchingColumns: [], schema: [{ id: 'question', displayName: 'question', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }] },
      options: { waitForSubWorkflow: true } },
    onError: 'continueRegularOutput', alwaysOutputData: true },
  // WF-44 failed or came back empty = keep the feed's "nothing here" reply.
  { id: 'webuse', name: 'Use web answer', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2500, 40],
    parameters: { mode: 'runOnceForAllItems', jsCode: `
const w = $input.first().json || {};
const before = $('Web needed?').first().json;
let edit_id;
try { edit_id = $('Searching status').first().json.result.message_id; } catch (e) {}
if (!w.output) return [{ json: { ...before, edit_id } }];
return [{ json: { output: w.output, web: true, web_sources: w.sources || [], web_q: $('Web query').first().json.web_q, edit_id } }];`.trim() } },

  // memory keeps the conversation, not the bulk: drop tool calls + raw tool
  // output (n8n saves full results — 10 feed items — and offers no switch to
  // stop it) and the per-message [live data ...] suffix.
  { id: 'tidy', name: 'Tidy memory', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1600, 300],
    parameters: { operation: 'executeQuery',
      query: "with d as (delete from n8n_chat_histories where session_id = $1::text and (message->>'type' = 'tool' or (message->>'type' = 'ai' and jsonb_typeof(message->'tool_calls') = 'array' and jsonb_array_length(message->'tool_calls') > 0)) returning 1), " +
        "u as (update n8n_chat_histories set message = jsonb_set(message, '{content}', to_jsonb(regexp_replace(message->>'content', '\\s*\\[live data, fetched just now:.*$', '', 's'))) where session_id = $1::text and message->>'type' = 'human' and message->>'content' like '%[live data, fetched just now:%' returning 1) " +
        "select (select count(*) from d) as dropped, (select count(*) from u) as stripped",
      options: { queryReplacement: "={{ $('Agent input').first().json.chat_id }}" } },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },

  // ---- #14 long-term memory (2026-10-13, sql/016, shared/recall.js) ----
  // Before the agent: the message is embedded and his earlier exchanges are
  // searched by meaning (cutoff 0.50); hits ride into the agent's turn after the
  // live data, dated, so Tidy memory strips them from the stored message. Every
  // finished exchange is stored after Memory text (the reply he actually saw).
  // Switch fix_recall (default on). A failed embedding = no recall, never a failed reply.
  { id: 'recallprep', name: 'Recall prep', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1120, 200],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('embed.js') + `
const a = $('Agent input').first().json;
return [{ json: { embed_body: JSON.stringify({ model: EMBED_MODEL, input: [queryText(a.text || '-')] }) } }];`.trim() } },
  { id: 'recallembed', name: 'Recall embed', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1140, 200],
    parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/embeddings',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.embed_body }}', options: { timeout: 20000 } },
    credentials: { httpBearerAuth: I.credentials.lmstudio }, retryOnFail: false, onError: 'continueRegularOutput' },
  { id: 'recallsql', name: 'Recall sql', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1150, 200],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('embed.js') + inline('recall.js') + `
const a = $('Agent input').first().json;
let vec = null;
try { vec = vectorLiteral($input.first().json.data[0].embedding); } catch (e) {}
return [{ json: { sql: a.fix_recall === 'false' ? 'select null::text as rows' : recallSql(a.chat_id, vec) } }];`.trim() } },
  { id: 'recallsearch', name: 'Recall search', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [1160, 200],
    parameters: { operation: 'executeQuery', query: '={{ $json.sql }}', options: {} },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },
  { id: 'recallnote', name: 'Recall note', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1170, 200],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('recall.js') + `
const rows = parseRows(($input.first().json || {}).rows);
const recall_note = recallNote(rows, $('Agent input').first().json.text);
return $('Agent input').all().map((i) => ({ json: { ...i.json, recall_note, recall_n: rows.length, recall_rows: rows } }));`.trim() } },

  { id: 'rememberprep', name: 'Remember prep', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1960, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('embed.js') + inline('recall.js') + `
const a = $('Agent input').first().json;
const m = $('Memory text').first().json;
if (!shouldRemember(a.text, m.output)) return [];
return [{ json: { embed_body: JSON.stringify({ model: EMBED_MODEL, input: [memoryDoc(a.text, m.output)] }) } }];`.trim() } },
  { id: 'rememberembed', name: 'Remember embed', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1980, -180],
    parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/embeddings',
      authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.embed_body }}', options: { timeout: 20000 } },
    credentials: { httpBearerAuth: I.credentials.lmstudio }, retryOnFail: false, onError: 'continueRegularOutput' },
  // embedding failed = stored without a vector (kept, but not searchable)
  { id: 'remembersql', name: 'Remember sql', type: 'n8n-nodes-base.code', typeVersion: 2, position: [2000, -180],
    parameters: { mode: 'runOnceForAllItems', jsCode: inline('embed.js') + inline('recall.js') + `
const a = $('Agent input').first().json;
const m = $('Memory text').first().json;
let vec = null;
try { vec = vectorLiteral($input.first().json.data[0].embedding); } catch (e) {}
return [{ json: { sql: rememberSql(a.chat_id, a.text, m.output, vec) } }];`.trim() } },
  { id: 'remember', name: 'Remember', type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: [2020, -180],
    parameters: { operation: 'executeQuery', query: '={{ $json.sql }}', options: {} },
    credentials: { postgres: CRED_PG }, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' },

  MODEL_NODE,

  { id: 'memory', name: 'Chat memory', type: '@n8n/n8n-nodes-langchain.memoryPostgresChat', typeVersion: 1.3, position: [1160, 320],
    parameters: { sessionIdType: 'customKey', sessionKey: '={{ $json.chat_id }}', contextWindowLength: 10 }, // 10 exchanges. Safe only because of 'Tidy memory' + 'Guard check' below — see shared/answer-guard.js
    credentials: { postgres: CRED_PG } },

  tool('run_discovery',
    "Run ONE search source now. COSTS MONEY AND ~6 MINUTES. " +
    "Call it immediately ONLY when the user used an explicit search verb — search, find me, look up, go get, dig into, run a search. " +
    "For anything phrased as a question ('what's happening with X', 'anything on X', 'how is X going') do NOT call this tool and do NOT offer it: read query_feed instead; when the feed has no answer the system answers from the web by itself. Call this tool only when the user explicitly asks to search, find, dig into or track something (or says yes to a sweep you confirmed). A wrong call costs six minutes of their machine. " +
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
      trigger: { fixed: 'agent' },
      // filled by n8n, not the model: WF-40's gate needs the user's actual words
      // and which chat they came from
      user_message: { fixed: "={{ $('Agent input').first().json.text }}" },
      chat_id: { fixed: "={{ $('Agent input').first().json.chat_id }}" } }, [1440, 320]),

  tool('scrape_url',
    'Ingest the links the user pasted: articles, PDFs, YouTube videos, podcast and audio links. Call it ONCE per message, even when the message has several links — it reads every link in the message itself. Cheap — execute immediately, no confirmation. ' +
    'Also call it, with url empty, when the user just says transcribe / listen / hear after being told a video has no captions. ' +
    'Videos are summarised in the background and each summary arrives as its own Telegram message; words like slides, deck, presentation, watch, look (read the screen) or transcribe, listen, hear (use the audio) in the message are picked up automatically. ' +
    'Reply with ONE short line based on the note it returns. Never write a summary of a video yourself.',
    WF.scrape_url,
    { url: { desc: 'one URL from the message (any of them), or empty for a bare transcribe request' },
      trigger: { fixed: 'agent' },
      user_message: { fixed: "={{ $('Agent input').first().json.text }}" } }, [1580, 320]),

  tool('query_feed',
    "Read EXISTING triaged results. Use for 'what did you find', 'show me', 'anything good last night'. NEVER triggers a new run. " +
    "CRITICAL: if the question implies ANY time window — today, tonight, last night, this morning, yesterday, this week, recently, just now — you MUST pass `since` as an ISO timestamp you compute from the current time given above. Omitting it returns the whole archive, and you will report old items as if they were new. " +
    "Only omit `since` for questions with no time element at all ('show me the best stuff', 'anything on agents'). " +
    "FILTERS COME ONLY FROM THE USER'S CURRENT WORDS. 'anything on X?' / 'what about X' / 'what do we have on X' = tag ONLY: no min_score, no max_age_days, no since — even if earlier messages asked for 'good' or 'this week'. Add min_score only when this message says good/best/top/worth reading; add a time filter only when this message names a time. Keep the user's topic words as they are; do not add words like 'ai' to tag. " +
    "Items are scored on two axes: specificity (1-5, how concrete and verifiable the claims are — vendor SEO content scores low) and angle_strength (1-5, how non-obvious the publishable hook is). score = the two added, 2-10. Use min_score 7+ for 'the good stuff', 8+ for 'only the best'. " +
    "Quality and recency are separate knobs and combine freely: min_score filters how good, max_age_days filters how fresh. 'anything good this week' = min_score 7 + max_age_days 7. Results always come back best-first. " +
    "Results are one row per story by default: several outlets covering the same event come back as one row with an articles count. Set group_stories to 'false' only when the user explicitly asks for every article or every source. " +
    "Put the question's topic in tag ('nvidia export control'). It searches titles, summaries AND the full text of every saved article and video transcript, by keyword AND by meaning, so plain wording works ('AI that can buy things' finds agent-payment items). " +
    "SPECIFIC QUESTIONS — who, how much, when, which, what did X say ('who bought Langfuse?', 'how much has Harvey raised?', 'what does the video say about shapes?') — are query_feed too: put the names and key nouns in tag ('Langfuse acquisition', 'Harvey funding') and answer from the items' evidence field, which is the matching passage of the article itself. Quote its figures and names, say which item number it came from, and give evidence.link when there is one (a video at that moment). If no evidence answers the question, say the feed does not say — never fill the gap from memory. For several topics at once — comparisons, 'X and Y' — separate them with | ('nigeria ai | bangladesh bank'), up to 3; each topic gets its own share of the results and every item says which topic it matched. With a topic, results come back most-relevant-first. If a topic search comes back empty, the feed really has nothing on it: say so in one sentence and stop (the web answer follows by itself; never offer a search). Time words and quality belong in max_age_days and min_score, never in tag. " +
    "Every item has a number n. Show it when you list items; follow-ups like 'the first one' go to get_item, not here. " +
    "Params: max_age_days (days since publication), min_score (2-10), since (ISO timestamp, for an exact cutoff), tag, limit (default 20), group_stories, min_relevance (legacy, leave empty).",
    WF.query_feed,
    { group_stories: { desc: "empty (one row per story, the default) or 'false' for every individual article" },
      max_age_days: { desc: 'only when THIS message names a time window; otherwise empty' },
      min_score: { desc: 'only when THIS message asks for good/best items; otherwise empty' },
      since: { desc: 'ISO timestamp lower bound, empty for none' },
      tag: { desc: 'the topic from the question (e.g. \'nvidia export control\'); several topics separated by | (max 3); empty for no topic. Matched by keyword and by meaning. Never put time words or quality words here' },
      limit: { desc: 'max items to return, empty for default 20' },
      min_relevance: { desc: 'legacy 1-5 filter, leave empty' },
      item: { fixed: '' },
      chat_id: { fixed: "={{ $('Agent input').first().json.chat_id }}" },
      // WF-31 drops min_score / time filters this message never asked for (shared/feed-search.js userFilters).
      user_text: { fixed: "={{ $('Agent input').first().json.text }}" } }, [1720, 320]),

  // Same workflow as query_feed, ITEM mode: resolves n against chat_results, the
  // list WF-31 stored for this chat. Its own tool because the router follows
  // tool descriptions far more than the system prompt (CLAUDE.md, Models).
  tool('get_item',
    "Fetch ONE item from the list you last showed in this chat, by its number n, with the cleaned text of the saved article (page_excerpt). Use for every follow-up about a listed item: 'the first one', '#3', 'tell me more about number 2', 'what does 4 say', '1. especially the global south part'. " +
    "Never re-run query_feed for these — a new query returns a different list. Answer from the summary and page_excerpt it returns. If it says the item is not found, ask which item they mean.",
    WF.query_feed,
    { item: { desc: 'the number n of the item in your last list, e.g. 3' },
      chat_id: { fixed: "={{ $('Agent input').first().json.chat_id }}" },
      since: { fixed: '' }, min_relevance: { fixed: '' }, tag: { fixed: '' }, limit: { fixed: '' },
      min_score: { fixed: '' }, max_age_days: { fixed: '' }, group_stories: { fixed: '' }, user_text: { fixed: '' } }, [1790, 440]),

  tool('run_status',
    "Report recent runs: when, scope, counts, ok/partial/failed. Use for 'did last night's run work', 'when did you last run', 'did anything break'.",
    WF.run_status,
    { limit: { desc: 'how many recent runs to return, empty for default 5' } }, [1860, 320]),

  tool('manage_sources',
    "Add, remove or list RSS feeds, or score every source. Use for 'add this feed', 'stop following X', 'what feeds are you watching'; action scorecard for 'how are my sources doing', 'which feeds are worth it', 'where do the good items come from' — report its numbers (good = score 7+), list silent feeds (0 items) by name, and never switch a source off unless asked. Params: action (add|remove|list|scorecard); url (for add/remove); label (optional); id (for remove); days (scorecard window, empty = all time).",
    WF.manage_sources,
    { action: { desc: 'add, remove, or list' },
      url: { desc: 'feed URL for add or remove, else empty' },
      label: { desc: 'short label for the feed, optional' },
      id: { desc: 'source id for remove, else empty' },
      days: { desc: 'scorecard only: look back this many days, empty for all time' } }, [2140, 320]),

  { id: 'prepreply', name: 'Prep reply', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1400, 100],
    parameters: { mode: 'runOnceForEachItem', jsCode: inline('telegram-format.js') + inline('feedback.js') + `
let chat_id = ${CHAT_ID};
try { chat_id = $('Record update').item.json.chat_id || chat_id; } catch (e) {
  try { chat_id = $('Test normalize').item.json.chat_id || chat_id; } catch (e2) {}
}
// 👍/👎 for the items this reply showed: the redo's steps and prefetch when the
// guard redid the answer, else the first agent's tool steps.
const sources = [];
if ($json.intermediateSteps) sources.push($json.intermediateSteps);
try { sources.push($('Prefetch').all().map((i) => i.json)); } catch (e) {}
if (!sources.length) { try { sources.push($('Overseer Agent').first().json.intermediateSteps); } catch (e) {} }
const reply_markup = $json.web === true ? undefined : listKeyboard(shownItems(sources));   /* web answers: no feed buttons */
return { json: { chat_id, output: forTelegram($json.output) || '(empty reply)', reply_markup, edit_id: $json.edit_id } };`.trim() } },

  // HTTP, not the Telegram node: the node's inline keyboard is fixed at build
  // time, and these buttons depend on the items each reply showed.
  { id: 'reply', name: 'Send reply', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1600, 100],
    // edit_id = the "searching the web…" message, which becomes the answer
    parameters: { method: 'POST', url: "={{ 'https://api.telegram.org/bot__TG_TOKEN__/' + ($json.edit_id ? 'editMessageText' : 'sendMessage') }}",
      sendBody: true, specifyBody: 'json',
      jsonBody: "={{ JSON.stringify(Object.assign({ chat_id: $json.chat_id, text: $json.output, parse_mode: 'HTML' }, $json.edit_id ? { message_id: $json.edit_id } : {}, $json.reply_markup ? { reply_markup: $json.reply_markup } : {})) }}",
      options: { timeout: 15000 } },
    retryOnFail: false, onError: 'continueRegularOutput' }
];

const connections = {
  'Poll updates': { main: [[{ node: 'Get offset', type: 'main', index: 0 }]] },
  'Get offset': { main: [[{ node: 'Fetch updates', type: 'main', index: 0 }]] },
  'Fetch updates': { main: [[{ node: 'Extract messages', type: 'main', index: 0 }]] },
  'Extract messages': { main: [[{ node: 'Record update', type: 'main', index: 0 }]] },
  'Record update': { main: [[{ node: 'Allowlisted?', type: 'main', index: 0 }]] },
  'Allowlisted?': { main: [
    [{ node: 'Feedback tap?', type: 'main', index: 0 }],
    []
  ] },
  'Test webhook': { main: [[{ node: 'Test normalize', type: 'main', index: 0 }]] },
  'Test normalize': { main: [[{ node: 'Feedback tap?', type: 'main', index: 0 }]] },
  'Feedback tap?': { main: [
    [{ node: 'Prep feedback', type: 'main', index: 0 }],
    [{ node: 'Feed switch?', type: 'main', index: 0 }]
  ] },
  'Prep feedback': { main: [[{ node: 'Save feedback', type: 'main', index: 0 }]] },
  'Save feedback': { main: [[{ node: 'Ack tap', type: 'main', index: 0 }]] },
  'Ack tap': { main: [[{ node: 'Answer tap', type: 'main', index: 0 }]] },
  'Answer tap': { main: [[{ node: 'Tick button', type: 'main', index: 0 }]] },
  'Feed switch?': { main: [
    [{ node: 'Toggle drain', type: 'main', index: 0 }],
    [{ node: 'Agent context', type: 'main', index: 0 }]
  ] },
  'Toggle drain': { main: [[{ node: 'Switch reply', type: 'main', index: 0 }]] },
  'Switch reply': { main: [[{ node: 'Send reply', type: 'main', index: 0 }]] },
  [MODEL_NODE.name]: { ai_languageModel: [[{ node: 'Overseer Agent', type: 'ai_languageModel', index: 0 }, { node: 'Guarded agent', type: 'ai_languageModel', index: 0 }]] },
  'Chat memory': { ai_memory: [[{ node: 'Overseer Agent', type: 'ai_memory', index: 0 }]] },
  'run_discovery': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }, { node: 'Guarded agent', type: 'ai_tool', index: 0 }]] },
  'full_sweep': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }, { node: 'Guarded agent', type: 'ai_tool', index: 0 }]] },
  'scrape_url': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }, { node: 'Guarded agent', type: 'ai_tool', index: 0 }]] },
  'query_feed': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }, { node: 'Guarded agent', type: 'ai_tool', index: 0 }]] },
  'get_item': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }, { node: 'Guarded agent', type: 'ai_tool', index: 0 }]] },
  'run_status': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }, { node: 'Guarded agent', type: 'ai_tool', index: 0 }]] },
  'manage_sources': { ai_tool: [[{ node: 'Overseer Agent', type: 'ai_tool', index: 0 }, { node: 'Guarded agent', type: 'ai_tool', index: 0 }]] },
  'Agent context': { main: [[{ node: 'Agent input', type: 'main', index: 0 }]] },
  'Agent input': { main: [[{ node: 'Has link?', type: 'main', index: 0 }]] },
  'Has link?': { main: [[{ node: 'Ingest links', type: 'main', index: 0 }], [{ node: 'Recall prep', type: 'main', index: 0 }]] },
  'Recall prep': { main: [[{ node: 'Recall embed', type: 'main', index: 0 }]] },
  'Recall embed': { main: [[{ node: 'Recall sql', type: 'main', index: 0 }]] },
  'Recall sql': { main: [[{ node: 'Recall search', type: 'main', index: 0 }]] },
  'Recall search': { main: [[{ node: 'Recall note', type: 'main', index: 0 }]] },
  'Recall note': { main: [[{ node: 'Last bot msg', type: 'main', index: 0 }]] },
  'Last bot msg': { main: [[{ node: 'Big picture?', type: 'main', index: 0 }]] },
  'Big picture?': { main: [[{ node: 'Sweep?', type: 'main', index: 0 }]] },
  'Sweep?': { main: [[{ node: 'Run sweep', type: 'main', index: 0 }], [{ node: 'Sweep declined?', type: 'main', index: 0 }]] },
  'Sweep declined?': { main: [[{ node: 'Sweep reply', type: 'main', index: 0 }], [{ node: 'Synth?', type: 'main', index: 0 }]] },
  'Run sweep': { main: [[{ node: 'Sweep reply', type: 'main', index: 0 }]] },
  'Sweep reply': { main: [[{ node: 'Sweep memory', type: 'main', index: 0 }]] },
  'Sweep memory': { main: [[{ node: 'Sweep out', type: 'main', index: 0 }]] },
  // straight to the reply: no web fallback after a sweep or a declined one
  'Sweep out': { main: [[{ node: 'Prep reply', type: 'main', index: 0 }, { node: 'Memory text', type: 'main', index: 0 }]] },
  'Synth?': { main: [[{ node: 'Synth answer', type: 'main', index: 0 }], [{ node: 'Overseer Agent', type: 'main', index: 0 }]] },
  'Synth answer': { main: [[{ node: 'Synth memory text', type: 'main', index: 0 }]] },
  'Synth memory text': { main: [[{ node: 'Synth memory', type: 'main', index: 0 }]] },
  'Synth memory': { main: [[{ node: 'Synth result', type: 'main', index: 0 }]] },
  'Synth result': { main: [[{ node: 'Web needed?', type: 'main', index: 0 }]] },
  'Ingest links': { main: [[{ node: 'Link note', type: 'main', index: 0 }]] },
  'Link note': { main: [[{ node: 'Overseer Agent', type: 'main', index: 0 }]] },
  'Overseer Agent': { main: [[{ node: 'Guard check', type: 'main', index: 0 }]] },
  'Guard check': { main: [[{ node: 'Redo?', type: 'main', index: 0 }]] },
  'Redo?': { main: [[{ node: 'Source question?', type: 'main', index: 0 }], [{ node: 'Fit prep', type: 'main', index: 0 }]] },
  'Source question?': { main: [[{ node: 'Scorecard prefetch', type: 'main', index: 0 }], [{ node: 'Prefetch', type: 'main', index: 0 }]] },
  'Prefetch': { main: [[{ node: 'Redo context', type: 'main', index: 0 }]] },
  'Scorecard prefetch': { main: [[{ node: 'Redo context', type: 'main', index: 0 }]] },
  'Redo context': { main: [[{ node: 'Guarded agent', type: 'main', index: 0 }]] },
  'Guarded agent': { main: [[{ node: 'Final check', type: 'main', index: 0 }]] },
  'Final check': { main: [[{ node: 'Fit prep', type: 'main', index: 0 }]] },
  'Fit prep': { main: [[{ node: 'Fit?', type: 'main', index: 0 }]] },
  'Fit?': { main: [[{ node: 'Fit judge', type: 'main', index: 0 }], [{ node: 'Web needed?', type: 'main', index: 0 }]] },
  'Fit judge': { main: [[{ node: 'Fit apply', type: 'main', index: 0 }]] },
  'Fit apply': { main: [[{ node: 'Web needed?', type: 'main', index: 0 }]] },
  'Web needed?': { main: [[{ node: 'Judge?', type: 'main', index: 0 }]] },
  'Judge?': { main: [[{ node: 'Judge', type: 'main', index: 0 }], [{ node: 'Web?', type: 'main', index: 0 }]] },
  'Judge': { main: [[{ node: 'Judge verdict', type: 'main', index: 0 }]] },
  'Judge verdict': { main: [[{ node: 'Web?', type: 'main', index: 0 }]] },
  'Web?': { main: [[{ node: 'Web context', type: 'main', index: 0 }], [{ node: 'Prep reply', type: 'main', index: 0 }, { node: 'Memory text', type: 'main', index: 0 }]] },
  'Web context': { main: [[{ node: 'Standalone prep', type: 'main', index: 0 }]] },
  'Standalone prep': { main: [[{ node: 'Standalone question', type: 'main', index: 0 }]] },
  'Standalone question': { main: [[{ node: 'Web query', type: 'main', index: 0 }]] },
  'Web query': { main: [[{ node: 'Searching status', type: 'main', index: 0 }]] },
  'Searching status': { main: [[{ node: 'Web answer', type: 'main', index: 0 }]] },
  'Web answer': { main: [[{ node: 'Use web answer', type: 'main', index: 0 }]] },
  'Use web answer': { main: [[{ node: 'Prep reply', type: 'main', index: 0 }, { node: 'Memory text', type: 'main', index: 0 }]] },
  'Memory text': { main: [[{ node: 'Fix memory', type: 'main', index: 0 }, { node: 'Remember prep', type: 'main', index: 0 }]] },
  'Remember prep': { main: [[{ node: 'Remember embed', type: 'main', index: 0 }]] },
  'Remember embed': { main: [[{ node: 'Remember sql', type: 'main', index: 0 }]] },
  'Remember sql': { main: [[{ node: 'Remember', type: 'main', index: 0 }]] },
  'Prep reply': { main: [[{ node: 'Send reply', type: 'main', index: 0 }, { node: 'Tidy memory', type: 'main', index: 0 }]] }
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
