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

const { userFilters } = require('../shared/feed-search.js');

test('userFilters drops filters the message never asked for', () => {
  const f = { min_score: '5', max_age_days: '7', since: '' };
  const r = userFilters('Who bought Langfuse?', f);
  assert.deepStrictEqual([r.min_score, r.max_age_days, r.dropped], ['', '', ['min_score', 'max_age_days']]);
  assert.strictEqual(userFilters('anything good this week?', f).min_score, '5');
  assert.strictEqual(userFilters('anything good this week?', f).max_age_days, '7');
  assert.strictEqual(userFilters('show me the best agent stuff', f).max_age_days, '');
  assert.strictEqual(userFilters('what came in today', { since: '2026-10-12T00:00:00+06:00' }).since, '2026-10-12T00:00:00+06:00');
});

test('userFilters passes everything through when there is no message', () => {
  assert.deepStrictEqual(userFilters('', { min_score: '7', max_age_days: '3', since: 'x' }),
    { min_score: '7', max_age_days: '3', since: 'x', dropped: [] });
});
