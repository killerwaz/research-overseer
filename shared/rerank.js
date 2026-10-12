// Fix 1 switches for WF-31 (on trial 2026-10-12): second passage (1b),
// reranking (1d) and the passing-mention label (1e). Pure functions, inlined
// into WF-31's Rerank prep and Shape nodes.
//
// Switches live in the settings table (key -> value), read once per call:
//   fix_two_passages  'true'  the first results carry their 2 best passages
//   fix_rerank        'llm'   the 9B scores the candidates (thinking off); anything else = off
//   fix_mentions      'true'  text-only weak matches are labelled "mentioned in passing"
//   fix_answer_check  'true'  (WF-00, shared/answer-check.js)

// A dedicated reranker (Qwen3-Reranker-0.6B) was tried and removed 2026-10-12:
// the GPU is full, and on CPU it took ~1.5 s per passage (8-25 s per search,
// one timeout) for the same end-to-end score as the 9B (12/13 both).
const RERANK_TOP = { llm: 12 };
const LLM_DOC_CHARS = 1200;
const MENTION_RR = 0.2;     // reranker score below this = does not answer
const MENTION_SIM = 0.40;   // without a reranker: meaning score below this

function switchesFrom(row) {
  const r = row || {};
  return { two: r.fix_two_passages === 'true', rerank: r.fix_rerank === 'llm' ? 'llm' : 'off',
    mentions: r.fix_mentions === 'true', check: r.fix_answer_check === 'true' };
}

// What to rerank: the listed rows (not outside the filters), in SQL order,
// at most RERANK_TOP[mode]. Each row offers its best passage, its second when
// 1b is on, or its title + summary when it matched on the summary alone.
function rerankCandidates(rows, mode, two) {
  const top = RERANK_TOP[mode] || 0;
  const docs = [], map = [];
  let taken = 0;
  rows.forEach((r, i) => {
    if (r.outside === true || !r.topic || taken >= top) return;
    taken++;
    const texts = [];
    if (r.ptext) texts.push([1, r.ptext]);
    if (two && r.ptext2) texts.push([2, r.ptext2]);
    if (!texts.length) texts.push([0, (r.title || '') + '\n' + (r.summary || '')]);
    for (const [which, t] of texts) { docs.push(String(t)); map.push({ row: i, which }); }
  });
  return { docs, map };
}

function rerankLlmBody(model, question, docs) {
  const list = docs.map((d, i) => '[' + i + '] ' + String(d).replace(/\s+/g, ' ').slice(0, LLM_DOC_CHARS)).join('\n\n');
  return { model, temperature: 0, max_tokens: 400, reasoning_effort: 'none',
    response_format: { type: 'json_schema', json_schema: { name: 'scores', strict: true, schema: {
      type: 'object', additionalProperties: false, required: ['scores'],
      properties: { scores: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 10 }, minItems: docs.length, maxItems: docs.length } } } } },
    messages: [
      { role: 'system', content: 'You rate passages for a search engine. For each numbered passage, give 0-10: 10 = it directly answers the question (contains the fact asked for), 5 = on the topic but does not contain the answer, 0 = unrelated or only mentions the words in passing. Return JSON {"scores": [...]} with one integer per passage, in order.' },
      { role: 'user', content: 'Question: ' + question + '\n\nPassages:\n' + list }] };
}

function parseLlmScores(message, n) {
  try {
    const m = message || {};
    const raw = String(m.content || m.reasoning_content || '');
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    const s = (j.scores || []).map((x) => Math.max(0, Math.min(10, Number(x))) / 10);
    return s.length === n && s.every((x) => Number.isFinite(x)) ? s : null;
  } catch (e) { return null; }
}

// rows + scores -> rows with rr (best score), the best passage moved to ptext,
// and the reranked rows reordered among themselves (others keep their place
// after them). Scores missing (reranker down) = rows unchanged.
function applyRerank(rows, map, scores) {
  if (!Array.isArray(scores) || scores.length !== map.length) return rows;
  const best = new Map();
  map.forEach((m, k) => { const b = best.get(m.row); if (!b || scores[k] > b.s) best.set(m.row, { s: scores[k], which: m.which }); });
  const out = rows.map((r, i) => {
    const b = best.get(i);
    if (!b) return r;
    const x = { ...r, rr: b.s };
    if (b.which === 2) { [x.ptext, x.ptext2] = [r.ptext2, r.ptext]; [x.pn, x.pn2] = [r.pn2, r.pn]; x.phl = null; }
    return x;
  });
  const ranked = out.filter((r, i) => best.has(i)).sort((a, b) => b.rr - a.rr);
  let k = 0;
  return out.map((r, i) => (best.has(i) ? ranked[k++] : r));
}

// A row found ONLY in its article text whose passage does not answer: the
// reranker says so when it ran; otherwise a weak meaning score does.
function isPassingMention(r) {
  if (!r || !r.ptext || r.kw_hit || Number(r.sim) >= Number(r.sim_cutoff || 0.45)) return false;
  return r.rr != null ? r.rr < MENTION_RR : Number(r.psim || 0) < MENTION_SIM;
}

module.exports = { RERANK_TOP, MENTION_RR, MENTION_SIM, switchesFrom, rerankCandidates, rerankLlmBody, parseLlmScores, applyRerank, isPassingMention };
