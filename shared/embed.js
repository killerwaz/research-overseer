// Embedding helpers shared by WF-21 (embed each new feed item), WF-31 (embed
// the search topic) and scripts/backfill-embeddings.js.
//
// Qwen3-Embedding-0.6B, picked over nomic-embed-text-v1.5 on 2026-10-10 by
// measurement: nomic scored an absent topic ("quantum computing", 0.69) above
// a real one (0.64), so no cutoff could say "nothing found"; Qwen3 put every
// real topic >= 0.55 and every absent one <= 0.42. It is also multilingual —
// the feed carries Bengali items.
//
// Qwen3 is asymmetric: queries carry a task instruction, documents carry none.

const EMBED_MODEL = 'text-embedding-qwen3-embedding-0.6b';
const EMBED_DIM = 1024;
const QUERY_INSTRUCT = 'Given a topic, retrieve news articles and reports about that topic';

// What a feed item "is about" — the model's own summary, not the raw page.
// Raw pages average ~28k chars of nav and boilerplate.
function docText(item) {
  const it = item || {};
  const tags = Array.isArray(it.tags) ? it.tags.filter(Boolean).join(', ') : '';
  const parts = [it.title, it.summary, it.angle, tags ? 'Tags: ' + tags : '']
    .map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
  return parts.join('\n').slice(0, 6000);
}

function queryText(q) {
  return 'Instruct: ' + QUERY_INSTRUCT + '\nQuery: ' + String(q == null ? '' : q).trim();
}

// pgvector literal. Every value is checked to be a finite number, which is
// also what makes it safe to splice into SQL text.
function vectorLiteral(vec) {
  if (!Array.isArray(vec) || vec.length !== EMBED_DIM) {
    throw new Error('embedding must be an array of ' + EMBED_DIM + ' numbers, got ' +
      (Array.isArray(vec) ? vec.length : typeof vec));
  }
  for (const v of vec) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('embedding contains a non-finite value');
  }
  return '[' + vec.join(',') + ']';
}

module.exports = { EMBED_MODEL, EMBED_DIM, QUERY_INSTRUCT, docText, queryText, vectorLiteral };
