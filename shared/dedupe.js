// Story dedupe: is a new feed item the same story as one already in the feed?
// Used by WF-21 (each new item, after its embedding is stored) and by
// scripts/backfill-dedupe.js (the existing feed, oldest first).
//
// Measured 2026-10-11 on the live feed (352 items), embedding similarity of
// title+summary+angle+tags (shared/embed.js):
//   >= 0.87  every pair was the same story (Patronus x4, Natural x2, ...)
//   0.80-0.87  mixed: same-story copies AND look-alikes ("ttok 1.0" vs
//              "ttok 0.4", LangSmith vs Langfuse alternatives, two GPU price
//              lists). The 9B with thinking OFF judged 57 such pairs: 33/34
//              merges right, 1 miss, 0.4 s per pair.
//   < 0.80   no same-story pair found.
// So: merge outright above the band, ask the 9B inside it, keep below it.

const AUTO_MERGE = 0.87;
const CHECK_FLOOR = 0.80;

function twinAction(sim) {
  const s = Number(sim);
  if (sim == null || sim === '' || !Number.isFinite(s)) return 'new';
  if (s >= AUTO_MERGE) return 'merge';
  if (s >= CHECK_FLOOR) return 'check';
  return 'new';
}

const SAME_SYSTEM = `Two items from a news feed. Decide whether they cover the SAME specific story: the same event, announcement, funding round, release, report or document, so that a reader needs only one of them.
NOT the same: different versions or releases of a product, different products or companies, different list or comparison articles, a report versus commentary that merely cites it, or two pieces that only share a general topic.
Items can be in different languages.`;

const SAME_SCHEMA = { type: 'json_schema', json_schema: { name: 'same_story', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['same'], properties: { same: { type: 'boolean' } } } } };

// Code nodes have no URL global, hence the regex.
function hostOf(u) {
  const m = String(u || '').match(/^https?:\/\/(?:www\.)?([^/:?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function sameStoryBody(a, b, model) {
  const side = (label, x) => label + ': ' + (x.title || '') + ' (' + hostOf(x.url) + ')\n' + String(x.summary || '').slice(0, 400);
  return { model: model || 'qwen/qwen3.5-9b', temperature: 0, max_tokens: 50, reasoning_effort: 'none',
    response_format: SAME_SCHEMA,
    messages: [{ role: 'system', content: SAME_SYSTEM }, { role: 'user', content: side('A', a) + '\n\n' + side('B', b) }] };
}

// true / false, or null when the reply is unusable (treated as "not the same":
// a missed merge leaves a duplicate visible, a wrong one hides a story).
function parseSame(message) {
  const m = message || {};
  const text = String(m.content || '').trim() || String(m.reasoning_content || '');
  const i = text.lastIndexOf('{');
  if (i < 0) return null;
  try {
    const o = JSON.parse(text.slice(i, text.indexOf('}', i) + 1));
    return typeof o.same === 'boolean' ? o.same : null;
  } catch (e) { return null; }
}

module.exports = { AUTO_MERGE, CHECK_FLOOR, twinAction, SAME_SYSTEM, SAME_SCHEMA, hostOf, sameStoryBody, parseSame };
