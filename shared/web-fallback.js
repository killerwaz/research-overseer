// Fix 2 (2026-10-12): when the feed has no answer, answer from the web.
// Wasim's call: automatically, no cap, Tavily basic search (1 credit), answer
// only — nothing is saved to the feed. At most one web search per message.
// Inlined into WF-00 ("Web needed?") and WF-44 web_answer.

// The router's ways of saying the feed has nothing (seen in the end-to-end
// runs) plus Final check's safe reply.
const NO_ANSWER = /\b(the feed|your feed|feed's articles)\b[^.?!]{0,80}\b(doesn.t|does not|don.t|has no|have no|isn.t|is not|lacks?|no (recent |specific |direct )?(articles?|items?|stories|news|coverage|mention|details?|information|data))\b|\bnothing (in|on|about)\b[^.?!]{0,60}|\bno (recent |specific )?(articles?|items?|stories|news|coverage|results)\b[^.?!]{0,40}\b(on|about|in the feed|for)\b|couldn.t confirm an answer|not covered (by|in) (the|your) feed|feed doesn.t (say|specify|mention|cover|include|have)|\bfeed\b[^]{0,220}?\b(doesn.t|does not|didn.t|did not|don.t|do not) (specify|say|mention|include|give|state|list|cover|contain|have|answer)\b/i;
const SMALL_TALK = /^\s*(hi|hey|hello|thanks?|thank you|ok(ay)?|cool|nice|great|bye|good (morning|night|evening))\b/i;
const ABOUT_BOT = /\b(sources?|feeds? (are|you)|runs?|status|watching|subscri\w*|schedul\w*|scrape|transcribe|remember|forget)\b/i;

function needsWeb({ question, reply, alreadyWeb, feedItems }) {
  const q = String(question || '').trim(), r = String(reply || '');
  if (alreadyWeb) return { web: false, reason: 'already answered from the web' };
  // #13: a cited answer built from feed items is an answer, even when it ends
  // "the feed does not contain ... launch dates" (2026-10-13: that sentence sent a
  // good bKash answer to the web, which then replaced it with "Not in your feed").
  if (feedItems > 0) return { web: false, reason: 'answered from feed items' };
  if (!q || SMALL_TALK.test(q)) return { web: false, reason: 'small talk' };
  if (ABOUT_BOT.test(q)) return { web: false, reason: 'about the bot itself' };
  if (/https?:\/\//i.test(q)) return { web: false, reason: 'a link, handled by scrape_url' };
  if (!NO_ANSWER.test(r)) return { web: false, reason: 'the feed answered' };
  return { web: true, reason: 'the feed has no answer' };
}

function tavilyBody(question) {
  return { query: String(question || '').slice(0, 380), search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false };
}

const WEB_CHARS = 1500;
function webAnswerBody(model, question, results) {
  const list = (results || []).map((r, i) => '[' + (i + 1) + '] ' + (r.title || '') + ' (' + (r.url || '') + ')\n' +
    String(r.content || '').replace(/\s+/g, ' ').slice(0, WEB_CHARS)).join('\n\n');
  return { model, temperature: 0, max_tokens: 700, reasoning_effort: 'none',
    messages: [
      { role: 'system', content: 'Answer the question using ONLY the numbered web results. Cite each fact with its number, like [2]. ' +
        'Quote figures and names exactly as the results give them, and give the date or year of each event when the results state it. If the results do not answer the question, say so in one sentence. ' +
        'Plain text for Telegram: no markdown, no headings, at most 6 short sentences or bullet lines.' },
      { role: 'user', content: 'Question: ' + question + '\n\nWeb results:\n' + list }] };
}

// Final text: label, answer, and only the sources it cited (all of them when
// it cited none). checkMissing = figures/names the answer check could not find
// in the results; any = say the results were unclear instead of guessing.
function formatWebReply(answer, results, checkMissing) {
  const res = results || [];
  const a = String(answer || '').trim();
  if (!res.length) return 'Not in your feed, and the web search came back empty.';
  if (!a || (checkMissing && checkMissing.length)) {
    return 'Not in your feed. The web results did not give a clear answer — the closest pages:\n' +
      res.slice(0, 3).map((r, i) => '[' + (i + 1) + '] ' + r.title + ' ' + r.url).join('\n');
  }
  const cited = [...new Set((a.match(/\[(\d)\]/g) || []).map((m) => Number(m[1])))].filter((n) => n >= 1 && n <= res.length);
  const show = (cited.length ? cited : res.slice(0, 3).map((_, i) => i + 1)).sort((x, y) => x - y);
  return 'From the web (not your feed):\n' + a + '\n\nSources:\n' + show.map((n) => '[' + n + '] ' + res[n - 1].title + ' ' + res[n - 1].url).join('\n');
}

module.exports = { needsWeb, tavilyBody, webAnswerBody, formatWebReply };
