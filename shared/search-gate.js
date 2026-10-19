// run_discovery starts a paid search (~6 minutes, items added to the real feed),
// so whether it may start is decided in code, not by the 9B (2026-10-18). The
// tool description says "only on an explicit search verb", and the 9B still
// called it for bare topics about once in 7: "quantum error correction
// breakthroughs" (execution 37070, run 102, 10 items) and "best sourdough
// starter recipe" (execution 34834). WF-00 computes searchAllowed in
// 'Big picture?' and passes it to WF-41 as a fixed input; WF-41 refuses an
// agent call without it. rss is not gated ("anything new today" is free).

// the verbs the system prompt promises, plus their plain variants
const SEARCH_VERB = /\b(search(ing)?( for| up)?|find me|look (it |that |this )?up|look up|go (and )?get|dig (into|up)|run (a |another )?(new )?(web )?(search|discovery)|do (a |another )?(web )?search|track(ing)?)\b/i;
// "don't search", "no need to look it up", "without searching"
const SEARCH_NEG = /\b(don'?t|do not|no need to|never|without|not)\s+(\w+\s+){0,2}$/i;
// a noun or a past question, not a request: "your last search", "did you search"
const SEARCH_NOT_ASK = /\b(the|your|my|last|that|this|previous|earlier)\s+$|\b(did|have|has|had)\s+(you|it|we)\s+$/i;
// the same yes list as WF-40's gate and shared/sweep-confirm.js
const SEARCH_YES = /^(yes|y|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|run it|confirm(ed)?|please( do)?)\b/i;
// a bot question offering a search ("Want me to search for X?"); the prompt
// says never to offer one, but if it does, his yes counts as asking
const SEARCH_OFFER = /\b(search|look (it |that )?up|dig into|run (a )?(search|discovery))\b[^?]*\?/i;

function hasSearchVerb(text) {
  const msg = String(text || '');
  const re = new RegExp(SEARCH_VERB.source, 'gi');
  let m;
  while ((m = re.exec(msg))) {
    const before = msg.slice(0, m.index);
    if (!SEARCH_NEG.test(before) && !SEARCH_NOT_ASK.test(before)) return true;
  }
  return false;
}

// a short yes to the bot's previous message, when that message offered a search
function yesToSearch(text, lastBot) {
  const msg = String(text || '').trim();
  return msg.length < 60 && SEARCH_YES.test(msg) && SEARCH_OFFER.test(String(lastBot || ''));
}

function searchAllowed(text, lastBot) {
  return hasSearchVerb(text) || yesToSearch(text, lastBot);
}

module.exports = { hasSearchVerb, yesToSearch, searchAllowed };
