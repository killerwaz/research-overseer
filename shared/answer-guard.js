// Decides whether the router's reply must be thrown away and redone with a forced
// fresh lookup. Inlined into WF-00's "Guard check" node.
//
// Why it exists (measured 2026-10-09): with thinking off, local Qwen3.5-9B skips
// the tools whenever the chat already holds an answer to a similar question — it
// repeats the old answer, or invents one ("the feed has nothing on Nvidia" with 10
// items saved). Prompt wording, memory tidying and history logs all failed to stop
// it; this check is the part the model cannot talk its way past.
//
// Rule: a reply that makes claims about the feed, or claims to have started an
// action, is only acceptable if a tool actually ran this turn. Sources and runs are
// exempt: they are handed to the model fresh every message, so answering those from
// context is correct.
function needsFreshLookup({ question, reply, toolsUsed }) {
  const q = String(question || '');
  const r = String(reply || '');
  if (Array.isArray(toolsUsed) && toolsUsed.length > 0) return { retry: false, reason: 'tool ran' };
  if (!r.trim()) return { retry: true, reason: 'empty reply' };

  const claimsAction = /\b(running|started|starting|kicked off|launching|searching|scraping)\b[^.?!]*\b(search|sweep|discovery|scrape|run)\b/i.test(r);
  if (claimsAction) return { retry: true, reason: 'claims an action it did not take' };

  const claimsFindings = /\b(found|items?|articles?|stor(y|ies)|findings?|coverage|headlines?|i checked|in the feed|the feed (has|shows)|nothing (on|about|new)|no (recent |new |fresh )?(items|news|coverage|results|stories))\b/i.test(r);
  if (!claimsFindings) return { retry: false, reason: 'no feed claims' };

  const aboutSources = /\b(sources?|feeds?|follow(ing)?|subscri\w*|blogs?|rss|watching)\b/i.test(q);
  if (aboutSources) return { retry: false, reason: 'sources come from per-message context' };
  const aboutRuns = /\b(runs?|break|broke|broken|fail(ed|ing)?|work(ed|ing)?|status)\b/i.test(q);
  if (aboutRuns && /\brun\s*#?\d+/i.test(r)) return { retry: false, reason: 'runs come from per-message context' };

  return { retry: true, reason: 'feed claims without a lookup' };
}

module.exports = { needsFreshLookup };
