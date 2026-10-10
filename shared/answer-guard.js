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

  // Question-side check (added 2026-10-10, live failure): "anything on bangladesh
  // bank?" got "Nothing scored 7+ from today on Bangladesh Bank yet." with no tool
  // call — wording the reply regex below did not catch. Reply wording is endless;
  // the question is not. A feed question or an item follow-up always needs a tool.
  const aboutSourcesQ = /\b(sources?|feeds?|follow(ing)?|subscri\w*|blogs?|rss|watching)\b/i.test(q);
  const feedQuestion = /\b(anything (on|about|new|good|from)|what about|what('s| is) (new|happening)|tell me (more|about)|more (on|about)|show me|catch me up|what did (you|we) (find|get)|any (news|updates?|items?)|(first|second|third|fourth|fifth|last) one)\b|#\s?\d+\b|\b(number|item|no\.?)\s?\d+\b|^\s*\d+[.)]\s/i.test(q);
  if (feedQuestion && !aboutSourcesQ) return { retry: true, reason: 'feed question answered without a lookup' };

  const claimsFindings = /\b(found|items?|articles?|stor(y|ies)|findings?|coverage|headlines?|i checked|in the feed|the feed (has|shows)|nothing (on|about|new)|no (recent |new |fresh )?(items|news|coverage|results|stories))\b/i.test(r);
  if (!claimsFindings) return { retry: false, reason: 'no feed claims' };

  const aboutSources = /\b(sources?|feeds?|follow(ing)?|subscri\w*|blogs?|rss|watching)\b/i.test(q);
  if (aboutSources) return { retry: false, reason: 'sources come from per-message context' };
  const aboutRuns = /\b(runs?|break|broke|broken|fail(ed|ing)?|work(ed|ing)?|status)\b/i.test(q);
  if (aboutRuns && /\brun\s*#?\d+/i.test(r)) return { retry: false, reason: 'runs come from per-message context' };

  return { retry: true, reason: 'feed claims without a lookup' };
}

// When a reply is rejected, WF-00 runs the lookup ITSELF before the redo and hands
// the result over as live data — the memoryless redo agent was also seen claiming
// "I checked the feed" without a tool (2026-10-10, "anything on the cricket world
// cup?"). Item follow-ups resolve by number; everything else is a topic read on
// the question with its lead-in stripped (WF-31 matches by meaning, so the rest of
// the wording is fine as is).
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
function prefetchFor(question) {
  const q = String(question || '').trim();
  const ord = q.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth) (one|item|article|story|link)\b/i);
  if (ord) return { item: String(ORDINALS[ord[1].toLowerCase()]), tag: '' };
  const num = q.match(/#\s?(\d{1,3})\b|\b(?:number|item|no\.?)\s?(\d{1,3})\b|^\s*(\d{1,3})[.)]\s/i);
  if (num) return { item: num[1] || num[2] || num[3], tag: '' };
  const tag = q
    .replace(/^\s*(hey|hi|so|ok(ay)?|and|also)[,!\s]+/i, '')
    .replace(/^\s*(is there |do we have |have you got |got )?(anything|any (news|updates?|items?)|what('s| is)? (new|happening)|what about|tell me (more )?about|more (on|about)|show me|catch me up)\s*(on|about|with|for|regarding)?\s*/i, '')
    .replace(/[?!.]+\s*$/, '')
    .replace(/^the\s+/i, '')
    .trim();
  return { item: '', tag: tag.split(/\s+/).length <= 12 ? tag : '' };
}

module.exports = { needsFreshLookup, prefetchFor };
