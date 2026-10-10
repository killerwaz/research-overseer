const test = require('node:test');
const assert = require('node:assert');
const { parseTopics, parseItemRef, packVectors } = require('../shared/feed-search.js');

test('parseTopics splits on | and ;, trims, drops empties', () => {
  assert.deepStrictEqual(parseTopics(' bangladesh bank | nigeria ai ;  '), ['bangladesh bank', 'nigeria ai']);
  assert.deepStrictEqual(parseTopics(''), []);
  assert.deepStrictEqual(parseTopics(null), []);
});

test('parseTopics removes commas, dedupes case-insensitively, caps at 3', () => {
  assert.deepStrictEqual(parseTopics('nvidia, export control'), ['nvidia export control']);
  assert.deepStrictEqual(parseTopics('a|A|b|c|d'), ['a', 'b', 'c']);
});

test('parseItemRef accepts the numbers people actually type', () => {
  for (const s of ['3', '#3', ' 3 ', 'no. 3', 'item 3', 'number 3']) assert.strictEqual(parseItemRef(s), 3, s);
});

test('parseItemRef rejects non-references', () => {
  for (const s of ['', null, '0', 'the first one', '3a', '1234', 'id 456']) assert.strictEqual(parseItemRef(s), null, String(s));
});

test('packVectors joins by space and |, blanks bad vectors', () => {
  assert.strictEqual(packVectors([[0.1, -2e-3], [1, 2]], 2), '0.1 -0.002|1 2');
  assert.strictEqual(packVectors([[0.1], [NaN]], 3), '0.1||');
  assert.strictEqual(packVectors(null, 2), '|');
  assert.ok(!packVectors([[0.1, 0.2]], 1).includes(','));
});
