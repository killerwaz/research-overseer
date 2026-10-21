// Fix 2 (2026-10-12): when the feed has no answer, answer from the web.
// Wasim's call: automatically, no cap, Tavily basic search (1 credit), answer
// only — nothing is saved to the feed. At most one web search per message.
// Inlined into WF-00 ("Web needed?") and WF-44 web_answer.

// The router's ways of saying the feed has nothing (seen in the end-to-end
// runs) plus Final check's safe reply.
const NO_ANSWER = /\b(the feed|your feed|feed's articles)\b[^.?!]{0,80}\b(doesn.t|does not|don.t|has no|have no|isn.t|is not|lacks?|no (recent |specific |direct )?(articles?|items?|stories|news|coverage|mention|details?|information|data))\b|\bnothing (in|on|about)\b[^.?!]{0,60}|\bno (recent |specific )?(articles?|items?|stories|news|coverage|results)\b[^.?!]{0,40}\b(on|about|in the feed|for)\b|couldn.t confirm an answer|not covered (by|in) (the|your) feed|feed doesn.t (say|specify|mention|cover|include|have)|\bfeed\b[^]{0,220}?\b(doesn.t|does not|didn.t|did not|don.t|do not) (specify|say|mention|include|give|state|list|cover|contain|have|answer)\b/i;
const SMALL_TALK = /^\s*(hi|hey|hello|thanks?|thank you|ok(ay)?|cool|nice|great|bye|good (morning|night|evening))\b/i;
const ABOUT_BOT = /\b(sources?|feeds? (are|you)|runs?|status|watching|subscri\w*|schedul\w*|scrape|transcribe|remember|forget)\b/i;

// "my feed" too (2026-10-21): "Argentina, who defeated France ... This information is not in my feed."
const FROM_MEMORY = /\b(general knowledge|common knowledge|from (my )?(own )?(training|memory|knowledge)|not (found )?in (your|the|my) (current )?(rss )?feed|isn.t in (your|the|my) feed|outside (of )?(your|the|my) feed)\b/i;

function needsWeb({ question, reply, alreadyWeb, feedItems }) {
  const q = String(question || '').trim(), r = String(reply || '');
  if (alreadyWeb) return { web: false, reason: 'already answered from the web' };
  // #13: a cited answer built from feed items is an answer, even when it ends
  // "the feed does not contain ... launch dates" (2026-10-13: that sentence sent a
  // good bKash answer to the web, which then replaced it with "Not in your feed").
  if (feedItems > 0) return { web: false, reason: 'answered from feed items' };
  // The bot answering from its own memory gets a sourced answer instead. Since the
  // prompt stopped offering searches (2026-10-13) it says so in new words:
  // "Argentina ... This information is general knowledge and not found in your
  // current RSS feed." — the wording rule below missed it.
  if (FROM_MEMORY.test(r) && !/https?:\/\//i.test(q) && !SMALL_TALK.test(q) && !ABOUT_BOT.test(q)) return { web: true, reason: 'answered from general knowledge' };
  if (!q || SMALL_TALK.test(q)) return { web: false, reason: 'small talk' };
  if (ABOUT_BOT.test(q)) return { web: false, reason: 'about the bot itself' };
  if (/https?:\/\//i.test(q)) return { web: false, reason: 'a link, handled by scrape_url' };
  if (!NO_ANSWER.test(r)) return { web: false, reason: 'the feed answered' };
  return { web: true, reason: 'the feed has no answer' };
}

// "Did the feed answer?" by meaning (2026-10-13). The NO_ANSWER wording above
// missed "The feed has one item on your topic: ... doesn't give specific advice
// ... Would you like me to search?" (Dhaka weather follow-up). The 9B judges the
// reply against the question, thinking off, one short JSON verdict.
const JUDGE_SYSTEM = 'You judge whether a reply answers the user\'s question. ' +
  'answered = true only if the reply gives the user what they asked for (the facts, list, explanation or advice). ' +
  'answered = false if the reply says the feed or the bot has nothing on it, cannot do it, lists only loosely related items without answering, ' +
  'or mainly offers or asks to search. A reply that answers and then offers more is still answered.';
const JUDGE_SCHEMA = { type: 'json_schema', json_schema: { name: 'judge', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['answered'], properties: { answered: { type: 'boolean' } } } } };

// #14: a reply built on an earlier chat often ALSO says the feed has nothing,
// which the prompt above counts as unanswered — it sent a right Anchorless answer
// to the web, which found a different Anchorless (2026-10-13). Measured on 6 real
// replies x2: every clear case right; it also counts "nothing came of it" as an
// answer to "what came of my search?", which it literally is.
const JUDGE_SYSTEM_EARLIER = 'You judge whether a reply answers the user\'s question. The reply may answer from an earlier conversation with the user ("On 13 Oct I told you ...") — that counts as answering, even if it also says the feed has nothing. ' +
  'answered = true if the reply gives the user what they asked for (the facts, name, list, explanation). ' +
  'answered = false if it only says nothing was found, talks about a different subject than the one asked, or mainly offers to search.';

function judgeBody(model, question, reply, earlier) {
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 30, response_format: JUDGE_SCHEMA,
    messages: [{ role: 'system', content: earlier ? JUDGE_SYSTEM_EARLIER : JUDGE_SYSTEM },
      { role: 'user', content: 'Question: ' + String(question || '').slice(0, 500) + '\n\nReply: ' + String(reply || '').slice(0, 2500) }] };
}

// true / false, or null when the verdict cannot be read (then the wording rule stands)
function readJudge(content) {
  try { const v = JSON.parse(String(content || '').trim()).answered; return typeof v === 'boolean' ? v : null; } catch (e) { return null; }
}

// The judge is consulted only when the reply offers or asks to search: alone it
// was 87/88 on recorded replies, but it called a correct answer that opened with a
// correction ("$1.5B, not $2B") unanswered. Every real miss offered a search.
// Measured 2026-10-13: wording rule 86/88, rule + (offer AND judge) 88/88.
const OFFERS_SEARCH = /\b(would you like|do you want|want me to|shall i|should i|i can|i could|happy to|let me know if you('d| would) like)\b[^.?!]{0,80}\b(search|look (it |this )?up|run|find|check|dig|fetch|pull)\b/i;
function offersSearch(reply) { return OFFERS_SEARCH.test(String(reply || '')); }

// ...or says the feed lacks it in words NO_ANSWER does not cover ("The feed has
// one item ... but it doesn't give specific advice"). Once replies stop offering
// searches (2026-10-13), this is what puts such a reply in front of the judge.
const SAYS_LACK = /\b(feed|items?|articles?|sources?|documents?)\b[^.?!]{0,160}\b(doesn.t|does not|don.t|do not|didn.t|isn.t|is not|aren.t|nothing|no specific|only (one|two|1|2))\b|\b(doesn.t|does not|don.t|do not|isn.t|no|nothing)\b[^.?!]{0,60}\b(specific|direct|details?|information|data|advice|mention|cover|answer|say)\b/i;
function saysLack(reply) { return SAYS_LACK.test(String(reply || '')); }

// The judge runs when the wording rule let a reply through but it offers a
// search or says something is missing. Web only if the judge then says "not answered".
function judgeNeeded(reply) { return offersSearch(reply) || saysLack(reply); }

// A follow-up ("what's your advice during this weather?") searched as is finds
// nothing useful; the web needs the place and topic from the previous exchange.
const STANDALONE_SYSTEM = 'Rewrite the user\'s latest message as one standalone web search question. ' +
  'Use the previous exchange only to fill in what the message leaves out (place, topic, product, time). ' +
  'If the message already stands alone, return it unchanged. Reply with the question only, no quotes.';

function standaloneBody(model, question, prevUser, prevBot) {
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 80,
    messages: [{ role: 'system', content: STANDALONE_SYSTEM },
      { role: 'user', content: 'Previous exchange:\nUser: ' + String(prevUser || '').slice(0, 400) + '\nBot: ' + String(prevBot || '').slice(0, 600) +
        '\n\nLatest message: ' + String(question || '').slice(0, 400) }] };
}

// the rewrite, or the original question when the rewrite is empty or runs away
function readStandalone(content, question) {
  const t = String(content || '').trim().split(/\n/)[0].replace(/^["“']|["”']$/g, '').trim();
  return t && t.length <= 300 ? t : String(question || '');
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

module.exports = { needsWeb, judgeBody, readJudge, offersSearch, saysLack, judgeNeeded, standaloneBody, readStandalone, tavilyBody, webAnswerBody, formatWebReply };
