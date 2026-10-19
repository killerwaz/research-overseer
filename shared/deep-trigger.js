// "deep search ..." starts a deep research job (WF-46), decided in code before the
// agent (2026-10-19). Only these words start it, never the 9B: a job holds the GPU
// for ~6 minutes and spends ~$0.09 of search credit. "dig into" stays with
// run_discovery (shared/search-gate.js).
// Names here are prefixed DEEP_/deep: 'Big picture?' inlines several shared files
// into one Code node, and two files declaring YES broke WF-00 on 2026-10-18.

// Only at the start ("deep search: X", "do a deep research on X") or the end
// ("X? deep dive please"): in the middle it is usually about something else
// ("what is deep research in chatgpt?").
const DEEP_CORE = '(?:(?:please|pls|can you|could you)\\s+)?(?:(?:do|run|start)\\s+(?:a|another|the)\\s+)?deep[\\s-]*(?:search|research|dive)';
const DEEP_TRIGGER = new RegExp('^\\s*' + DEEP_CORE + '(?:\\s+(?:on|into|for|about|of))?\\s*[:,\\-–—]?\\s*', 'i');
const DEEP_TRAILER = new RegExp('[\\s,.;:\\-–—]*\\b' + DEEP_CORE + '(?:\\s+(?:please|pls|on (?:that|this|it)|it))?[\\s.!?]*$', 'i');
// what is left when the message only points back ("deep search on that")
const DEEP_VAGUE = /^(?:(?:on|into|for|about)\s+)?(?:that|this|it|this one|that one|the last one|my (?:last )?question|the (?:same )?question)?\s*(?:please|pls|again)?[\s.!?]*$/i;

// -> { go: true, question } when the message asks for a deep search; question is ''
//    when it points back and there is no earlier message to point at
function deepAsk(text, lastHuman) {
  const t = String(text || '');
  const m = t.match(DEEP_TRIGGER) || t.match(DEEP_TRAILER);
  if (!m) return { go: false, question: '' };
  let q = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim().replace(/^[,.;:\-–—\s]+|[,;:\-–—\s]+$/g, '');
  if (q.length < 8 || DEEP_VAGUE.test(q)) q = String(lastHuman || '').trim();
  return { go: true, question: q.slice(0, 500) };
}

module.exports = { deepAsk, DEEP_TRIGGER };
