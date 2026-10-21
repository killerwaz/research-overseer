const test = require('node:test');
const assert = require('node:assert');
const { needsWeb, tavilyBody, webAnswerBody, formatWebReply } = require('../shared/web-fallback.js');

const w = (question, reply, alreadyWeb) => needsWeb({ question, reply, alreadyWeb }).web;

// Real replies from the 2026-10-12 end-to-end baseline runs.
test('replies where the feed had nothing go to the web', () => {
  assert.equal(w('quantum error correction breakthroughs', 'The feed currently has no recent items on quantum error correction breakthroughs. Would you like me to run a live search for this topic?'), true);
  assert.equal(w('Formula One team budget cap', 'The feed has nothing on Formula One team budget caps right now. Want me to run a live search for it?'), true);
  assert.equal(w('best sourdough starter recipe', 'The feed has no stories on sourdough starter recipes. Want me to run a live search for it?'), true);
  assert.equal(w('Which command shows how much of your Claude usage limit is left?', 'The feed has no direct mention of a command that shows your remaining Claude usage limit. The closest relevant item is #1.'), true);
  assert.equal(w('Which command shows how much of your Claude usage limit is left?', "The feed mentions that your chats and every Claude code session draw from one shared allowance, but it doesn't specify which command shows how much of your usage limit is left."), true);
  assert.equal(w('What is the capital of Peru?', "I couldn't confirm an answer to that in your feed's articles."), true);
});

test('real answers from the feed stay put', () => {
  assert.equal(w("Which investors backed Baseten's $2B round?", 'Baseten raised $1.5B in Series F (not $2B), led by Altimeter Capital, Conviction, and Spark Capital.'), false);
  assert.equal(w('Who bought Langfuse?', "Langfuse was acquired by ClickHouse in January 2026. The deal came alongside ClickHouse's $400M Series D funding round."), false);
  assert.equal(w('How do you draw a perfectly straight line in PowerPoint?', '1. Press the Shift key while drawing the line in PowerPoint to keep it perfectly straight.'), false);
  assert.equal(w('How well utilised are GPUs?', 'Self-hosted GPUs in production typically run at 40–60% utilization, according to industry research.'), false);
});

test('small talk, questions about the bot, links and second web calls are never sent', () => {
  assert.equal(w('thanks!', 'The feed has nothing on that.'), false);
  assert.equal(w('which sources are you watching?', 'The feed has no sources about that.'), false);
  assert.equal(w('https://example.com/a', 'The feed has nothing on that.'), false);
  assert.equal(w('capital of Peru?', 'The feed has nothing on that.', true), false);
});

test('request bodies: one basic Tavily search, a 9B answer from the results only', () => {
  assert.deepStrictEqual(tavilyBody('q'), { query: 'q', search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false });
  const b = webAnswerBody('m', 'q?', [{ title: 'T', url: 'https://t', content: 'x'.repeat(5000) }]);
  assert.strictEqual(b.reasoning_effort, 'none');
  assert.ok(b.messages[1].content.length < 1700 && b.messages[0].content.includes('ONLY'));
});

test('formatWebReply labels the source, lists only cited links, refuses when unchecked', () => {
  const res = [{ title: 'A', url: 'https://a' }, { title: 'B', url: 'https://b' }, { title: 'C', url: 'https://c' }];
  const ok = formatWebReply('Lima is the capital [2].', res, []);
  assert.ok(ok.startsWith('From the web (not your feed):') && ok.includes('[2] B https://b') && !ok.includes('https://a'));
  assert.ok(formatWebReply('It has 512 tokens [1].', res, ['512']).startsWith('Not in your feed. The web results did not give a clear answer'));
  assert.strictEqual(formatWebReply('x', [], []), 'Not in your feed, and the web search came back empty.');
});

// 2026-10-13, the Dhaka weather follow-up: the wording rule let a non-answer through
test('judgeNeeded: offers and "lacks" phrasing reach the judge; plain answers do not', () => {
  const { judgeNeeded, readJudge, judgeBody } = require('../shared/web-fallback.js');
  assert.ok(judgeNeeded("The feed has one item on your topic: a national AI strategy that mentions weather reports, but it doesn't give specific advice for current weather conditions in Dhaka."));
  assert.ok(judgeNeeded('I checked the feed. Would you like me to search for recent advisories?'));
  assert.ok(!judgeNeeded('Baseten raised $1.5B in Series F (not $2B), led by Altimeter Capital, Conviction and Spark Capital.'));
  assert.ok(!judgeNeeded('ClickHouse bought Langfuse in January 2026.'));
  assert.strictEqual(readJudge('{"answered":false}'), false);
  assert.strictEqual(readJudge('garbage'), null);
  assert.strictEqual(judgeBody('m', 'q', 'r').reasoning_effort, 'none');
});

test('readStandalone keeps the original when the rewrite is empty or runs away', () => {
  const { readStandalone, standaloneBody } = require('../shared/web-fallback.js');
  assert.strictEqual(readStandalone('"Advice for smoky haze weather in Dhaka today"\n', 'q'), 'Advice for smoky haze weather in Dhaka today');
  assert.strictEqual(readStandalone('', "what's your advice during this weather?"), "what's your advice during this weather?");
  assert.strictEqual(readStandalone('x'.repeat(400), 'orig'), 'orig');
  assert.match(standaloneBody('m', 'advice?', 'weather in dhaka?', 'Smoky haze, 26.8°C').messages[1].content, /User: weather in dhaka\?\nBot: Smoky haze/);
});

test('an answer from the bot\'s own memory goes to the web (World Cup, 2026-10-13)', () => {
  const { needsWeb } = require('../shared/web-fallback.js');
  assert.strictEqual(needsWeb({ question: 'Who won the 2022 FIFA World Cup?', reply: 'The 2022 FIFA World Cup winner is Argentina, who defeated France in the final. This information is general knowledge and not found in your current RSS feed.' }).web, true);
  assert.strictEqual(needsWeb({ question: 'Who bought Langfuse?', reply: 'ClickHouse bought Langfuse in January 2026.' }).web, false);
  assert.strictEqual(needsWeb({ question: 'what feeds are you watching?', reply: 'These are not in your feed list yet.' }).web, false);   // about the bot
});

test('an own-knowledge answer that says "not in my feed" goes to the web (2026-10-21)', () => {
  assert.equal(needsWeb({ question: 'Who won the 2022 FIFA World Cup?', reply: 'The 2022 FIFA World Cup winner is Argentina, who defeated France in the final. This information is not in my feed.' }).web, true);
});
