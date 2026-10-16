const test = require('node:test');
const assert = require('node:assert');
const { sweepOffer, sweepDecision, sweepReply } = require('../shared/sweep-confirm.js');

const OFFER = 'Run a full sweep on products using reverse engineer anything github repo? It hits exa, tavily, brave and rss, takes about 6 minutes and uses search credits.';

test('reads the offered query from the bot message', () => {
  assert.strictEqual(sweepOffer(OFFER), 'products using reverse engineer anything github repo');
  assert.strictEqual(sweepOffer('Run a full sweep on the default beat? It hits exa, tavily, brave and rss.'), '');
  assert.strictEqual(sweepOffer('Here are 5 items on MCP.'), null);
  assert.strictEqual(sweepOffer(null), null);
});

test('yes after an offer runs the sweep, no declines it', () => {
  for (const y of ['yes', 'Yes!', 'ok', 'go ahead', 'sure, do it', 'yep']) assert.strictEqual(sweepDecision(y, OFFER).sweep, 'go', y);
  for (const n of ['no', 'No.', 'nope', 'not now', "don't"]) assert.strictEqual(sweepDecision(n, OFFER).sweep, 'no', n);
  assert.strictEqual(sweepDecision('yes', OFFER).sweep_query, 'products using reverse engineer anything github repo');
});

test('anything else, or no offer, stays with the agent', () => {
  assert.strictEqual(sweepDecision('what about MCP security?', OFFER).sweep, '');
  assert.strictEqual(sweepDecision('yes', 'Here are 5 items on MCP.').sweep, '');
  assert.strictEqual(sweepDecision('nothing on governance?', OFFER).sweep, '');
  assert.strictEqual(sweepDecision('yes but only for exa and also add governance and evaluation frameworks too', OFFER).sweep, '');
});

test('reply reports only what WF-40 returned', () => {
  const d = { sweep: 'go', sweep_query: 'MCP security' };
  const r = sweepReply(d, { sweep: [
    { source: 'Run Exa', status: 'ok', items_created: 3 },
    { source: 'Run Tavily', status: 'ok', items_created: 0 },
    { source: 'Run Brave', error: 'timeout' },
    { source: 'Run RSS', status: 'ok', items_created: 1 }] });
  assert.match(r, /4 new items added \(exa 3, tavily 0, rss 1\)/);
  assert.match(r, /brave failed/);
  assert.match(r, /anything on MCP security/);
  assert.match(sweepReply(d, { sweep: [{ source: 'Run Exa', status: 'ok', items_created: 0 }] }), /nothing new added/);
  assert.match(sweepReply(d, {}), /failed before any source ran/);
  assert.match(sweepReply(d, { status: 'not_run' }), /didn't run/);
  assert.match(sweepReply({ sweep: 'no', sweep_query: 'X' }, null), /no sweep on X\. Nothing was run/);
});
