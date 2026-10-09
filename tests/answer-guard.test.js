const test = require('node:test');
const assert = require('node:assert');
const { needsFreshLookup } = require('../shared/answer-guard.js');

const g = (question, reply, toolsUsed = []) => needsFreshLookup({ question, reply, toolsUsed }).retry;

test('feed claims with no tool call are redone (the measured failures)', () => {
  // copied from memory
  assert.equal(g('anything on nvidia export controls?', 'Yes, there are several recent items on Nvidia export controls. Here are the top findings:'), true);
  // invented after memory was tidied
  assert.equal(g('anything on nvidia export controls?', 'The feed has nothing on Nvidia export controls.'), true);
  assert.equal(g('anything on nvidia export controls?', 'I checked the feeds and found nothing on Nvidia export controls.'), true);
  assert.equal(g('anything on nvidia export controls?', 'No recent items on Nvidia export controls in the last week.'), true);
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
