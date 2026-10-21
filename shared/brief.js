// #16 "Brief me" on demand (2026-10-21). Inlined into WF-00 ('Big picture?',
// 'Brief prep', 'Brief reply'). Decided in code, like deep search and the
// scorecard: the 9B picked its own time window for "brief me" (a week, or none).
//
// Wasim's calls: list only (no 9B summary on top), "anything new today?" stays
// the RSS run. A brief = the best stories that ARRIVED since his last brief
// (created_at, not the article's publish date: an older article saved today is
// new to him), one row per story, best score first, 5 at a time. The first
// brief looks back 7 days. A topic brief ("brief me on bangladesh") or an
// explicit window ("catch me up on this week") does not move the stored time.

const BRIEF_PAGE = 5;
const BRIEF_FIRST_DAYS = 7;

const BRIEF_WORDS = /^\s*(?:hey |ok |so |please )?(?:(?:can you |could you )?(?:give me |send me )?(?:a |my |the )?(?:brief(?:ing)?|recap|catch[- ]?up)(?: me)?|brief me|catch me up|what did i miss|fill me in|bring me up to (?:date|speed))\b/i;
const MORE_WORDS = /^\s*(?:more|next|next (?:5|five|page)|show (?:me )?more|the next (?:5|five)|keep going)\s*[.!?]*\s*$/i;
const WINDOW_WORDS = /\b(today|yesterday|this week|last week|past week|this month|last (\d{1,2}) days?|past (\d{1,2}) days?)\b/i;

// { go, more, topic, days } — days = an explicit window in days ('' = since the last brief)
// recentBrief = a brief in the last 2 hours (WF-00 'Last bot msg'): "more" after
// "save #2" still pages it — left to the agent it re-listed #2 and #3 as "6." and
// "7." (2026-10-21), so "save #6" would have saved the wrong item.
function briefAsk(text, lastBot, recentBrief) {
  const t = String(text || '').trim();
  // only after a brief this module wrote: the agent copied the layout, "Say 'more'"
  // included, into a "brief me on bangladesh" reply (end to end, 2026-10-21)
  const lb = String(lastBot || '');
  // "more" after a topic brief pages that topic in code too: left to the agent it
  // invented three "Kaggle - ..." articles (end to end, 2026-10-21)
  if (MORE_WORDS.test(t) && /^(\d+ new stor(?:y|ies) since|More since|Best on |More on )/.test(lb) && /Say "more" for the next \d+/.test(lb))
    return { go: true, more: true, topic: '', days: '', topic_more: /^(Best on |More on )/.test(lb) };
  // the mode (topic or plain) then comes from the stored state
  if (MORE_WORDS.test(t) && String(recentBrief) === 'true') return { go: true, more: true, topic: '', days: '', topic_more: null };
  const m = t.match(BRIEF_WORDS);
  if (!m) return { go: false };
  let rest = t.slice(m[0].length);
  let days = '';
  const w = rest.match(WINDOW_WORDS);
  if (w) {
    const k = w[1].toLowerCase();
    days = k === 'today' ? '1' : k === 'yesterday' ? '2' : /week/.test(k) ? '7' : /month/.test(k) ? '30' : String(Number(w[2] || w[3]));
    rest = rest.replace(w[0], ' ');
  }
  const topic = rest
    .replace(/^[\s,:]*(?:on|about|with|for|regarding|re)\b/i, ' ')
    .replace(/\b(?:since|from|over|during|in|for|the|please|thanks?|me|everything|all)\b/gi, ' ')
    .replace(/[?!.,:;]+/g, ' ').replace(/\s+/g, ' ').trim();
  // A topic brief is searched by WF-31 (spelling, passages, rerank), not by
  // briefSql: on this week's 49 stories a one-word topic matched poorly there —
  // "funding" scored Modal's $16B Series D 0.28 by meaning, word matching pulled in
  // "India Reverse REPO Rate" (2026-10-21). Left to the 9B it skipped the search
  // once and answered from memory, so WF-00 calls WF-31 itself.
  return { go: true, more: false, topic, days };
}

// The stored state per chat: settings key brief:<chat> = { last, since, page, topic }.
function briefKey(chatId) { return 'brief:' + String(chatId).replace(/[^0-9-]/g, ''); }

function parseState(v) {
  try { const s = JSON.parse(String(v || '')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; }
}

// What this brief covers and what gets stored. now = ISO string.
function briefPlan(ask, state, now) {
  const st = state || {};
  const nowMs = Date.parse(now);
  if (ask.more) {
    const page = Number(st.page || 0) + 1;
    return { since: st.since || new Date(nowMs - BRIEF_FIRST_DAYS * 864e5).toISOString(), topic: st.topic || '', page,
      store: { ...st, page }, from_last: Boolean(st.from_last) };
  }
  const explicit = ask.days !== '' && ask.days != null;
  const since = explicit ? new Date(nowMs - Number(ask.days) * 864e5).toISOString()
    : st.last || new Date(nowMs - BRIEF_FIRST_DAYS * 864e5).toISOString();
  const moves = !explicit && !ask.topic;   // only a plain brief moves "last"
  return { since, topic: ask.topic || '', page: 0, from_last: !explicit && Boolean(st.last),
    store: { last: moves ? now : (st.last || ''), since, page: 0, topic: ask.topic || '', from_last: !explicit && Boolean(st.last) } };
}

const sqlText = (s) => "convert_from(decode('" + Buffer.from(String(s || ''), 'utf8').toString('base64') + "', 'base64'), 'UTF8')";

// One row back: rows (json, this page), total, good (score 7+). Topic = all its
// words in title/summary/angle/tags (english stems) OR meaning (vec, cutoff).
function briefSql({ since, topic, page, vec, cutoff }) {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) throw new Error('bad since: ' + since);
  const sinceLit = "'" + new Date(sinceMs).toISOString() + "'::timestamptz";
  const off = Math.max(0, Number(page) || 0) * BRIEF_PAGE;
  const t = String(topic || '').trim();
  const kw = t ? "(select bool_and(w = any(tsvector_to_array(to_tsvector('english', coalesce(s.title,'') || ' ' || coalesce(s.summary,'') || ' ' || coalesce(s.angle,'') || ' ' || coalesce(array_to_string(s.tags,' '),''))))) " +
    "from unnest(tsvector_to_array(to_tsvector('english', " + sqlText(t) + "))) w)" : 'true';
  const sim = t && vec ? " or (fi.embedding is not null and 1 - (fi.embedding <=> '" + vec + "'::vector) >= " + Number(cutoff) + ')' : '';
  return 'with s as (select s.*, fi.id from feed_stories s ' +
    'left join lateral (select id, embedding from feed_items f where f.canonical_url = s.canonical_url order by f.id desc limit 1) fi on true ' +
    'where s.created_at >= ' + sinceLit + (t ? ' and (coalesce(' + kw + ', false)' + sim + ')' : '') + '), ' +
    'p as (select id, title, canonical_url, angle, summary, score, articles, created_at from s order by score desc nulls last, created_at desc limit ' + BRIEF_PAGE + ' offset ' + off + ') ' +
    "select (select json_agg(p order by p.score desc nulls last, p.created_at desc)::text from p) as rows, " +
    '(select count(*) from s)::int as total, (select count(*) from s where score >= 7)::int as good';
}

function fmtWhen(iso) {
  const d = new Date(Date.parse(iso) + 6 * 3600e3);   // Asia/Dhaka, UTC+6, no DST
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' +
    String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

// The reply, and the items (n continues across pages, so "#7" works after "more").
function briefReply(plan, rows, total, good) {
  const list = Array.isArray(rows) ? rows : [];
  const tot = Number(total) || 0, gd = Number(good) || 0;
  const scope = (plan.topic ? ' on ' + plan.topic : '') + ' since ' + (plan.from_last ? 'your last brief (' + fmtWhen(plan.since) + ')' : fmtWhen(plan.since));
  if (!tot) return { output: 'Nothing new' + scope + '.', items: [] };
  const first = plan.page * BRIEF_PAGE;
  if (!list.length) return { output: 'That was all of them: ' + tot + ' new ' + (tot === 1 ? 'story' : 'stories') + scope + '.', items: [] };
  const items = list.map((r, i) => ({ n: first + i + 1, id: Number(r.id), title: r.title, canonical_url: r.canonical_url }));
  const lines = list.map((r, i) => (first + i + 1) + '. ' + String(r.title || r.canonical_url || '').trim() +
    (Number(r.articles) > 1 ? ' (' + r.articles + ' sources)' : '') + ' [' + (r.score == null ? '–' : r.score) + ']' +
    (r.angle ? '\n   ' + String(r.angle).replace(/\s+/g, ' ').trim().slice(0, 220) : ''));
  const head = plan.page ? 'More' + scope + ' (' + (first + 1) + '–' + (first + list.length) + ' of ' + tot + '):'
    : tot + ' new ' + (tot === 1 ? 'story' : 'stories') + scope + ', ' + gd + ' scored 7+.' + (tot > list.length ? ' Best ' + list.length + ':' : '');
  const left = tot - (first + list.length);
  return { output: head + '\n\n' + lines.join('\n') + (left > 0 ? '\n\nSay "more" for the next ' + Math.min(BRIEF_PAGE, left) + '.' : ''), items };
}

// "brief me on X": WF-31's best matches on X (any date), in WF-31's order, in the
// brief's layout. "more" asks WF-31 for one more page (limit grows, one extra row
// says whether there is a next page); WF-31 numbers and stores the whole list, so
// "#7" works after "more".
function briefTopicLimit(page) { return String((Number(page) + 1) * BRIEF_PAGE + 1); }

function briefTopicReply(topic, result, page) {
  const r = result || {};
  const p = Number(page) || 0;
  const all = Array.isArray(r.items) ? r.items : [];
  const items = all.slice(p * BRIEF_PAGE, (p + 1) * BRIEF_PAGE);
  if (!all.length) return { output: 'Your feed has nothing on ' + topic + ' yet.', items: [], empty: true };
  if (!items.length) return { output: 'That was everything on ' + topic + '.', items: [] };
  const lines = items.map((it) => it.n + '. ' + String(it.title || it.canonical_url || '').trim() +
    (Number(it.articles) > 1 ? ' (' + it.articles + ' sources)' : '') + ' [' + (it.score == null ? '–' : it.score) + ']' +
    (it.angle ? '\n   ' + String(it.angle).replace(/\s+/g, ' ').trim().slice(0, 220) : ''));
  const fixed = r.spelling ? ' (' + String(r.spelling).replace(/\s*—.*$/, '') + ')' : '';
  const more = all.length > (p + 1) * BRIEF_PAGE;
  return { output: (p ? 'More on ' : 'Best on ') + topic + fixed + ':\n\n' + lines.join('\n') + (more ? '\n\nSay "more" for the next 5.' : ''),
    items: items.map((it) => ({ n: it.n, id: Number(it.id), title: it.title, canonical_url: it.canonical_url })) };
}

module.exports = { BRIEF_PAGE, BRIEF_FIRST_DAYS, briefAsk, briefKey, parseState, briefPlan, briefSql, briefReply, briefTopicReply, briefTopicLimit, fmtWhen };
