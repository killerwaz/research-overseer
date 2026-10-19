const test = require('node:test');
const assert = require('node:assert');
const { hasSearchVerb, yesToSearch, searchAllowed } = require('../shared/search-gate.js');

test('bare topics and questions never start a search', () => {
  for (const q of [
    'quantum error correction breakthroughs', // execution 37070, run 102
    'best sourdough starter recipe', // execution 34834
    'Formula One team budget cap',
    "what's happening with MCP security?",
    'anything on Nigerian fintech?',
    'how is the Langfuse deal going',
    'research on agent payments',
    'did you find anything on Harvey?',
    'yes', 'ok'
  ]) assert.strictEqual(searchAllowed(q, ''), false, q);
});

test('an explicit search verb allows it', () => {
  for (const q of [
    'search for quantum error correction breakthroughs',
    'Search MCP security',
    'find me articles on agent payments',
    'can you look up the Harvey funding round',
    'look it up',
    'go get me news on Paystack',
    'dig into AI governance in Kenya',
    'run a search on robotaxi rules',
    'do a web search for M-Pesa outage',
    'start tracking EU AI Act enforcement'
  ]) assert.strictEqual(hasSearchVerb(q), true, q);
});

test('a negated, past or noun use is not a request', () => {
  for (const q of [
    "don't search, just tell me what the feed has on MCP",
    'no need to look it up, what do we have on Harvey?',
    'did you search for Langfuse yesterday?',
    'what did your last search find?',
    'show me the search results from this morning'
  ]) assert.strictEqual(hasSearchVerb(q), false, q);
  // a later, real request still counts
  assert.strictEqual(hasSearchVerb("the last search was thin, search for MCP security again"), true);
});

test('a yes counts only after the bot offered a search', () => {
  const offer = 'The feed has nothing on quantum error correction. Want me to search for it?';
  assert.strictEqual(yesToSearch('yes', offer), true);
  assert.strictEqual(yesToSearch('sure, go ahead', offer), true);
  assert.strictEqual(yesToSearch('yes', 'Here are 5 items on MCP.'), false);
  assert.strictEqual(yesToSearch('no', offer), false);
  assert.strictEqual(yesToSearch('yes but what about the other quantum computing items you showed me earlier today', offer), false);
  assert.strictEqual(searchAllowed('yes', offer), true);
  assert.strictEqual(searchAllowed('yes', ''), false);
});
