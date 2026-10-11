// 👍/👎 feedback: the Telegram buttons, reading a tap, and turning the votes
// into calibration examples for triage (sql/013).
//
// callback_data is "fb:<vote>:<feed_item_id>" — the item id, not the list
// number, so a tap on an old message still rates the right item after the
// chat has moved on to another list. Telegram caps callback_data at 64 bytes.

const UP = '\u{1F44D}';
const DOWN = '\u{1F44E}';
const CHOSEN = '✅';

function itemKeyboard(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { inline_keyboard: [[{ text: UP, callback_data: 'fb:1:' + n }, { text: DOWN, callback_data: 'fb:-1:' + n }]] };
}

// A numbered list: "1 👍" "1 👎" "2 👍" "2 👎" — two items per row, first 10 items.
function listKeyboard(items, max = 10) {
  const ok = (items || []).filter((i) => i && Number.isInteger(Number(i.id)) && Number(i.id) > 0 && i.n != null).slice(0, max);
  if (!ok.length) return null;
  if (ok.length === 1) return itemKeyboard(ok[0].id);
  const rows = [];
  for (let k = 0; k < ok.length; k += 2) {
    rows.push(ok.slice(k, k + 2).flatMap((i) => [
      { text: i.n + ' ' + UP, callback_data: 'fb:1:' + Number(i.id) },
      { text: i.n + ' ' + DOWN, callback_data: 'fb:-1:' + Number(i.id) }]));
  }
  return { inline_keyboard: rows };
}

function parseVote(data) {
  const m = String(data || '').match(/^fb:(-?1):(\d+)$/);
  return m ? { vote: Number(m[1]), id: Number(m[2]) } : null;
}

// The same keyboard with the tapped choice ticked (and the item's other button un-ticked).
function votedKeyboard(markup, id, vote) {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return null;
  const strip = (t) => String(t).replace(' ' + CHOSEN, '');
  return { inline_keyboard: markup.inline_keyboard.map((row) => row.map((b) => {
    const v = parseVote(b.callback_data);
    if (!v || v.id !== Number(id)) return b;
    return { ...b, text: strip(b.text) + (v.vote === vote ? ' ' + CHOSEN : '') };
  })) };
}

// Which items did this reply show? The query_feed / get_item results in the
// agent's tool steps (or the guard's prefetch), as {n, id}. Observations can
// be JSON strings or objects, possibly wrapped — walk whatever comes back.
function shownItems(sources) {
  const found = new Map();
  const visit = (x, depth) => {
    if (x == null || depth > 8) return;
    if (typeof x === 'string') {
      const s = x.trim();
      if (s[0] === '{' || s[0] === '[') { try { visit(JSON.parse(s), depth + 1); } catch (e) {} }
      return;
    }
    if (Array.isArray(x)) { x.forEach((y) => visit(y, depth + 1)); return; }
    if (typeof x !== 'object') return;
    if (x.n != null && Number(x.id) > 0 && (x.title || x.canonical_url)) found.set(Number(x.n), { n: Number(x.n), id: Number(x.id) });
    for (const k of Object.keys(x)) if (k !== 'structured') visit(x[k], depth + 1);
  };
  visit(sources, 0);
  return [...found.values()].sort((a, b) => a.n - b.n);
}

// Few-shot calibration for triage. rows: [{vote, title, summary}], newest
// first. Empty string when there is nothing to show, so triage is unchanged
// until the first tap.
function tasteBlock(rows, perSide = 6) {
  const list = Array.isArray(rows) ? rows : [];
  const line = (r) => '- ' + String(r.title || '').trim().slice(0, 120) +
    (r.summary ? ' — ' + String(r.summary).replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  const liked = list.filter((r) => Number(r.vote) === 1).slice(0, perSide).map(line);
  const disliked = list.filter((r) => Number(r.vote) === -1).slice(0, perSide).map(line);
  if (!liked.length && !disliked.length) return '';
  const out = ['', '', "WASIM'S RATINGS OF PAST FEED ITEMS (newest first)",
    'He tapped these in Telegram. Use them to calibrate angle_strength and specificity for items LIKE them —',
    'they show what he finds useful or useless beyond the written beat. They never override the beat, and an',
    'item unlike any of them is scored on the beat alone.'];
  if (liked.length) out.push('Liked (' + UP + '):', ...liked);
  if (disliked.length) out.push('Disliked (' + DOWN + '):', ...disliked);
  return out.join('\n');
}

// The rows tasteBlock reads: latest 6 likes + latest 6 dislikes, newest first,
// as JSON text. A scalar subquery, so it drops into any SELECT or RETURNING.
const TASTE_SQL = "(select coalesce(json_agg(t order by t.updated_at desc), '[]')::text from (" +
  "(select fb.vote, fb.updated_at, f.title, left(f.summary, 160) as summary from feedback fb join feed_items f on f.id = fb.feed_item_id where fb.vote = 1 order by fb.updated_at desc limit 6) " +
  "union all " +
  "(select fb.vote, fb.updated_at, f.title, left(f.summary, 160) as summary from feedback fb join feed_items f on f.id = fb.feed_item_id where fb.vote = -1 order by fb.updated_at desc limit 6)) t)";

module.exports = { itemKeyboard, listKeyboard, parseVote, votedKeyboard, shownItems, tasteBlock, TASTE_SQL };
