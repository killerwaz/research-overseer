// #13 (2026-10-12): one cited answer across several feed items, instead of a list.
// "what's happening with AI policy in South Asia?" -> 3-6 sentences, every claim
// cited [n] against the numbered items WF-31 returned, then the numbered list
// (with 👍/👎) underneath. Wasim's calls: thinking off vs on built behind the
// switch fix_synth (off | fast | think) and measured; 1-2 items -> a short
// answer that says the feed is thin, no web; the source list stays.
//
// The route is decided here, in code: the 9B picks tools unreliably with
// thinking off (it answered 4/4 source-quality phrasings from context, #9).
// Inlined into WF-00 (route) and WF-45 synth_answer (everything else).
// Needs figures/norm/unsupportedFacts from answer-check.js inlined first.

// ---- which questions get a written answer ----

const BIG_PICTURE = new RegExp([
  "\\bwhat('?s| is| are)\\s+(happening|going on|changing|new)\\s+(with|in|on|around|for|across)\\b",
  "\\bwhat('?s| is) the (state|status|latest|story|picture|situation) (of|on|with|in)\\b",
  "\\bhow (are|is|do|does|have|has)\\b[^?]{0,60}\\b(handling|dealing|approaching|responding|reacting|adapting|coping|managing|tackling|using|adopting|regulating|treating|thinking about)\\b",
  "\\b(overview|summary|summari[sz]e|big picture|landscape|trends?|themes?|takeaways?|gist|state of play)\\b",
  "\\b(compare|comparison|versus|vs\\.?)\\b",
  "\\bwhat (do|does) (my|the) (feed|items|articles|sources) say about\\b",
  "\\bwhat are the (main|key|latest|big|major) (developments|debates|arguments|issues|questions|risks|players|moves)\\b",
  "\\b(explain|walk me through) (what|how|why)\\b",
].join('|'), 'i');

// Lists, follow-ups, commands and questions about the bot itself stay on the agent.
const NOT_SYNTH = new RegExp([
  'https?://',
  '#\\s?\\d+\\b',
  '\\b(first|second|third|fourth|fifth|last) (one|item|article|story|link)\\b',
  '\\b(item|number|no\\.?)\\s?\\d+\\b',
  '^\\s*(anything|any (news|updates?|items?))\\b',
  '\\b(show me|list|give me (a list|the list))\\b',
  '\\b(search|sweep|run|discover|find new|look up|scrape|add|remove|follow|unfollow|subscribe|schedule|transcribe)\\b',
  '\\b(run|runs|status|broke|broken|failed)\\b',
  '\\b(my|the|your) (sources?|feeds?)\\b(?! say)',
].join('|'), 'i');

function bigPictureQ(question) {
  const q = String(question || '').trim();
  if (!q || q.split(/\s+/).length < 3) return false;
  if (NOT_SYNTH.test(q)) return false;
  return BIG_PICTURE.test(q);
}

// ---- the prompt ----

const SYNTH_MAX_ITEMS = 8;
const EV_FULL = 1500;   // the first 3 items carry whole passages
const EV_SHORT = 600;

function evidenceText(ev) {
  if (!ev) return '';
  if (typeof ev === 'string') return ev;
  if (Array.isArray(ev)) return ev.map(evidenceText).filter(Boolean).join(' … ');
  if (typeof ev === 'object') return String(ev.text || ev.fragments || ev.headline || '');
  return '';
}

function itemTitle(it) {
  const t = String(it.title || '').trim();
  if (t && t !== 'null') return t;
  const m = String(it.canonical_url || '').match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return m ? m[1] : 'untitled';
}

function itemBlock(it, i) {
  const date = it.published_at ? String(it.published_at).slice(0, 10) : 'undated';
  const ev = evidenceText(it.evidence).replace(/\s+/g, ' ').trim().slice(0, i < 3 ? EV_FULL : EV_SHORT);
  return '[' + it.n + '] ' + itemTitle(it) + ' (published ' + date + ')\n' +
    'Summary: ' + String(it.summary || '').replace(/\s+/g, ' ').trim() + (ev ? '\nFrom the article: ' + ev : '');
}

const SYNTH_SYSTEM = 'You answer a question from the user\'s own research feed. Use ONLY the numbered items below. ' +
  'Write 3 to 6 sentences that pull the items together: what is happening, who is doing it, the figures and dates. ' +
  'End EVERY sentence with the number of each item it rests on, like [2] or [1][4]. Use only the numbers given. ' +
  'Quote figures and names exactly as the items give them. If items disagree, say so. ' +
  'Skip items that are off the question, and say what the items report, never what kind of page they are. ' +
  'If the question compares several things and the items cover only some, say plainly which ones the feed has nothing on. ' +
  'If none of the items answers the question, reply with exactly: ' + 'NOT IN FEED' + ' ' +
  'Plain text for Telegram: no markdown, no headings, no bullet list, no list of sources at the end.';

// The 9B's marker for "the items do not answer this" (measured 2026-10-12: asked
// to "say so", it wrote three sentences about an unrelated item instead).
const NOT_IN_FEED = /^\W*not in feed\W*$/i;
const NOTHING_REPLY = 'Your feed has nothing on this yet.';

function synthBody(model, question, items, mode, feedback) {
  const list = (items || []).slice(0, SYNTH_MAX_ITEMS).map(itemBlock).join('\n\n');
  const messages = [
    { role: 'system', content: SYNTH_SYSTEM },
    { role: 'user', content: 'Question: ' + question + '\n\nItems:\n' + list }];
  if (feedback) {
    messages.push({ role: 'assistant', content: feedback.previous });
    messages.push({ role: 'user', content: 'That answer broke the rules: ' + feedback.problems.join('; ') +
      '. Rewrite it. Every sentence must end with item numbers from the list, and every figure must come from the items you cite.' });
  }
  const think = mode === 'think';
  return { model, temperature: 0, messages,
    reasoning_effort: think ? 'medium' : 'none',
    max_tokens: think ? 6000 : 900 };
}

// ---- checking the answer ----

// "[1][4]", "[1, 4]" and "[1-3]" all count.
function citations(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\]/g)) {
    for (const part of m[1].split(/\s*,\s*/)) {
      const r = part.match(/^(\d+)\s*[–-]\s*(\d+)$/);
      if (r) { for (let k = Number(r[1]); k <= Number(r[2]) && k - Number(r[1]) < 20; k++) out.push(k); } else out.push(Number(part));
    }
  }
  return out;
}

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?](?:\s*\[[\d,\s–-]+\])*)\s+(?=[A-Z"“'(])/)
    .map((s) => s.trim()).filter((s) => s.length > 0);
}

// answer-check.js skips whole numbers up to 20 (too many false alarms in chat).
// Here a small whole number written as money or a rate is checked too. Measured
// 2026-10-12, Q2: "over $12/hr on reserved AWS instances" went through, but the
// item gives $12.29/hr for Azure (AWS: $6.88). Larger and decimal figures are
// already checked by unsupportedFacts.
const SMALL_MONEY = /(?:[$€£৳]|\b(?:usd|bdt|tk|inr|eur)\s?)(\d{1,2})(?![\d.,])(?!\s*(?:million|billion|thousand|mn|bn|[mbk]\b))|(?<![\d.,])\b(\d{1,2})(?![\d.,])\s*(?:\/\s*(?:hr|hour|h|month|mo|year|yr|gpu|card)\b|per (?:hour|month|year|gpu|card)\b)/gi;
function smallMoney(sentence, evidence, question) {
  const ev = String(evidence || '').replace(/(\d),(?=\d{3}\b)/g, '$1');
  const q = String(question || '');
  const missing = [];
  for (const m of String(sentence || '').matchAll(SMALL_MONEY)) {
    const n = m[1] || m[2];
    if (Number(n) > 20) continue;   /* unsupportedFacts covers these */
    // the number must appear in the same form: "$12" as money, "12/hr" as a rate.
    // A bare "12" elsewhere in a long article (a table row, "12 months") let Q2's
    // "$12/hr" through on the full text, 2026-10-13.
    const num = '(?<![\\d.,])' + n + '(?![\\d]|[.,]\\d)';
    const form = m[1]
      ? new RegExp('(?:[$€£৳]|\\b(?:usd|bdt|tk|inr|eur)\\s?)\\s?' + num + '|' + num + '\\s?(?:dollars|usd|taka)\\b', 'i')
      : new RegExp(num + '\\s*(?:\\/|per\\b)', 'i');
    if (new RegExp(num).test(q) || form.test(ev)) continue;
    missing.push(m[0].trim());
  }
  return missing;
}

const SAYS_NOTHING =/\b(do(es)? not|don.t|doesn.t|no item|none of the items|not (say|cover|mention|address)|(has|have) nothing (on|about)|no (items?|coverage|information|reporting) (on|about))\b/i;

function checkSynth(answer, items, question) {
  const byN = new Map((items || []).map((it) => [Number(it.n), it]));
  const a = String(answer || '').trim();
  const problems = [];
  if (!a) return { ok: false, problems: ['empty answer'], cited: [] };
  if (NOT_IN_FEED.test(a)) return { ok: true, problems, uncited: [], cited: [], nothing: true };
  const all = citations(a);
  const bad = [...new Set(all.filter((n) => !byN.has(n)))];
  if (bad.length) problems.push('cites items that do not exist: ' + bad.map((n) => '[' + n + ']').join(' '));
  if (!all.length && !SAYS_NOTHING.test(a)) problems.push('no citations at all');
  const uncited = [];
  for (const s of sentences(a)) {
    const cs = citations(s).filter((n) => byN.has(n));
    if (!cs.length) {
      if (!SAYS_NOTHING.test(s) && s.length >= 25) uncited.push(s);
      continue;
    }
    const ev = cs.map((n) => { const it = byN.get(n); return itemTitle(it) + ' ' + (it.summary || '') + ' ' + evidenceText(it.evidence); }).join(' ');
    const plain = s.replace(/\[[\d,\s–-]+\]/g, '');
    const miss = unsupportedFacts(plain, ev, question).concat(smallMoney(plain, ev, question));
    if (miss.length) problems.push('figures not in the cited items: ' + miss.join(', ') + ' (in: "' + s.slice(0, 80) + '")');
  }
  if (uncited.length) problems.push(uncited.length + ' sentence(s) without an item number: "' + uncited[0].slice(0, 80) + '"');
  return { ok: problems.length === 0, problems, uncited, cited: [...new Set(all.filter((n) => byN.has(n)))] };
}

// Second failure, but the only fault is a sentence or two without a number:
// drop those sentences rather than throw the whole answer away.
function salvage(answer, check) {
  if (!check || check.ok) return answer;
  if (check.problems.some((p) => !/without an item number/.test(p))) return '';
  const kept = sentences(answer).filter((s) => !check.uncited.includes(s));
  return kept.length >= 2 ? kept.join(' ') : '';
}

// ---- the second reading: is each sentence supported by the items it cites? ----
// The checks above catch wrong numbers and missing citations, not a true fact
// pinned to the wrong thing. Measured 2026-10-13, Q7 (twice): the item says the
// EU AI Act sets documentation duties for general-purpose models and, separately,
// that Article 13 covers high-risk systems; the answer said "Article 13 mandates
// that developers disclose training methodologies ... for these [general-purpose]
// models". Every word was in the item. A second call (thinking off) reads each
// sentence against only the items it cites.

const VERIFY_EV = 1500;
const VERIFY_SYSTEM = 'You check an answer against its sources. For each numbered sentence, read ONLY the source items it cites. ' +
  'supported = true only if every fact in the sentence is stated in those items: names, numbers, dates, who did what, and what applies to what. ' +
  'supported = false if the sentence attaches a fact to the wrong person, company, country, law, article, product or year; ' +
  'if it joins two facts the items keep separate into a claim they do not make; if it reverses or overstates what the items say; ' +
  'or if it adds a fact the items do not contain. Wording may differ; meaning may not. ' +
  'In why, name the exact fact that is wrong or missing, or write "ok".';

const VERIFY_SCHEMA = { type: 'json_schema', json_schema: { name: 'verdicts', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'why', 'supported'],
    properties: { n: { type: 'integer' }, why: { type: 'string' }, supported: { type: 'boolean' } } } } } } } };

// The sentences worth checking: those that cite an item. Honest "the feed has
// nothing on X" sentences carry no claim to check.
function claimSentences(answer, items) {
  const have = new Set((items || []).map((it) => Number(it.n)));
  return sentences(answer).map((s) => ({ s, cites: [...new Set(citations(s))].filter((n) => have.has(n)) }))
    .filter((x) => x.cites.length);
}

function verifyBody(model, answer, items) {
  const claims = claimSentences(answer, items);
  const byN = new Map((items || []).map((it) => [Number(it.n), it]));
  const used = [...new Set(claims.flatMap((c) => c.cites))].sort((a, b) => a - b);
  const sources = used.map((n) => { const it = byN.get(n);
    return '[' + n + '] ' + itemTitle(it) + '\nSummary: ' + String(it.summary || '').replace(/\s+/g, ' ').trim() +
      '\nText: ' + evidenceText(it.evidence).replace(/\s+/g, ' ').trim().slice(0, VERIFY_EV); }).join('\n\n');
  const list = claims.map((c, i) => (i + 1) + '. ' + c.s).join('\n');
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 200 + 120 * claims.length, response_format: VERIFY_SCHEMA,
    messages: [{ role: 'system', content: VERIFY_SYSTEM },
      { role: 'user', content: 'Source items:\n' + sources + '\n\nSentences to check:\n' + list }] };
}

// -> { unsupported: [{ s, why }], checked: n, parsed: bool }. A reply that cannot
// be read flags nothing (the answer has already passed the code checks).
function parseVerify(content, answer, items) {
  const claims = claimSentences(answer, items);
  let v = null;
  try { v = JSON.parse(String(content || '').replace(/^```(json)?|```$/g, '').trim()).verdicts; } catch (e) {}
  if (!Array.isArray(v)) return { unsupported: [], checked: claims.length, parsed: false };
  const unsupported = v.filter((x) => x && x.supported === false && claims[x.n - 1])
    .map((x) => ({ s: claims[x.n - 1].s, why: String(x.why || '').slice(0, 200) }));
  return { unsupported, checked: claims.length, parsed: true };
}

// Problems in the form the rewrite prompt takes.
function verifyProblems(result) {
  return (result.unsupported || []).map((u) => 'not supported by its items: "' + u.s.slice(0, 90) + '" (' + u.why + ')');
}

// ---- what happens to a flagged sentence (Wasim's chain, 2026-10-13) ----
// fix it with the checker's reason -> check the fix -> else quote the source
// line it rests on -> else drop it and say so. Nothing unchecked reaches him.

const FIX_SYSTEM = 'Rewrite ONE sentence so it says only what the cited source items state. ' +
  'A checker found this problem with it: the reason is given. Fix exactly that problem, keep everything else that is supported, ' +
  'and end the sentence with the same item numbers in brackets. Reply with the one sentence only. ' +
  'If no version of the sentence is supported by the items, reply exactly: DROP';

function fixBody(model, sentence, why, items) {
  const cites = [...new Set(citations(sentence))];
  const byN = new Map((items || []).map((it) => [Number(it.n), it]));
  const sources = cites.filter((n) => byN.has(n)).map((n) => { const it = byN.get(n);
    return '[' + n + '] ' + itemTitle(it) + '\nSummary: ' + String(it.summary || '').replace(/\s+/g, ' ').trim() +
      '\nText: ' + evidenceText(it.evidence).replace(/\s+/g, ' ').trim().slice(0, VERIFY_EV); }).join('\n\n');
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 300,
    messages: [{ role: 'system', content: FIX_SYSTEM },
      { role: 'user', content: 'Source items:\n' + sources + '\n\nSentence: ' + sentence + '\n\nProblem: ' + why }] };
}

// the model's fix, or '' (DROP, empty, or it lost its item numbers)
function readFix(content, sentence) {
  const t = String(content || '').trim().replace(/^["“]|["”]$/g, '').split(/\n/)[0].trim();
  if (!t || /^drop\b/i.test(t)) return '';
  return citations(t).length ? t : '';
}

const STOP = new Set('about after again their there these those which while where would could should other being between through during before under above below every within without across along among around because against toward towards since until still also just more most much many such some than that this with from have were been into over only very what when your will them then they each both same well like'.split(' '));
function contentWords(t) {
  return new Set((String(t || '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter((w) => !STOP.has(w)));
}

// The source sentence the flagged one most likely rests on, verbatim, as
// '[6] says: "..."'. Markdown tables and link lists are skipped; at least 3
// shared content words, or nothing.
function bestQuote(sentence, items) {
  const want = contentWords(sentence.replace(/\[[\d,\s–-]+\]/g, ''));
  const byN = new Map((items || []).map((it) => [Number(it.n), it]));
  let best = null;
  for (const n of new Set(citations(sentence))) {
    const it = byN.get(n);
    if (!it) continue;
    const text = String(it.summary || '') + ' ' + evidenceText(it.evidence);
    for (const raw of text.split(/(?<=[.!?])\s+|\n+|\s…\s/)) {
      const s = raw.replace(/[#*_`|>]+/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
      if (s.length < 30 || s.length > 300 || /https?:\/\//.test(s)) continue;
      const hit = [...contentWords(s)].filter((w) => want.has(w)).length;
      if (hit >= 3 && (!best || hit > best.hit)) best = { n, s, hit };
    }
  }
  return best ? '[' + best.n + '] says: "' + best.s + '"' : '';
}

function replaceSentence(answer, oldS, newS) {
  const ss = sentences(answer);
  const k = ss.indexOf(oldS);
  if (k < 0) return answer;
  if (newS) ss[k] = newS; else ss.splice(k, 1);
  return ss.join(' ');
}

const DROP_NOTE = (k) => '(' + k + ' sentence' + (k === 1 ? '' : 's') + ' removed: I could not confirm ' + (k === 1 ? 'it' : 'them') + ' against the sources.)';

// One flagged sentence's fate. fixes: [{ s, fix, fixOk }] — fix = the model's
// rewrite ('' if it said DROP), fixOk = the rewrite passed its own check.
// -> { answer, fixed, quoted, dropped }. Measured 2026-10-13 on 23 flagged
// sentences: 19 fixed, 4 quoted, 0 dropped; every real error came out right.
function applyFixes(answer, fixes, items) {
  let a = String(answer || '');
  let fixed = 0, quoted = 0, dropped = 0;
  for (const f of fixes || []) {
    if (f.fix && f.fixOk) { a = replaceSentence(a, f.s, f.fix); fixed++; continue; }
    const q = bestQuote(f.s, items);
    if (q) { a = replaceSentence(a, f.s, q); quoted++; } else { a = replaceSentence(a, f.s, ''); dropped++; }
  }
  if (dropped) a += ' ' + DROP_NOTE(dropped);
  return { answer: a, fixed, quoted, dropped };
}

// Second failure: drop the unsupported sentences if at least two cited ones remain.
function dropUnsupported(answer, result) {
  const bad = new Set((result.unsupported || []).map((u) => u.s));
  const kept = sentences(answer).filter((s) => !bad.has(s));
  return kept.filter((s) => citations(s).length).length >= 2 ? kept.join(' ') : '';
}

// ---- the reply ----

function sourceList(items) {
  return (items || []).slice(0, SYNTH_MAX_ITEMS).map((it) => it.n + '. ' + itemTitle(it) +
    (it.published_at ? ' (' + String(it.published_at).slice(0, 10) + ')' : '')).join('\n');
}

function thinNote(count) {
  return count <= 2 ? 'Your feed has only ' + count + ' item' + (count === 1 ? '' : 's') + ' on this:\n' : '';
}

function formatSynth(answer, items) {
  const shown = (items || []).slice(0, SYNTH_MAX_ITEMS);
  return thinNote(shown.length) + String(answer || '').trim() + '\n\nSources:\n' + sourceList(shown);
}

// The reply and the items it shows (whose 👍/👎 buttons go with it). "Nothing"
// shows no items: the closest ones were judged off the question. That wording
// is also what lets Fix 2 answer from the web, as it does for the agent.
// The 9B rarely uses the marker; it hedges instead ("The item notes a dataset
// includes quantum firms [1]. The items do not cover the Kenyan context."). An
// answer that says the items miss the question and has at most one real cited
// sentence is treated as nothing (measured 2026-10-12, Q12 twice).
const MISSES = /\b(do(es)? not (cover|answer|address|discuss|mention|include)|cannot answer|can.t answer|nothing (on|about|to say)|no (information|data|details|reporting|items?|coverage) (on|about|regarding|for))\b/i;
function answersNothing(answer) {
  const a = String(answer || '').trim();
  if (NOT_IN_FEED.test(a)) return true;
  const ss = sentences(a);
  const real = ss.filter((s) => citations(s).length && !MISSES.test(s) && !SAYS_NOTHING.test(s)).length;
  return ss.some((s) => MISSES.test(s)) && real <= 1;
}

function finalReply(answer, items) {
  if (answersNothing(answer)) return { output: NOTHING_REPLY, items: [] };
  const shown = (items || []).slice(0, SYNTH_MAX_ITEMS);
  return { output: formatSynth(answer, shown), items: shown };
}

// No usable answer: the items as a plain numbered list, as the agent would give.
function formatFallback(items) {
  const shown = (items || []).slice(0, SYNTH_MAX_ITEMS);
  if (!shown.length) return 'Your feed has nothing on this yet.';
  return thinNote(shown.length) + 'I could not write a checked summary, so here are the items:\n' +
    shown.map((it) => it.n + '. ' + itemTitle(it) + ' — ' + String(it.summary || '').split(/(?<=\.)\s/)[0]).join('\n');
}

// what the router passes WF-31 as the topic: the question minus its lead-in
function synthTopic(question) {
  // A comparison searches each side separately (WF-31 gives every "|" topic a
  // fair share). Measured 2026-10-12: "compare Bangladesh and Nigeria on AI
  // regulation" as one topic came back all Bangladesh, and the answer never said
  // the feed had nothing on Nigeria.
  const q0 = String(question || '').trim().replace(/[?!.]+\s*$/, '');
  const cmp = q0.match(/^(?:please\s+)?(?:compare|comparing|contrast)\s+(.+?)\s+(?:and|with|vs\.?|versus|to|against)\s+(.+?)(?:\s+(?:on|in|for|over|regarding|when it comes to)\s+(.+))?$/i) ||
    q0.match(/^(.+?)\s+(?:vs\.?|versus)\s+(.+?)(?:\s+(?:on|in|for|over)\s+(.+))?$/i);
  if (cmp) return cmp[3] ? cmp[1] + ' ' + cmp[3] + ' | ' + cmp[2] + ' ' + cmp[3] : cmp[1] + ' | ' + cmp[2];
  return String(question || '').trim()
    .replace(/^\s*(hey|hi|so|ok(ay)?|and|also)[,!\s]+/i, '')
    .replace(/^(can you |could you |please )?(give me |tell me )?(an? )?(quick |short |brief )?(overview|summary|rundown|gist|big picture)( of| on| about)?\s*/i, '')
    .replace(/^what('?s| is| are)\s+(happening|going on|changing|new)\s+(with|in|on|around|for|across)\s+/i, '')
    .replace(/^what('?s| is) the (state|status|latest|story|picture|situation) (of|on|with|in)\s+/i, '')
    .replace(/^summari[sz]e\s+(what (my|the) feed (says|has) (on|about)\s+)?/i, '')
    .replace(/^what (do|does) (my|the) (feed|items|articles|sources) (say|have) (about|on)\s+/i, '')
    .replace(/^what are the (main|key|latest|big|major) (developments|debates|arguments|issues|questions|risks|players|moves) (in|on|around|about|with)\s+/i, '')
    .replace(/[?!.]+\s*$/, '')
    .trim();
}

module.exports = { bigPictureQ, synthTopic, synthBody, checkSynth, salvage, finalReply, NOTHING_REPLY, verifyBody, parseVerify, verifyProblems, dropUnsupported, claimSentences, fixBody, readFix, bestQuote, replaceSentence, DROP_NOTE, applyFixes, citations, sentences, formatSynth, formatFallback, sourceList, itemTitle, evidenceText, SYNTH_MAX_ITEMS };
