const test = require('node:test');
const assert = require('node:assert');
const { norm, figures, names, unsupportedFacts } = require('../shared/answer-check.js');

test('norm spells money, units and dashes one way', () => {
  assert.strictEqual(norm('$1.2 billion'), '1200000000');
  assert.strictEqual(norm('$1.2B raised'), '1200000000 raised');
  assert.strictEqual(norm('$400K'), norm('$400,000'));
  assert.strictEqual(norm('40–60 percent'), '40-60%');
  assert.strictEqual(norm('$6,480 per month'), '6480 per month');
});

test('invented figures are caught (the measured failures)', () => {
  const ev = 'The resulting contextual text, usually 50-100 tokens, is prepended to the chunk.';
  assert.deepStrictEqual(unsupportedFacts('Anthropic adds 512 tokens of context to each chunk.', ev, 'How long is the context Anthropic adds?'), ['512']);
  assert.deepStrictEqual(unsupportedFacts('It raised $15M in a seed round.', 'Harvey, with $1.2B raised', 'How much has Harvey raised?'), ['15000000']);
});

test('supported answers pass, in any spelling', () => {
  assert.deepStrictEqual(unsupportedFacts('Harvey has raised $1.2 billion, second only to Cognition.', '| Second most funded startup | Harvey, with $1.2B raised | Cognition, with $2.1B', 'How much has Harvey raised?'), []);
  assert.deepStrictEqual(unsupportedFacts('GPUs run at 40–60% utilization.', 'production GPUs average 40-60% utilization', 'How well utilised are GPUs?'), []);
  assert.deepStrictEqual(unsupportedFacts('ClickHouse bought Langfuse in January 2026.', 'Jan 2026: ClickHouse acquires Langfuse', 'Who bought Langfuse?'), []);
});

test('list numbers, years and the question\'s own figures are not checked', () => {
  assert.deepStrictEqual(figures('1. First item\n2. Second, from 2026', ''), []);
  assert.deepStrictEqual(figures('Gemini 2.5 Flash-Lite costs $0.10', 'Gemini 2.5 Flash-Lite price?'), ['0.10']);
});

test('names: mid-sentence capitals, minus common words and the question', () => {
  assert.deepStrictEqual(names('The feed says it was acquired by Databricks for an undisclosed sum.', 'Who bought Langfuse?'), ['Databricks']);
  assert.deepStrictEqual(names('Would you like me to search Tavily or Exa?', ''), []);
  assert.deepStrictEqual(unsupportedFacts('It was acquired by Snowflake.', 'ClickHouse acquires Langfuse', 'Who bought Langfuse?', { names: true }), ['Snowflake']);
  assert.deepStrictEqual(unsupportedFacts('It was acquired by Snowflake.', 'ClickHouse acquires Langfuse', 'Who bought Langfuse?'), []);  // names are opt-in
});

test('figures match across JSON line breaks (matrix false alarm, 2026-10-12)', () => {
  const ev = JSON.stringify({ evidence: 'investment in AI rose to $581.7\n\nbillion in 2025' });
  assert.deepStrictEqual(unsupportedFacts('Corporate AI investment hit $581.7B.', ev, 'q'), []);
});
