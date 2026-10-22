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

// shownIds = the ids in his list now (in order). result = WF-31's output (or the
// candidates the fit check kept). beyond = unseen items past the checked ones exist.
function moreReply(shownIds, result, query, beyond) {
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
  const left = fresh.length > MORE_PAGE || Boolean(beyond);
  return { output: 'More' + on + ':\n\n' + lines.join('\n') + (left ? '\n\nSay "more" for the next 5.' : ''),
    items, ids: shown.concat(items.map((i) => i.id)) };
}

// ---- fit check on a "more" page (2026-10-23) ----
// Past ~20 results the search reaches passing mentions: #26-30 for "mcp security"
// included "Best practices for Claude Code" and "What Is Responsible AI?". The
// unseen items (up to MORE_CANDIDATES) go through the feed-fit 9B call (feed-fit.js
// fitBody, thinking off); 'no' = it only shares words with the topic, dropped.
const MORE_CANDIDATES = 10;
function moreCandidates(shownIds, result) {
  const seen = new Set((shownIds || []).map(Number));
  const ev = (e) => (e == null ? '' : typeof e === 'string' ? e : String(e.text || ''));
  const fresh = ((result || {}).items || []).filter((i) => Number(i.id) > 0 && !seen.has(Number(i.id)));
  return { fresh: fresh.length, items: fresh.slice(0, MORE_CANDIDATES).map((i, k) => ({ ...i, n: k + 1, title: String(i.title || ''),
    summary: String(i.summary || ''), evidence: ev(i.evidence) })) };
}

function fitQuestion(query) {
  const tag = String((parseQuery(query) || {}).tag || '').replace(/\s*\|\s*/g, ' and ').trim();
  return tag ? 'anything on ' + tag + '?' : 'show me the best items in my feed';
}

// n -> 'yes' | 'partly' | 'no', or null when the verdict cannot be read (keep all)
function readFitVerdicts(content) {
  try {
    const j = JSON.parse(String(content || '').replace(/^```(json)?|```$/g, '').trim());
    if (!j || !Array.isArray(j.items) || !j.items.length) return null;
    const m = new Map();
    for (const i of j.items) if (i && Number.isInteger(Number(i.n))) m.set(Number(i.n), String(i.fits));
    return m;
  } catch (e) { return null; }
}

// the candidates the check did not reject, in order
function keepFitting(cands, verdicts) {
  return (cands || []).filter((c) => !verdicts || verdicts.get(c.n) !== 'no');
}

const NOTHING_MORE ='Nothing more to show. Say "brief me", or ask about a topic.';

// His list after a page: the shown ids plus the new ones, the search kept (WF-31
// wrote its bigger page over it). One statement, numbers only.
function moreListSql(chatId, ids) {
  const chat = String(chatId).replace(/[^0-9-]/g, '');
  const list = (ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!/^-?\d+$/.test(chat) || !list.length) return '';
  return 'update chat_results set item_ids = array[' + list.join(',') + ']::bigint[], topic = null, created_at = now() where chat_id = ' + chat;
}

module.exports = { MORE_PAGE, MORE_CANDIDATES, NOTHING_MORE, isMore, moreRoute, parseQuery, moreInputs, moreReply, moreListSql, moreCandidates, fitQuestion, readFitVerdicts, keepFitting };
