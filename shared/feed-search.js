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

module.exports = { MAX_TOPICS, SIM_CUTOFF, parseTopics, parseItemRef, packVectors };
