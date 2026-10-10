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

const I = require('./instance.json');
const CRED_PG = I.credentials.postgres;
const CRED_TG = I.credentials.telegram;
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
const media = urls.filter(isMediaUrl).map((url) => ({ url, slides: p.slides, transcribe }));
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
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
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
const out = items.map((m) => ({ url: m.url, canonical_url: canon(m.url) || m.url, slides: Boolean(m.slides), transcribe: Boolean(m.transcribe) }));
if (!out.length) return [];
const esc = (u) => String(u).replace(/'/g, "''");
const query = "select coalesce(json_object_agg(f.canonical_url, json_build_object('title', f.title, 'summary', f.summary, 'score', f.score, " +
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

const REUSE_MSG = inline('media.js') + `
return { json: { text: '\\u{1F4DA} Already in your feed:\\n\\n' + mediaMessage($json.stored) } };
`.trim();

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
    { id: 'tg', name: 'Send stored', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [1200, -150],
      parameters: { chatId: '__TG_CHAT__', text: '={{ $json.text }}', additionalFields: { appendAttribution: false, parse_mode: 'HTML' } },
      credentials: { telegramApi: CRED_TG }, onError: 'continueRegularOutput' },
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
    'Already summarised?': { main: [[{ node: 'Stored message', type: 'main', index: 0 }], [{ node: 'Process video', type: 'main', index: 0 }]] },
    'Stored message': { main: [[{ node: 'Send stored', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};
wf43.nodes.find((n) => n.name === 'Process video').parameters.mode = 'each';

for (const [file, wf] of [['wf42-scrape-url.json', wf42], ['wf43-media-queue.json', wf43]]) {
  const out = path.join(__dirname, '..', 'workflows', file);
  fs.writeFileSync(out, JSON.stringify(wf, null, 2));
  console.log('wrote', out);
}
