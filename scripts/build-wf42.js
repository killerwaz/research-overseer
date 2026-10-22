// Builds workflows/wf42-scrape-url.json and workflows/wf43-media-queue.json.
// Run: node scripts/build-wf42.js
//
// WF-42 scrape_url (router tool). Reads EVERY link and trigger word from the
// user's whole message (n >= 1 links, Wasim's choice 2026-10-11), not just the
// one URL the model passes — so the model calling the tool once, or once per
// link, gives the same result (a repeat call for the same message within two
// minutes is ignored).
//   articles -> WF-20 right away (as before)
//   media    -> WF-43, in the background: one video at a time, one Telegram
//               message per video as it finishes
// A bare "transcribe" (no link) means the last video that had no captions.
//
// WF-43 media_queue. A video already in the feed gets its stored summary
// re-sent (no YouTube request at all) unless slides/transcribe asks for more.
const fs = require('fs');
const path = require('path');

const I = require('./ids.js').PLACEHOLDERS;
const CRED_PG = I.credentials.postgres;
const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
  .replace(/module\.exports[\s\S]*$/, '');

const pg = (name, id, pos, query, replacement, extra = {}) => Object.assign({
  id, name, type: 'n8n-nodes-base.postgres', typeVersion: 2.4, position: pos,
  parameters: { operation: 'executeQuery', query, options: replacement ? { queryReplacement: replacement } : {} },
  credentials: { postgres: CRED_PG } }, extra);
const code = (name, id, pos, jsCode, mode = 'runOnceForAllItems') => ({ id, name, type: 'n8n-nodes-base.code', typeVersion: 2,
  position: pos, parameters: { mode, jsCode } });
const ifNode = (name, id, pos, expr) => ({ id, name, type: 'n8n-nodes-base.if', typeVersion: 2, position: pos,
  parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    combinator: 'and', conditions: [ { id: 'c1', leftValue: expr, rightValue: true, operator: { type: 'boolean', operation: 'equals' } } ] } } });
const execWf = (name, id, pos, wfToken, value, types, extra = {}) => Object.assign({
  id, name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: pos,
  parameters: { workflowId: { __rl: true, value: wfToken, mode: 'id' },
    workflowInputs: { mappingMode: 'defineBelow', value, matchingColumns: [],
      schema: Object.keys(value).map((k) => ({ id: k, displayName: k, required: false, defaultMatch: false, display: true,
        canBeUsedToMatch: true, type: types[k] || 'string' })) },
    options: { waitForSubWorkflow: true } } }, extra);

// ---------------- WF-42 ----------------
const PLAN = inline('media.js') + `
const j = $input.first().json;
const req = parseMediaRequest(j.user_message || '', j.url || '');
return [{ json: { trigger: j.trigger || 'agent', user_message: String(j.user_message || j.url || ''), ...req,
  need_last: req.urls.length === 0 && req.transcribe } }];
`.trim();

// Dedupe across tool calls for one message + fetch the remembered no-captions link
const GUARD_SQL = "with prev as (select value, updated_at from settings where key = 'last_scrape_msg'), " +
  "up as (insert into settings (key, value, updated_at) values ('last_scrape_msg', $1, now()) on conflict (key) do update set value = excluded.value, updated_at = now()) " +
  "select coalesce((select value = $1 and updated_at > now() - interval '2 minutes' from prev), false) as dup, " +
  "(select value from settings where key = 'last_no_captions_url') as last_no_captions";

const SPLIT = inline('media.js') + `
const p = $('Plan').first().json;
const g = $input.first().json;
if (g.dup === true || g.dup === 't') return [{ json: { dup: true, media: [], other: [], trigger: p.trigger } }];
let urls = p.urls;
let transcribe = p.transcribe;
if (p.need_last) {
  if (!g.last_no_captions) return [{ json: { media: [], other: [], trigger: p.trigger,
    note: 'There is no recent video without captions to transcribe. Ask the user to send the link with the word transcribe.' } }];
  urls = [g.last_no_captions];
  transcribe = true;
}
const media = urls.filter(isMediaUrl).map((url) => ({ url, slides: p.slides, transcribe, instruction: p.instruction || '' }));
const other = urls.filter((u) => !isMediaUrl(u)).map((url) => ({ url, source: 'manual' }));
return [{ json: { media, other, trigger: p.trigger } }];
`.trim();

const RETURN42 = `
const s = $('Split').first().json;
if (s.dup) return [{ json: { note: 'Already handled for this message. Do not call scrape_url again; reply in one short line.' } }];
if (s.note) return [{ json: { note: s.note } }];
let article = null;
try { article = $('Run WF-20').first().json; } catch (e) {}
const n = s.media.length;
const notes = [];
if (n) notes.push(n + ' video/audio link' + (n === 1 ? '' : 's') + ' queued. Each summary (or a no-captions / blocked notice) is sent to the user as its own Telegram message, one at a time, about 30 s to 2 min each. Reply in ONE short line, e.g. "On it — ' + n + ' video' + (n === 1 ? '' : 's') + ' queued, summaries will arrive one by one." Do not summarise anything yourself.');
if (article) notes.push('Article result: ' + JSON.stringify({ status: article.status, items_created: article.items_created, top_title: article.top_title }));
return [{ json: { media_queued: n, articles: s.other.length, note: notes.join(' ') } }];
`.trim();

const wf42 = {
  name: 'WF-42 scrape_url',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: [ { name: 'url', type: 'string' }, { name: 'trigger', type: 'string' },
        { name: 'user_message', type: 'string' } ] } } },
    code('Plan', 'plan', [200, 0], PLAN),
    pg('Guard', 'guard', [400, 0], GUARD_SQL, "={{ $json.user_message }}", { executeOnce: true, alwaysOutputData: true }),
    code('Split', 'split', [600, 0], SPLIT),
    ifNode('Any media?', 'anymedia', [800, -100], '={{ $json.media.length > 0 }}'),
    // fire-and-forget: the router must not wait minutes for a batch
    execWf('Queue media', 'queue', [1000, -200], '__WF43__',
      { items_json: '={{ JSON.stringify($json.media) }}', trigger: '={{ $json.trigger }}' }, {},
      { parameters: undefined }),
    ifNode('Any articles?', 'anyarticles', [1200, 0], "={{ $('Split').first().json.other.length > 0 }}"),
    execWf('Run WF-20', 'run20', [1400, -100], '__WF20__',
      { urls: "={{ $('Split').first().json.other }}", trigger: "={{ $('Split').first().json.trigger }}", scope: 'url' },
      { urls: 'array' }),
    code('Return', 'ret', [1600, 0], RETURN42)
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Plan', type: 'main', index: 0 }]] },
    'Plan': { main: [[{ node: 'Guard', type: 'main', index: 0 }]] },
    'Guard': { main: [[{ node: 'Split', type: 'main', index: 0 }]] },
    'Split': { main: [[{ node: 'Any media?', type: 'main', index: 0 }]] },
    'Any media?': { main: [[{ node: 'Queue media', type: 'main', index: 0 }], [{ node: 'Any articles?', type: 'main', index: 0 }]] },
    'Queue media': { main: [[{ node: 'Any articles?', type: 'main', index: 0 }]] },
    'Any articles?': { main: [[{ node: 'Run WF-20', type: 'main', index: 0 }], [{ node: 'Return', type: 'main', index: 0 }]] },
    'Run WF-20': { main: [[{ node: 'Return', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: I.workflows['wf99-error-workflow'] }
};
// the queue call must not block the router
const q = wf42.nodes.find((n) => n.name === 'Queue media');
q.parameters = execWf('x', 'x', [0, 0], '__WF43__',
  { items_json: '={{ JSON.stringify($json.media) }}', trigger: '={{ $json.trigger }}' }, {}).parameters;
q.parameters.options.waitForSubWorkflow = false;

// ---------------- WF-43 ----------------
const ITEMS = inline('canonicalize.js') + `
const j = $input.first().json;
let items = [];
try { items = JSON.parse(j.items_json || '[]'); } catch (e) {}
const out = items.map((m) => ({ url: m.url, canonical_url: canon(m.url) || m.url, slides: Boolean(m.slides), transcribe: Boolean(m.transcribe), instruction: String(m.instruction || '') }));
if (!out.length) return [];
const esc = (u) => String(u).replace(/'/g, "''");
const query = "select coalesce(json_object_agg(f.canonical_url, json_build_object('id', f.id, 'title', f.title, 'summary', f.summary, 'score', f.score, " +
  "'canonical_url', f.canonical_url, 'key_points', f.structured->'key_points', 'transcript_source', substr(d.scraper, 7))), '{}')::text as stored " +
  "from feed_items f join raw_docs d on d.id = f.raw_doc_id where d.scraper like 'media:%' and f.canonical_url in (" +
  out.map((o) => "'" + esc(o.canonical_url) + "'").join(',') + ")";
return [{ json: { items: out, trigger: j.trigger || 'agent', query } }];
`.trim();

const DECIDE = `
const s = $('Items').first().json;
let stored = {};
try { stored = JSON.parse($input.first().json.stored || '{}'); } catch (e) {}
return s.items.map((it) => {
  const have = stored[it.canonical_url];
  const reuse = Boolean(have) && !it.slides && !it.transcribe;
  return { json: { ...it, reuse, stored: reuse ? have : null, trigger: s.trigger } };
});
`.trim();

const REUSE_MSG = inline('media.js') + inline('feedback.js') + `
return { json: { text: '\\u{1F4DA} Already in your feed:\\n\\n' + mediaMessage($json.stored), reply_markup: itemKeyboard($json.stored.id) } };
`.trim();

// a re-sent summary is recorded like a fresh one (WF-20 'Record prep'):
// memory row + the chat's list = this video (shared/referent.js)
const RECORD_STORED = inline('referent.js') + `
const msgs = $('Stored message').all();
const decided = $('Decide').all().filter((i) => i.json.reuse && !i.json.instruction);
return $input.all().map((r, k) => ({ json: { sql: r.json.ok === true && msgs[k] && decided[k]
  ? botSaidSql('__TG_CHAT__', msgs[k].json.text, [decided[k].json.stored.id], 'media') : 'select 1 as skipped' } }));
`.trim();

// ---- an instruction sent with the link (2026-10-18, shared/referent.js) ----
// "<link> summarize it without timestamps": a stored video gets the answer
// INSTEAD of its stored summary; a new one gets WF-20's summary first (that is
// the record) and the answer after it. The 9B answers from the item's own text,
// thinking off, figure-checked; a failed answer = the summary without times.
const PICK = (from) => inline('referent.js') + `
return ${from}.filter((i) => i.json.instruction).map((i) => ({ json: { sql: itemLookupSql(i.json.canonical_url, i.json.instruction) } }));
`.trim();
const ANSWER_PREP = inline('answer-check.js') + inline('referent.js') + `
return $input.all().filter((i) => Number(i.json.id) > 0).map((i) => ({ json: { item: i.json,
  llm_body: JSON.stringify(itemBody('qwen/qwen3.5-9b', i.json.instruction, i.json)) } }));
`.trim();
const ANSWER_REPLY = inline('answer-check.js') + inline('referent.js') + inline('feedback.js') + `
const preps = $('Answer prep').all();
return $input.all().map((r, k) => {
  const item = preps[k].json.item;
  let content = '';
  try { content = r.json.choices[0].message.content; } catch (e) {}
  const a = itemAnswer(content, item, item.instruction);
  return { json: { id: item.id, text: answerMessage(item, a.output), reply_markup: itemKeyboard(item.id), fallback: a.fallback } };
});
`.trim();
const RECORD_ANSWER = inline('referent.js') + `
const msgs = $('Answer reply').all();
return $input.all().map((r, k) => ({ json: { sql: r.json.ok === true && msgs[k]
  ? botSaidSql('__TG_CHAT__', msgs[k].json.text, [msgs[k].json.id], 'media') : 'select 1 as skipped' } }));
`.trim();
const lmHttp = (name, id, pos) => ({ id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
    authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.llm_body }}', options: { timeout: 90000 } },
  credentials: { httpBearerAuth: I.credentials.lmstudio }, retryOnFail: false, onError: 'continueRegularOutput' });
const tgSend = (name, id, pos) => ({ id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  parameters: { method: 'POST', url: 'https://api.telegram.org/bot__TG_TOKEN__/sendMessage',
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify(Object.assign({ chat_id: '__TG_CHAT__', text: $json.text, parse_mode: 'HTML' }, $json.reply_markup ? { reply_markup: $json.reply_markup } : {})) }}",
    options: { timeout: 15000 } },
  retryOnFail: false, onError: 'continueRegularOutput' });

const wf43 = {
  name: 'WF-43 media_queue',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: [ { name: 'items_json', type: 'string' }, { name: 'trigger', type: 'string' } ] } } },
    code('Items', 'items', [200, 0], ITEMS),
    pg('Stored summaries', 'stored', [400, 0], '={{ $json.query }}', null, { executeOnce: true, alwaysOutputData: true }),
    code('Decide', 'decide', [600, 0], DECIDE),
    ifNode('Already summarised?', 'reuse', [800, 0], '={{ $json.reuse }}'),
    code('Stored message', 'reusemsg', [1000, -150], REUSE_MSG, 'runOnceForEachItem'),
    // HTTP so the summary can carry its item's 👍/👎 buttons (shared/feedback.js)
    { id: 'tg', name: 'Send stored', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1200, -150],
      parameters: { method: 'POST', url: 'https://api.telegram.org/bot__TG_TOKEN__/sendMessage',
        sendBody: true, specifyBody: 'json',
        jsonBody: "={{ JSON.stringify(Object.assign({ chat_id: '__TG_CHAT__', text: $json.text, parse_mode: 'HTML' }, $json.reply_markup ? { reply_markup: $json.reply_markup } : {})) }}",
        options: { timeout: 15000 } },
      retryOnFail: false, onError: 'continueRegularOutput' },
    code('Record prep', 'recordprep', [1400, -150], RECORD_STORED),
    pg('Record send', 'recordsend', [1600, -150], '={{ $json.sql }}', null, { alwaysOutputData: true, onError: 'continueRegularOutput' }),
    ifNode('Instruction?', 'instr', [900, -50], '={{ Boolean($json.instruction) }}'),
    code('Answer pick (stored)', 'pickstored', [1000, 300], PICK('$input.all()')),
    code('Answer pick (new)', 'picknew', [1200, 300], PICK("$('Decide').all().filter((i) => !i.json.reuse)")),
    pg('Answer item', 'answeritem', [1400, 300], '={{ $json.sql }}', null, { alwaysOutputData: true, onError: 'continueRegularOutput' }),
    code('Answer prep', 'answerprep', [1600, 300], ANSWER_PREP),
    lmHttp('Answer model', 'answermodel', [1800, 300]),
    code('Answer reply', 'answerreply', [2000, 300], ANSWER_REPLY),
    tgSend('Send answer', 'sendanswer', [2200, 300]),
    code('Record answer prep', 'recordanswerprep', [2400, 300], RECORD_ANSWER),
    pg('Record answer', 'recordanswer', [2600, 300], '={{ $json.sql }}', null, { alwaysOutputData: true, onError: 'continueRegularOutput' }),
    // one WF-20 run per video, waited on in turn: summaries arrive one by one,
    // and the media service's own pacing spaces the YouTube requests
    Object.assign(execWf('Process video', 'process', [1000, 150], '__WF20__',
      { urls: '={{ [{ url: $json.url, source: "manual", slides: $json.slides, transcribe: $json.transcribe }] }}',
        trigger: '={{ $json.trigger }}', scope: 'url' }, { urls: 'array' }), { onError: 'continueRegularOutput' })
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Items', type: 'main', index: 0 }]] },
    'Items': { main: [[{ node: 'Stored summaries', type: 'main', index: 0 }]] },
    'Stored summaries': { main: [[{ node: 'Decide', type: 'main', index: 0 }]] },
    'Decide': { main: [[{ node: 'Already summarised?', type: 'main', index: 0 }]] },
    'Already summarised?': { main: [[{ node: 'Instruction?', type: 'main', index: 0 }], [{ node: 'Process video', type: 'main', index: 0 }]] },
    'Instruction?': { main: [[{ node: 'Answer pick (stored)', type: 'main', index: 0 }], [{ node: 'Stored message', type: 'main', index: 0 }]] },
    'Process video': { main: [[{ node: 'Answer pick (new)', type: 'main', index: 0 }]] },
    'Answer pick (stored)': { main: [[{ node: 'Answer item', type: 'main', index: 0 }]] },
    'Answer pick (new)': { main: [[{ node: 'Answer item', type: 'main', index: 0 }]] },
    'Answer item': { main: [[{ node: 'Answer prep', type: 'main', index: 0 }]] },
    'Answer prep': { main: [[{ node: 'Answer model', type: 'main', index: 0 }]] },
    'Answer model': { main: [[{ node: 'Answer reply', type: 'main', index: 0 }]] },
    'Answer reply': { main: [[{ node: 'Send answer', type: 'main', index: 0 }]] },
    'Send answer': { main: [[{ node: 'Record answer prep', type: 'main', index: 0 }]] },
    'Record answer prep': { main: [[{ node: 'Record answer', type: 'main', index: 0 }]] },
    'Stored message': { main: [[{ node: 'Send stored', type: 'main', index: 0 }]] },
    'Send stored': { main: [[{ node: 'Record prep', type: 'main', index: 0 }]] },
    'Record prep': { main: [[{ node: 'Record send', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: I.workflows['wf99-error-workflow'] }
};
wf43.nodes.find((n) => n.name === 'Process video').parameters.mode = 'each';

for (const [file, wf] of [['wf42-scrape-url.json', wf42], ['wf43-media-queue.json', wf43]]) {
  const out = path.join(__dirname, '..', 'workflows', file);
  fs.writeFileSync(out, JSON.stringify(wf, null, 2));
  console.log('wrote', out);
}
