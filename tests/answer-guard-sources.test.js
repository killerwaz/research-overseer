const test = require('node:test');
const assert = require('node:assert');
const { needsFreshLookup, sourceQualityQ, scorecardDays } = require('../shared/answer-guard.js');

// Measured 2026-10-12: the 9B answered every one of the first four from the run
// list in its context, without the scorecard.
const QUALITY = [
  'how are my sources doing?', 'which of my feeds are actually useful?', 'where do my best items come from?',
  'is exa worth paying for compared to brave?', 'which rss feeds are worth keeping, last 30 days?',
  'how did my feeds do this week?',
];
const NOT = [
  'what feeds are you watching?', 'did the last run work?', 'anything on bangladesh bank?',
  'add this feed https://x.com/rss', 'stop following latent space', 'what is the best open source model?',
  'show me the best items this week', 'anything good from simon willison?', 'search brave for AI policy news',
  'how do I add a feed?',
];

test('sourceQualityQ: quality questions yes, list/add/remove/topic questions no', () => {
  for (const q of QUALITY) assert.ok(sourceQualityQ(q), q);
  for (const q of NOT) assert.ok(!sourceQualityQ(q), q);
});

test('scorecardDays reads the window from the question', () => {
  assert.strictEqual(scorecardDays('worth keeping, last 30 days?'), '30');
  assert.strictEqual(scorecardDays('how did my feeds do this week?'), '7');
  assert.strictEqual(scorecardDays('past month'), '30');
  assert.strictEqual(scorecardDays('how are my sources doing?'), '');
});

test('guard: a quality question needs manage_sources, even if another tool ran', () => {
  const q = 'how are my sources doing?';
  assert.strictEqual(needsFreshLookup({ question: q, reply: 'Runs are fine.', toolsUsed: [] }).retry, true);
  assert.strictEqual(needsFreshLookup({ question: q, reply: 'x', toolsUsed: ['run_status'] }).retry, true);
  assert.strictEqual(needsFreshLookup({ question: q, reply: 'x', toolsUsed: ['manage_sources'] }).retry, false);
  assert.strictEqual(needsFreshLookup({ question: 'what feeds are you watching?', reply: 'Simon Willison, n8n Blog', toolsUsed: [] }).retry, false);
});
