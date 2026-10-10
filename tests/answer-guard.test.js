const test = require('node:test');
const assert = require('node:assert');
const { needsFreshLookup, prefetchFor } = require('../shared/answer-guard.js');

test('prefetchFor resolves item follow-ups to a number', () => {
  assert.deepStrictEqual(prefetchFor('tell me more about the first one'), { item: '1', tag: '' });
  assert.deepStrictEqual(prefetchFor('what about #3'), { item: '3', tag: '' });
  assert.deepStrictEqual(prefetchFor('2. especially the funding part'), { item: '2', tag: '' });
  assert.deepStrictEqual(prefetchFor('open the second article'), { item: '2', tag: '' });
});

test('prefetchFor strips the lead-in and keeps the topic', () => {
  assert.strictEqual(prefetchFor('anything on bangladesh bank?').tag, 'bangladesh bank');
  assert.strictEqual(prefetchFor('anything on the cricket world cup?').tag, 'cricket world cup');
  assert.strictEqual(prefetchFor('what about Nigeria AI policy').tag, 'Nigeria AI policy');
  assert.strictEqual(prefetchFor('hey, any news on export controls?').tag, 'export controls');
  assert.strictEqual(prefetchFor('did it work?').item, '');
});

const g = (question, reply, toolsUsed = []) => needsFreshLookup({ question, reply, toolsUsed }).retry;

test('feed claims with no tool call are redone (the measured failures)', () => {
  // copied from memory
  assert.equal(g('anything on nvidia export controls?', 'Yes, there are several recent items on Nvidia export controls. Here are the top findings:'), true);
  // invented after memory was tidied
  assert.equal(g('anything on nvidia export controls?', 'The feed has nothing on Nvidia export controls.'), true);
  assert.equal(g('anything on nvidia export controls?', 'I checked the feeds and found nothing on Nvidia export controls.'), true);
  assert.equal(g('anything on nvidia export controls?', 'No recent items on Nvidia export controls in the last week.'), true);
});

test('feed questions and item follow-ups need a tool whatever the reply says (live 2026-10-10)', () => {
  assert.equal(g('anything on bangladesh bank?', 'Nothing scored 7+ from today on Bangladesh Bank yet. Want me to check the archive?'), true);
  assert.equal(g('tell me more about the first one', 'The first item from the latest run (run 64) is about GPU rental pricing.'), true);
  assert.equal(g('what about #3', 'That one covers the AI directive.'), true);
  assert.equal(g('2. especially the funding part', 'It raised $30M.'), true);
  assert.equal(g('anything on bangladesh bank?', 'Found 12 items.', ['query_feed']), false);
  assert.equal(g('tell me more about the first one', 'Item #1 is the regulatory directory.', ['get_item']), false);
});

test('claiming to have started something without a tool is redone', () => {
  assert.equal(g('go wide on GPU rental pricing', 'Running a wide sweep on GPU rental pricing. This will take about six minutes.'), true);
});

test('the same claims are fine when a tool actually ran', () => {
  assert.equal(g('anything on nvidia export controls?', 'Found 5 items on Nvidia export controls.', ['query_feed']), false);
});

test('sources and runs answered from per-message context are left alone', () => {
  assert.equal(g('which sources do you follow?', "I'm watching these feeds: Simon Willison, Latent Space, LangChain Blog."), false);
  assert.equal(g('what are you subscribed to?', 'These feeds: Simon Willison, n8n Blog.'), false);
  assert.equal(g('did the last run work?', 'Run 58 (exa) failed, 0 items. Run 56 found 10 items.'), false);
  assert.equal(g('did anything break recently?', 'Yes, run 58 failed; run 57 failed too.'), false);
});

test('replies that claim nothing about the feed pass', () => {
  assert.equal(g('go wide on GPU rental pricing', 'Run a full sweep on GPU rental pricing? It hits exa, tavily, brave and rss and uses search credits.'), false);
  assert.equal(g('run a sweep every day at 8am', 'Scheduling is switched off. Want me to run a sweep now?'), false);
  assert.equal(g('actually no, cancel that', "Understood. I won't run the full sweep."), false);
  assert.equal(g('thanks', 'Any time.'), false);
});

test('a runs question whose reply talks findings without a run number is still redone', () => {
  assert.equal(g('did it work?', 'Yes, it found several articles on GPU pricing.'), true);
});

test('empty replies are redone', () => {
  assert.equal(g('catch me up', ''), true);
});
