const test = require('node:test');
const assert = require('node:assert');
// synth.js is inlined after answer-check.js in n8n; give it the same global here
global.unsupportedFacts = require('../shared/answer-check.js').unsupportedFacts;
const { bigPictureQ, synthTopic, synthBody, checkSynth, salvage, citations, sentences, formatSynth, formatFallback } = require('../shared/synth.js');

const SYNTH = [
  "what's happening with AI policy in South Asia?",
  'how are companies handling the cost of GPUs?',
  'give me an overview of agent evaluation',
  'compare Bangladesh and Nigeria on AI regulation',
  'what does my feed say about MCP security?',
  'what are the main debates in AI governance right now?',
  'how is the EU regulating general-purpose AI models?',
  'summarize the trends in GPU rental pricing',
];
const NOT = [
  'anything on bangladesh bank?', 'show me the best items this week', 'tell me about #3', 'tell me more about the first one',
  'how are my sources doing?', 'did the last run work?', 'search brave for AI policy news', 'who bought Langfuse?',
  'how much has Harvey raised?', 'https://example.com/a', 'hi', 'add this feed https://x.com/rss',
  'what feeds are you watching?', 'run a sweep on agent payments',
];

test('bigPictureQ: synthesis questions yes; lists, lookups, commands, follow-ups no', () => {
  for (const q of SYNTH) assert.ok(bigPictureQ(q), q);
  for (const q of NOT) assert.ok(!bigPictureQ(q), q);
});

test('synthTopic strips the lead-in only', () => {
  assert.strictEqual(synthTopic("what's happening with AI policy in South Asia?"), 'AI policy in South Asia');
  assert.strictEqual(synthTopic('give me an overview of agent evaluation'), 'agent evaluation');
  assert.strictEqual(synthTopic('how are companies handling the cost of GPUs?'), 'how are companies handling the cost of GPUs');
  // measured 2026-10-12: the whole question as the topic found 0 items; "MCP security" finds 8
  assert.strictEqual(synthTopic('what does my feed say about MCP security?'), 'MCP security');
  assert.strictEqual(synthTopic('what are the main debates in AI governance right now?'), 'AI governance right now');
});

test('synthTopic splits a comparison into one topic per side', () => {
  assert.strictEqual(synthTopic('compare Bangladesh and Nigeria on AI regulation'), 'Bangladesh AI regulation | Nigeria AI regulation');
  assert.strictEqual(synthTopic('compare exa with brave'), 'exa | brave');
  assert.strictEqual(synthTopic('LangGraph vs CrewAI for agents?'), 'LangGraph agents | CrewAI agents');
});

test('NOT IN FEED: ok, no items shown, the wording Fix 2 recognises', () => {
  const { finalReply, NOTHING_REPLY } = require('../shared/synth.js');
  const { needsWeb } = require('../shared/web-fallback.js');
  assert.ok(checkSynth('NOT IN FEED', ITEMS, 'q').nothing);
  assert.deepStrictEqual(finalReply('NOT IN FEED.', ITEMS), { output: NOTHING_REPLY, items: [] });
  assert.strictEqual(needsWeb({ question: 'what is happening with quantum computing in Kenya?', reply: NOTHING_REPLY }).web, true);
  assert.strictEqual(finalReply('Answer [1].', ITEMS).items.length, 3);
});

test('a cited feed answer that mentions a gap is not sent to the web (bKash, 2026-10-13)', () => {
  const { needsWeb } = require('../shared/web-fallback.js');
  const reply = 'bKash received approval on September 28, 2026 [1]. The feed does not contain information regarding launch dates for the digital bank.';
  assert.strictEqual(needsWeb({ question: "what's happening with bKash digital bank?", reply, feedItems: 6 }).web, false);
  assert.strictEqual(needsWeb({ question: "what's happening with bKash digital bank?", reply }).web, true);   // the agent's path is unchanged
});

test('a hedged non-answer counts as nothing; a real answer with one gap does not', () => {
  const { finalReply, NOTHING_REPLY } = require('../shared/synth.js');
  // Q12, verbatim from the 2026-10-12 run
  const hedge = 'The provided item notes that a dataset includes details on firms in quantum computing within US funding rounds exceeding $100M in June 2026 [1]. The items report only on US startup funding and do not cover the Kenyan context.';
  assert.strictEqual(finalReply(hedge, ITEMS).output, NOTHING_REPLY);
  const real = 'Bangladesh is drafting a policy [1]. Critics say the draft lacks protections [2]. The items do not cover its cost.';
  assert.notStrictEqual(finalReply(real, ITEMS).output, NOTHING_REPLY);
});

test('a "the feed has nothing on X" sentence needs no citation', () => {
  assert.ok(checkSynth('Bangladesh is drafting a human-centric AI policy [1]. The feed has nothing on Nigeria.', ITEMS, 'q').ok);
});

test('citations: [1][4], [1, 4], [2-3]', () => {
  assert.deepStrictEqual(citations('A [1][4]. B [1, 4]. C [2-3].'), [1, 4, 1, 4, 2, 3]);
  assert.deepStrictEqual(citations('no cites'), []);
});

test('sentences split after a citation', () => {
  assert.deepStrictEqual(sentences('Bangladesh is drafting a policy [1]. Critics say it lacks protections [2][3].'),
    ['Bangladesh is drafting a policy [1].', 'Critics say it lacks protections [2][3].']);
});

const ITEMS = [
  { n: 1, id: '348', title: 'Bangladesh drafting AI policy', summary: 'Bangladesh is drafting a human-centric AI policy.', evidence: { text: 'The minister spoke at WAIC 2026 in Shanghai.' }, published_at: '2026-10-09T00:00:00Z' },
  { n: 2, id: '312', title: 'Reforming AI laws in Bangladesh', summary: 'The 2024 draft lacks protections against AI harms.', evidence: [{ text: 'Section 21 of the act' }, { text: 'fines up to 500,000 taka' }] },
  { n: 3, id: '355', title: 'null', canonical_url: 'https://www.dig.watch/x', summary: 'Global South AI governance capacity.', evidence: null },
];

test('checkSynth passes a cited answer whose figures are in the cited items', () => {
  const a = 'Bangladesh is drafting a human-centric AI policy, announced at WAIC 2026 [1]. Critics say the draft lacks protections, with fines up to 500,000 taka [2].';
  const c = checkSynth(a, ITEMS, 'q');
  assert.ok(c.ok, c.problems.join('; '));
  assert.deepStrictEqual(c.cited, [1, 2]);
});

test('checkSynth catches made-up numbers, missing citations and figures from the wrong item', () => {
  assert.match(checkSynth('Bangladesh is drafting a policy [7].', ITEMS, 'q').problems.join(), /do not exist: \[7\]/);
  assert.match(checkSynth('Bangladesh is drafting a human-centric policy for the whole region.', ITEMS, 'q').problems.join(), /no citations/);
  assert.match(checkSynth('Fines reach 500,000 taka [1].', ITEMS, 'q').problems.join(), /figures not in the cited items: 500000/);
  const c = checkSynth('Bangladesh is drafting a policy [1]. This shows the region is moving fast on rules.', ITEMS, 'q');
  assert.match(c.problems.join(), /without an item number/);
  assert.strictEqual(checkSynth('', ITEMS, 'q').ok, false);
});

test('small money and rate figures are checked exactly (Q2: $12/hr vs $12.29/hr)', () => {
  const items = [{ n: 6, title: 'Cost of running an AI product', summary: 'H100 rates', evidence: { text: 'spot pricing dips to $1.03/hr, AWS p5 runs $6.88/hr and Azure closer to $12.29/hr; A100 at $2/hr; 1,950,000 for 32 GPUs' } }];
  assert.match(checkSynth('Reserved AWS instances run over $12/hr [6].', items, 'q').problems.join(), /\$12\/hr/);
  assert.ok(checkSynth('Azure runs closer to $12.29/hr while spot dips to $1.03/hr [6].', items, 'q').ok);
  assert.ok(checkSynth('An A100 costs $2/hr [6].', items, 'q').ok);
  assert.match(checkSynth('An A100 costs 3 per hour [6].', items, 'q').problems.join(), /3 per hour/);
  assert.ok(checkSynth('A cluster costs $1.95 million for 32 GPUs [6].', items, 'q').ok);   // millions are unsupportedFacts' job
  assert.ok(checkSynth('Bangladesh has 8 divisions [6].', items, 'q').ok);                 // a bare small number is not money
  // a bare "12" in another cited item does not license "$12/hr" (live miss, 2026-10-13)
  const two = items.concat([{ n: 1, title: 'Cluster guide', summary: 'costs', evidence: { text: '| Racks | 12 | over 12 months' } }]);
  assert.match(checkSynth('Rates run from $1.03/hr to over $12/hr on AWS [1][6].', two, 'q').problems.join(), /\$12/);
});

test('checkSynth accepts an honest "the items do not say"', () => {
  assert.ok(checkSynth('The items do not say how much the policy will cost.', ITEMS, 'q').ok);
});

test('salvage drops uncited sentences only when that is the sole fault', () => {
  const a = 'Bangladesh is drafting a policy [1]. Critics say the draft lacks protections [2]. This shows the region is moving fast on rules.';
  assert.strictEqual(salvage(a, checkSynth(a, ITEMS, 'q')), 'Bangladesh is drafting a policy [1]. Critics say the draft lacks protections [2].');
  const b = 'Fines reach 500,000 taka [1]. Bangladesh is drafting a policy [1].';
  assert.strictEqual(salvage(b, checkSynth(b, ITEMS, 'q')), '');
});

test('formatSynth: thin note for 1-2 items, numbered sources with dates, null titles become the site', () => {
  const two = formatSynth('Answer [1].', ITEMS.slice(0, 2));
  assert.match(two, /^Your feed has only 2 items on this:\nAnswer \[1\]\.\n\nSources:\n1\. Bangladesh drafting AI policy \(2026-10-09\)\n2\. Reforming/);
  const three = formatSynth('Answer [1].', ITEMS);
  assert.ok(!/only/.test(three));
  assert.match(three, /3\. dig\.watch/);
});

test('formatFallback lists items with their first sentence; empty says so', () => {
  assert.match(formatFallback(ITEMS), /^I could not write a checked summary, so here are the items:\n1\. Bangladesh drafting AI policy — Bangladesh is drafting/);
  assert.strictEqual(formatFallback([]), 'Your feed has nothing on this yet.');
});

test('verifyBody / parseVerify: one verdict per cited sentence; unreadable flags nothing', () => {
  const { verifyBody, parseVerify } = require('../shared/synth.js');
  const a = 'Bangladesh is drafting a human-centric AI policy [1]. The feed has nothing on Nigeria.';
  const b = verifyBody('m', a, ITEMS);
  assert.strictEqual(b.reasoning_effort, 'none');
  assert.match(b.messages[1].content, /Sentences to check:\n1\. Bangladesh is drafting/);
  assert.ok(!/Nigeria/.test(b.messages[1].content.split('Sentences to check:')[1]));   // no claim, not checked
  const v = parseVerify('{"verdicts":[{"n":1,"why":"wrong ministry","supported":false}]}', a, ITEMS);
  assert.deepStrictEqual(v.unsupported.map((u) => u.why), ['wrong ministry']);
  assert.strictEqual(parseVerify('not json', a, ITEMS).unsupported.length, 0);
});

test('applyFixes: checked fix, else the source line, else drop with a note', () => {
  const { applyFixes, bestQuote, readFix } = require('../shared/synth.js');
  const items = [{ n: 7, title: 'The fight to get AI right in Bangladesh', summary: 'Upol Ehsan is collaborating with Bangladesh\'s Ministry of Social Welfare to draft a national AI policy and task force.', evidence: null },
    { n: 2, title: 'x', summary: 'Nothing related here at all.', evidence: null }];
  const a = 'Upol Ehsan works with the ICT Division on the policy [7]. Snyk uses LangSmith [2]. Critics object [7].';
  assert.strictEqual(readFix('DROP', 'x'), '');
  assert.strictEqual(readFix('A sentence without numbers.', 'x'), '');
  assert.match(bestQuote('Upol Ehsan works with the ICT Division to draft the national AI policy [7].', items), /^\[7\] says: "Upol Ehsan is collaborating with Bangladesh's Ministry of Social Welfare/);
  const r = applyFixes(a, [
    { s: 'Upol Ehsan works with the ICT Division on the policy [7].', fix: 'Upol Ehsan works with the Ministry of Social Welfare on the policy [7].', fixOk: true },
    { s: 'Snyk uses LangSmith [2].', fix: '', fixOk: false }], items);
  assert.strictEqual(r.answer, 'Upol Ehsan works with the Ministry of Social Welfare on the policy [7]. Critics object [7]. (1 sentence removed: I could not confirm it against the sources.)');
  assert.deepStrictEqual([r.fixed, r.quoted, r.dropped], [1, 0, 1]);
  const q = applyFixes('Upol Ehsan works with the ICT Division to draft the national AI policy [7].', [{ s: 'Upol Ehsan works with the ICT Division to draft the national AI policy [7].', fix: 'x [7].', fixOk: false }], items);
  assert.strictEqual(q.quoted, 1);
  assert.match(q.answer, /^\[7\] says: "Upol Ehsan is collaborating/);
});

test('synthBody: thinking only in think mode; retry carries the problems', () => {
  const f = synthBody('m', 'q', ITEMS, 'fast');
  assert.strictEqual(f.reasoning_effort, 'none');
  assert.strictEqual(synthBody('m', 'q', ITEMS, 'think').reasoning_effort, 'medium');
  assert.match(f.messages[1].content, /\[2\] Reforming AI laws in Bangladesh \(published undated\)\nSummary: .*\nFrom the article: Section 21 of the act … fines up to 500,000 taka/);
  const r = synthBody('m', 'q', ITEMS, 'fast', { previous: 'x', problems: ['no citations at all'] });
  assert.strictEqual(r.messages.length, 4);
  assert.match(r.messages[3].content, /no citations at all/);
});
