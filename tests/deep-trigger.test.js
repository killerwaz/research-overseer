const test = require('node:test');
const assert = require('node:assert');
const { deepAsk } = require('../shared/deep-trigger.js');

test('"deep search" anywhere starts a job with the rest as the question', () => {
  assert.deepStrictEqual(deepAsk('deep search: top 5 products built with the reverse engineer anything repo'),
    { go: true, question: 'top 5 products built with the reverse engineer anything repo' });
  assert.deepStrictEqual(deepAsk('Do a deep research on which south asian governments signed deals with openai'),
    { go: true, question: 'which south asian governments signed deals with openai' });
  assert.deepStrictEqual(deepAsk('is the mit 95% study legit? deep dive please'),
    { go: true, question: 'is the mit 95% study legit?' });
  assert.strictEqual(deepAsk('deep-search groq vs cerebras for gpt-oss-120b').question, 'groq vs cerebras for gpt-oss-120b');
});

test('"deep search on that" uses the previous message', () => {
  const prev = 'i want the top 5 latest products that have used the reverse engineer anything repo from github';
  assert.deepStrictEqual(deepAsk('do a deep search on that', prev), { go: true, question: prev });
  assert.deepStrictEqual(deepAsk('deep search', prev), { go: true, question: prev });
  assert.deepStrictEqual(deepAsk('deep research it please', prev), { go: true, question: prev });
  assert.deepStrictEqual(deepAsk('deep search', ''), { go: true, question: '' });
});

test('everything else stays with the bot', () => {
  for (const t of ['anything on MCP security?', 'dig into agent evaluation', 'search for groq pricing', 'do a deeper search and try',
    'the deep learning research from deepmind', 'what is deep research in chatgpt?']) assert.strictEqual(deepAsk(t).go, false, t);
});
