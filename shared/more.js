// A bare "more" (2026-10-22), decided in code. Inlined into WF-00 ('Big picture?',
// 'More prep', 'More reply').
//
// Left to the 9B, "more" invented three "Kaggle - ..." articles, re-listed #2/#3 as
// "6."/"7.", and after a save searched the web for "Research Overseer Saves".
//   - a brief's list ('brief' | 'brief-topic')  -> shared/brief.js pages it
//   - a feed search's list (chat_results.query) -> the same search again, bigger, and
//     the next 5 items he has NOT been shown, numbered on from his list. Not "rows
//     11-15": with two topics WF-31's fair share per topic grows with the limit, so
//     positions shift between calls.
//   - anything else -> "nothing more to show", no model, no web.

const MORE_PAGE = 5;
const MORE_ONLY = /^\s*(?:more|next|next (?:5|five|page)|show (?:me )?more|the next (?:5|five)|keep going|any more\??|more please)\s*[.!?]*\s*$/i;

function isMore(text) { return MORE_ONLY.test(String(text || '')); }

// 'brief' | 'feed' | 'none'  (listTopic = chat_results.topic, listQuery = .query)
function moreRoute(text, listTopic, listQuery, listN) {
  if (!isMore(text)) return '';
  if (['brief', 'brief-topic'].includes(String(listTopic || ''))) return 'brief';
  const q = parseQuery(listQuery);
  return q && Number(listN) > 0 ? 'feed' : 'none';
}

function parseQuery(v) {
  if (v && typeof v === 'object') return v;
  try { const q = JSON.parse(String(v || '')); return q && typeof q === 'object' ? q : null; } catch (e) { return null; }
}

// WF-31 inputs for the next page: the stored search, enough rows to skip all shown.
function moreInputs(listQuery, listN) {
  const q = parseQuery(listQuery) || {};
  const s = (x) => (x == null ? '' : String(x));
  return { tag: s(q.tag), since: s(q.since), min_score: s(q.min_score), max_age_days: s(q.max_age_days),
    min_relevance: s(q.min_relevance), group_stories: s(q.group_stories), limit: String(Number(listN) + MORE_PAGE * 2) };
}

// shownIds = the ids in his list now (in order). result = WF-31's output.
function moreReply(shownIds, result, query) {
  const shown = (shownIds || []).map(Number);
  const seen = new Set(shown);
  const r = result || {};
  const fresh = (Array.isArray(r.items) ? r.items : []).filter((i) => Number(i.id) > 0 && !seen.has(Number(i.id)));
  const page = fresh.slice(0, MORE_PAGE);
  const topic = String((parseQuery(query) || {}).tag || '').trim();
  const on = topic ? ' on ' + topic.replace(/\s*\|\s*/g, ' and ') : '';
  if (!page.length) return { output: 'That was everything' + on + ': ' + shown.length + ' item' + (shown.length === 1 ? '' : 's') + ' shown.', items: [], ids: shown };
  const items = page.map((it, k) => ({ n: shown.length + k + 1, id: Number(it.id), title: it.title, canonical_url: it.canonical_url }));
  const lines = page.map((it, k) => (shown.length + k + 1) + '. ' + String(it.title || it.canonical_url || '').trim() +
    (Number(it.articles) > 1 ? ' (' + it.articles + ' sources)' : '') + ' [' + (it.score == null ? '–' : it.score) + ']' +
    (it.angle ? '\n   ' + String(it.angle).replace(/\s+/g, ' ').trim().slice(0, 220) : ''));
  const left = fresh.length > MORE_PAGE;
  return { output: 'More' + on + ':\n\n' + lines.join('\n') + (left ? '\n\nSay "more" for the next 5.' : ''),
    items, ids: shown.concat(items.map((i) => i.id)) };
}

const NOTHING_MORE = 'Nothing more to show. Say "brief me", or ask about a topic.';

// His list after a page: the shown ids plus the new ones, the search kept (WF-31
// wrote its bigger page over it). One statement, numbers only.
function moreListSql(chatId, ids) {
  const chat = String(chatId).replace(/[^0-9-]/g, '');
  const list = (ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!/^-?\d+$/.test(chat) || !list.length) return '';
  return 'update chat_results set item_ids = array[' + list.join(',') + ']::bigint[], topic = null, created_at = now() where chat_id = ' + chat;
}

module.exports = { MORE_PAGE, NOTHING_MORE, isMore, moreRoute, parseQuery, moreInputs, moreReply, moreListSql };
