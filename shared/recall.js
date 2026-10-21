// #14 long-term memory (2026-10-13): the bot sees only its last 10 exchanges, so
// every finished exchange is also kept in chat_memory (sql/016) and searched by
// meaning before the agent runs. Inlined into WF-00 ('Recall sql', 'Recall note',
// 'Remember prep', 'Remember sql') together with embed.js.
//
// Measured on his 33 real exchanges, 19 recall questions + 14 never discussed
// (scripts/eval-recall.js):
//  - one "You: ... / Bot: ..." text per exchange beats the question alone: right
//    exchange on top 18/19 vs 16/19;
//  - cutoff 0.50: 17/19 found, 13/14 never-discussed left empty. The one false
//    recall ("openai funding" -> his "AI agent funding" exchange, 0.59) scores
//    above real hits, so no cutoff removes it; a 9B relevance check gave no gain
//    (17/19, 13/14) and cost 0.26 s per exchange, so recalled exchanges carry
//    their date and question and a wrong one is visible instead;
//  - typos need no fixing here: "husssain elius" found its exchange at 0.59,
//    the next best 0.21.

const RECALL_CUTOFF = 0.50;
const RECALL_LIMIT = 3;
const RECALL_ANSWER_CHARS = 1200;

// What gets embedded and stored: the exchange as he saw it.
function memoryDoc(question, answer) {
  return ('You: ' + String(question || '').trim() + '\nBot: ' + String(answer || '').trim()).slice(0, 2000);
}

// Not worth keeping: taps, empty or failed replies.
function shouldRemember(question, answer) {
  const q = String(question || '').trim(), a = String(answer || '').trim();
  if (!q || !a) return false;
  if (q.startsWith('cb:')) return false;
  if (a === '(empty reply)') return false;
  return true;
}

const b64 = (s) => Buffer.from(String(s == null ? '' : s).replace(/\u0000/g, ''), 'utf8').toString('base64');

// Web text goes in base64: n8n's Postgres node reads some $-digit runs as
// parameters even inside quotes (CLAUDE.md). vec = vectorLiteral output (numbers only).
function rememberSql(chatId, question, answer, vec) {
  const id = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d+$/.test(id)) return 'select 1 as skipped';
  return "insert into chat_memory (chat_id, question, answer, embedding) values (" + id +
    ", convert_from(decode('" + b64(question) + "', 'base64'), 'UTF8'), convert_from(decode('" + b64(answer) +
    "', 'base64'), 'UTF8'), " + (vec ? "'" + vec + "'::vector" : 'null') + ') returning id';
}

// One row back (the SQL runner and n8n both like that): rows = json array or null.
function recallSql(chatId, vec, cutoff = RECALL_CUTOFF, limit = RECALL_LIMIT) {
  const id = String(chatId == null ? '' : chatId).trim();
  if (!/^-?\d+$/.test(id) || !vec) return 'select null::text as rows';
  return "select (select json_agg(r order by r.sim desc)::text from (select id, question, answer, " +
    "to_char(created_at at time zone 'Asia/Dhaka', 'FMDD Mon') as day, 1 - (embedding <=> '" + vec + "'::vector) as sim " +
    'from chat_memory where chat_id = ' + id + " and embedding is not null order by embedding <=> '" + vec + "'::vector limit " +
    Number(limit) + ') r where r.sim >= ' + Number(cutoff) + ') as rows';
}

function parseRows(rows) {
  if (Array.isArray(rows)) return rows;
  try { const v = JSON.parse(String(rows || 'null')); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

// What the agent is handed. It rides after the [live data ...] marker, so Tidy
// memory strips it from the stored message like the rest of the live data.
// A question about what was said before, with nothing recalled: the 9B mirrored
// "what did we discuss about nvidia earnings?" with "We discussed NVIDIA earnings
// in this chat" and then listed feed items (end to end, 2026-10-13).
const ASKS_HISTORY = /\b(we (discuss|discussed|talk|talked|spoke)|you (told|tell|said|say|found|gave|showed|mentioned)|did (i|we) (ask|discuss|talk)|i asked( you)?|remind me what|last time)\b/i;
const NO_HISTORY = '[earlier chats with this user: none match this message. If they ask what was said before, say plainly you have no record of discussing it, then answer from the feed if it helps.]';

// A question about what was said in this chat is never sent to the web: the web
// cannot know, and the web answer took on the question's framing — "I told you
// that OpenAI closed a ... $122 billion round" for "what did you tell me about
// openai funding?", a conversation that never happened (2026-10-21).
function asksHistory(question) { return ASKS_HISTORY.test(String(question || '')); }

function recallNote(rows, question) {
  const list = parseRows(rows);
  if (!list.length) return ASKS_HISTORY.test(String(question || '')) ? NO_HISTORY : '';
  const lines = list.map((r) => '(' + (r.day || 'earlier') + ') You: ' + String(r.question || '').replace(/\s+/g, ' ').slice(0, 300) +
    ' | Bot: ' + String(r.answer || '').replace(/\s+/g, ' ').slice(0, RECALL_ANSWER_CHARS));
  return '[earlier chats with this user, found by meaning, may be unrelated: ' + lines.join(' || ') +
    ' ] [Use an earlier chat only if it is about what this message asks. When you use one, say when: "On 13 Oct I told you ..." or "Earlier you asked ...". It is what was said then, not the feed.]';
}

// The guard (answer-guard.js) redoes a factual answer given without a tool. An
// answer built on a recalled exchange says so ("On 13 Oct ...", "earlier"), and
// only then does the recall count as the lookup.
const USES_RECALL = /\b(earlier|previously|before|last time|you asked|i (told|found|said|gave)|we (talked|discussed|spoke))\b|\bon \d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b/i;
function usesRecall(reply, recallN) {
  return Number(recallN) > 0 && USES_RECALL.test(String(reply || ''));
}

// The web fallback's wording rule (web-fallback.js) must not decide alone on an
// answer built on an earlier chat: end to end, "who founded Pathao again?" got
// "On 13 Oct I told you ... Hussain Elius co-founded Pathao ... Your feed doesn't
// have this topic", and "feed doesn't" sent a right answer to the web (2026-10-13).
// When this is true WF-00 asks the 9B judge instead (a reply that only repeats
// "nothing found" still goes to the web). Only a recalled exchange that itself
// answered counts (wasNoAnswer = web-fallback's verdict on the old reply).
function answeredFromRecall(reply, rows, wasNoAnswer) {
  const list = parseRows(rows);
  if (!usesRecall(reply, list.length)) return false;
  return list.some((r) => /^\s*From the web\b/i.test(String(r.answer || '')) || !wasNoAnswer(r));
}

module.exports = { RECALL_CUTOFF, RECALL_LIMIT, memoryDoc, shouldRemember, rememberSql, recallSql, parseRows, recallNote, usesRecall, answeredFromRecall, asksHistory };
