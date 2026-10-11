// Pure helpers for WF-31 query_feed: topic fan-out, item references, and the
// vector packing that gets embeddings through n8n's queryReplacement.
//
// queryReplacement splits its value on commas, so nothing passed through it
// may contain one: topics have commas swapped for spaces, and vectors travel
// space-separated (SQL turns them back into a pgvector literal).

const MAX_TOPICS = 3;
// Swept 2026-10-10 with scripts/eval-search.js (39 cases, Qwen3-Embedding-0.6B):
//   keyword only  25/31 found, 6/6 absent, 68% precision
//   0.42          31/31        6/6         69%
//   0.45          31/31        6/6         71%   <- shipped
//   0.48          30/31        6/6         73%   (loses "AI that can buy things for you")
//   0.52          28/31        6/6         75%
// Re-tune with SIM_CUTOFF=x node scripts/build-wf31.js + the eval, not by feel.
const SIM_CUTOFF = 0.45;

// "bangladesh bank | nigeria ai" -> ['bangladesh bank', 'nigeria ai'].
// '|' and ';' both separate; duplicates and empties drop; at most 3.
function parseTopics(tag) {
  const seen = new Set();
  const out = [];
  for (const raw of String(tag == null ? '' : tag).split(/[|;]/)) {
    const t = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === MAX_TOPICS) break;
  }
  return out;
}

// "3", "#3", "no. 3", "item 3" -> 3. Anything else -> null.
function parseItemRef(item) {
  const m = String(item == null ? '' : item).match(/^\s*(?:#|no\.?\s*|item\s*|number\s*)?(\d{1,3})\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

// [[0.1, 0.2], [0.3, 0.4]] -> '0.1 0.2|0.3 0.4'. A missing or malformed
// vector packs as '' so that topic falls back to keyword matching only.
function packVectors(vecs, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = vecs && vecs[i];
    const ok = Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    out.push(ok ? v.join(' ') : '');
  }
  return out.join('|');
}

// "Filters come only from the user's current words" — enforced here, not just
// asked for in the tool description. End-to-end test 2026-10-12: mid-chat the
// router began adding min_score 5 to every call ("who bought Langfuse?"), which
// hid the articles that answered and led it to invent an answer. With the
// user's message at hand, a quality filter survives only if the message asks
// for quality, a time filter only if it names a time. No message (test
// harness, older callers) = filters pass through unchanged.
const QUALITY_WORDS = /\b(good|best|top|great|worth|important|interesting|strong|quality|high[- ]?scor\w*|score[ds]?|rated|must[- ]read)\b/i;
const TIME_WORDS = /\b(today|tonight|yesterday|morning|evening|night|week|weekend|month|year|recent(ly)?|latest|new(est)?|lately|just now|hours?|days?|since|past|last|this|ago|fresh|current(ly)?|20\d\d|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
function userFilters(userText, f) {
  const text = String(userText == null ? '' : userText).trim();
  const out = { min_score: f.min_score || '', max_age_days: f.max_age_days || '', since: f.since || '', dropped: [] };
  if (!text) return out;
  if (out.min_score && !QUALITY_WORDS.test(text)) { out.dropped.push('min_score'); out.min_score = ''; }
  if (!TIME_WORDS.test(text)) {
    if (out.max_age_days) { out.dropped.push('max_age_days'); out.max_age_days = ''; }
    if (out.since) { out.dropped.push('since'); out.since = ''; }
  }
  return out;
}

module.exports = { MAX_TOPICS, SIM_CUTOFF, parseTopics, parseItemRef, packVectors, userFilters };
