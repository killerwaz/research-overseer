// "summarize the video without the timestamps" (2026-10-18): the router read
// "summarize" as a big-picture question and WF-45 wrote an overview of every
// feed item with "video" in it (an n8n tutorial, a Mod Sun music video...).
// Three gaps, fixed together:
//   1. messages sent outside the agent (WF-20 media/link summaries, WF-43
//      re-sends) never reached chat memory or chat_results, so "the video" had
//      nothing to point at -> botSaidSql records every such send;
//   2. keyword routes (synth) ran before anyone asked whether the message points
//      at something already shown -> refRoute runs first, in code;
//   3. "without the timestamps" had nowhere to go -> itemBody/itemAnswer rewrite
//      the one item as asked, from its own text only, figure-checked.
// Inlined into WF-00 (routing, answer), WF-20 and WF-43 (recording).
// Needs unsupportedFacts from answer-check.js inlined first (itemAnswer only).

// things the bot shows one of; plurals ("the videos about agents") are topics
const REF_NOUN = '(?:video|clip|talk|podcast|episode|article|story|item|link|page|piece|post|paper|report|thread|interview|one|result|transcript)';
// "the video", "that article", "this one", "the last link"
const REF_PHRASE = new RegExp('\\b(?:the|that|this|your|ur)\\s+(?:last\\s+|latest\\s+|previous\\s+|same\\s+)?' + REF_NOUN + '\\b(?![-\'’]?s\\b)', 'i');
// ...followed by a description: may be a search, so the agent decides
const REF_DESCRIBED = new RegExp(REF_PHRASE.source + '\\s+(?:about|on|from|by|with|where|that|which|called|titled|named)\\b', 'i');
// "summarize it", "what does it say", "tell me more about that"
const REF_PRONOUN = new RegExp([
  '\\b(?:summari[sz]e|recap|explain|shorten|simplify|rewrite|redo|reformat|translate|tl;?dr|break down|go over|unpack)\\s+(?:it|this|that)\\b',
  '\\bwhat (?:does|did|is) (?:it|this|that) (?:say|said|cover|mean|about|argue|claim|conclude)',
  '\\b(?:more|tell me|anything else) (?:more )?(?:about|on) (?:it|this|that)\\b',
  // whole-message only: "is it worth it to switch to X" is a question of its own
  '^(?:so |and |but )?(?:is|was) (?:it|this|that) (?:worth (?:it|watching|reading|a look)|any good|legit|accurate)\\s*[?.!]*$',
].join('|'), 'i');
// a bare instruction with nothing else in it: "summarize without timestamps", "shorter please"
const TRANSFORM_VERB = /^(?:can you |could you |please |pls |now |ok(?:ay)?,? )*(summari[sz]e|recap|shorten|simplify|rewrite|redo|reformat|tl;?dr|summary|shorter|simpler|briefer|again)\b/i;
const FORMAT_WORDS = /\b(?:without|with|no|minus|skip|drop|remove|the|a|an|any|all|in|into|as|to|of|for|me|just|only|please|pls|it|this|that|again|version|summary|plain|simple|simpler|short|shorter|brief|briefly|quick|quickly|english|text|prose|paragraphs?|bullets?|bullet points?|points?|lines?|sentences?|words?|timestamps?|time ?stamps?|times|links?|emojis?|numbers?|formatting|one|two|three|four|five|\d+)\b/gi;

// What the message points at, from its words alone:
//   'bare'      - one shown thing, no description ("summarize the video", "is it any good?")
//   'described' - a shown thing picked by description ("the article about nvidia")
//   ''          - not a reference; normal routing
function referentKind(text) {
  const t = String(text || '').trim();
  if (!t || /https?:\/\//i.test(t)) return '';
  if (REF_DESCRIBED.test(t)) return 'described';
  if (REF_PHRASE.test(t) || REF_PRONOUN.test(t)) return 'bare';
  const m = TRANSFORM_VERB.exec(t);
  if (m && !t.slice(m[0].length).replace(FORMAT_WORDS, ' ').replace(/[^a-z]+/gi, ' ').trim()) return 'bare';
  return '';
}

// the last list shown counts for this long
const REF_WINDOW_MIN = 120;

const MEDIA_NOUN = /\b(?:video|clip|talk|podcast|episode|interview|transcript)\b/i;
const MEDIA_URL = /youtube\.com\/watch|youtu\.be\/|vimeo\.com|soundcloud\.com|podcasts\.apple\.com|twitch\.tv|ted\.com\/talks|rumble\.com/i;

// The route, given the last list this chat was shown (chat_results, with each
// item's title and url in list order):
//   { route: 'item', n }  - it can only mean item n: answered here, in code
//                           (one item shown, or "the video" and one video shown)
//   { route: 'agent' }    - several fit: the agent picks with get_item, told the list
//   { route: '' }         - no reference, or nothing recent to refer to
function refRoute(text, list) {
  const kind = referentKind(text);
  const l = list || {};
  const items = Array.isArray(l.items) ? l.items : [];
  const n = Number(l.n) || items.length;
  const age = Number(l.age_min);
  if (!kind || !n || !(age >= 0 && age <= REF_WINDOW_MIN)) return { route: '' };
  if (kind === 'bare' && n === 1) return { route: 'item', n: 1 };
  if (kind === 'bare' && MEDIA_NOUN.test(text)) {
    const vids = items.map((it, k) => ({ k: k + 1, media: MEDIA_URL.test(String(it.url || '')) })).filter((x) => x.media);
    if (vids.length === 1) return { route: 'item', n: vids[0].k };
  }
  return { route: 'agent' };
}

// what the agent is told on the 'agent' route: the list itself (memory may not
// hold it: a WF-31 list is in memory only as the reply text, if at all)
function refNote(list) {
  const items = (list && Array.isArray(list.items) ? list.items : []).slice(0, 10);
  return '[This message points at something already shown in this chat. The last list shown: ' +
    (items.map((it, k) => (k + 1) + '. ' + String(it.title || it.url || '').slice(0, 120)).join('; ') || 'unknown') +
    '. If the message means one of these, call get_item with its number (never query_feed for it) and follow any format instruction in the message (shorter, no timestamps, bullets). If it fits none, ask which one they mean.]';
}

// Telegram HTML -> what he read, for memory
function plainText(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}

// One message the bot sent outside the agent: an ai memory row tagged with its
// source (Fix memory and the sweep check skip tagged rows: a video can arrive
// while an answer is being written), and, when it showed items, the chat's
// numbered list, so "#1" / "the video" resolve to it. base64 keeps web text out
// of the SQL (CLAUDE.md: '$785606.5' breaks the Postgres node).
// His message + the reply, as the two memory rows the agent's memory node would have
// written, for replies made in code (brief, save, PDF, synth). One helper instead of
// four hand-built copies (review 2026-10-21). Text as base64; no trailing ';'.
function exchangeSql(chatId, human, ai) {
  const chat = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d+$/.test(chat)) return 'select 1 as skipped';
  const t = (s) => "convert_from(decode('" + Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64') + "', 'base64'), 'UTF8')";
  return "insert into n8n_chat_histories (session_id, message) values ('" + chat + "', jsonb_build_object('type', 'human', 'content', " + t(human) +
    ", 'additional_kwargs', '{}'::jsonb, 'response_metadata', '{}'::jsonb)), ('" + chat + "', jsonb_build_object('type', 'ai', 'content', " + t(ai) +
    ", 'tool_calls', '[]'::jsonb, 'invalid_tool_calls', '[]'::jsonb, 'additional_kwargs', '{}'::jsonb, 'response_metadata', '{}'::jsonb))";
}

function botSaidSql(chatId, html, itemIds, source) {
  const chat = String(chatId || '').trim();
  const text = plainText(html);
  if (!/^-?\d+$/.test(chat) || !text) return 'select 1 as skipped';
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const src = String(source || 'system').replace(/[^a-z0-9_-]/gi, '');
  const ids = (itemIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  const mem = "insert into n8n_chat_histories (session_id, message) values ('" + chat + "', jsonb_build_object('type', 'ai', 'content', " +
    "convert_from(decode('" + b64 + "', 'base64'), 'UTF8'), 'tool_calls', '[]'::jsonb, 'invalid_tool_calls', '[]'::jsonb, " +
    "'additional_kwargs', jsonb_build_object('source', '" + src + "'), 'response_metadata', '{}'::jsonb))";
  if (!ids.length) return mem + ' returning id';
  return 'with m as (' + mem + ' returning id) ' +
    'insert into chat_results (chat_id, item_ids, topic, created_at) values (' + chat + ', array[' + ids.join(',') + ']::bigint[], null, now()) ' +
    'on conflict (chat_id) do update set item_ids = excluded.item_ids, topic = excluded.topic, created_at = excluded.created_at returning (select id from m) as id';
}

// SQL filter for "rows the agent wrote" (untagged)
const AGENT_ROWS = "coalesce(message->'additional_kwargs'->>'source', '') = ''";

// the item's own words: summary, key points (times dropped), page text
function itemText(item) {
  const it = item || {};
  const pts = ((it.structured || {}).key_points || it.key_points || []).map((p) => '- ' + (p.point || p)).join('\n');
  return [it.title && 'Title: ' + it.title, it.summary && 'Summary: ' + it.summary, pts && 'Key points:\n' + pts,
    it.page_excerpt && 'Saved text (excerpt):\n' + String(it.page_excerpt).slice(0, 6000)].filter(Boolean).join('\n\n');
}

const ITEM_SYSTEM = 'You answer a request about ONE item the user was just shown (an article or video from their research feed). ' +
  'Use ONLY the item text given. Follow the request\'s format instructions exactly (e.g. no timestamps, shorter, bullets, plain prose). ' +
  'Never add facts, names or numbers that are not in the item text; if it does not say, say so. ' +
  'Plain text, no markdown, no timestamps unless asked. Start with the answer, not with "Sure".';

// LM Studio body, thinking off (reasoning_effort none: CLAUDE.md, Models)
function itemBody(model, request, item) {
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 900,
    messages: [{ role: 'system', content: ITEM_SYSTEM },
      { role: 'user', content: 'Request: ' + String(request || '') + '\n\nItem:\n' + itemText(item) }] };
}

// the stored summary with its points, no times: the answer when the 9B's fails
function plainSummary(item) {
  const it = item || {};
  const pts = ((it.structured || {}).key_points || it.key_points || []).map((p) => String(p.point || p).trim()).filter(Boolean);
  return [String(it.title || '').trim(), String(it.summary || '').trim(), pts.length ? 'Key points:\n' + pts.map((p) => '• ' + p).join('\n') : '']
    .filter(Boolean).join('\n\n');
}

// the 9B's answer if it holds up against the item, else the stored summary
function itemAnswer(content, item, request) {
  let out = String(content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const reason = !out ? 'empty' : unsupportedFacts(out, itemText(item), request).length ? 'unsupported figures' : '';
  if (reason) out = plainSummary(item);
  return { output: out || "I couldn't open that item again. Ask about it by name and I'll search the feed.", fallback: reason };
}

// ---- an instruction sent WITH the link (WF-43, 2026-10-18) ----
// "<link> summarize it without timestamps": the video's item, looked up by its
// canonical url (both texts base64: web text never goes into SQL as a literal),
// with the saved transcript, and the instruction echoed back so each row carries it.
function itemLookupSql(canonicalUrl, instruction) {
  const b = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');
  return "select f.id, f.title, f.summary, f.canonical_url, f.structured, " +
    "coalesce((select left(string_agg(dc.text, chr(10) || chr(10) order by dc.n), 6000) from doc_chunks dc where dc.raw_doc_id = f.raw_doc_id), '') as page_excerpt, " +
    "convert_from(decode('" + b(instruction) + "', 'base64'), 'UTF8') as instruction " +
    "from feed_items f where f.canonical_url = convert_from(decode('" + b(canonicalUrl) + "', 'base64'), 'UTF8') order by f.id desc limit 1";
}

// the Telegram message: the video's title, then the answer (HTML-escaped)
function answerMessage(item, answer) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return ('\u{1F3AC} <b>' + esc((item || {}).title) + '</b>\n\n' + esc(answer)).slice(0, 4000);
}

module.exports = { exchangeSql, itemLookupSql, answerMessage, referentKind, refRoute, refNote, REF_WINDOW_MIN, plainText, botSaidSql, AGENT_ROWS, itemText, itemBody, plainSummary, itemAnswer };
