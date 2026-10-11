const test = require('node:test');
const assert = require('node:assert');
const { EMBED_DIM, QUERY_INSTRUCT, docText, queryText, vectorLiteral } = require('../shared/embed.js');

test('docText joins title, summary, angle, tags', () => {
  const t = docText({ title: 'M-Pesa grows', summary: 'Kenya adoption up.', angle: 'Fintech', tags: ['fintech', 'kenya'] });
  assert.strictEqual(t, 'M-Pesa grows\nKenya adoption up.\nFintech\nTags: fintech, kenya');
});

test('docText skips empty fields and survives nulls', () => {
  assert.strictEqual(docText({ title: null, summary: 'S', angle: '', tags: null }), 'S');
  assert.strictEqual(docText(null), '');
});

test('queryText wraps the query in the Qwen3 instruction', () => {
  assert.strictEqual(queryText('  mobile money '), 'Instruct: ' + QUERY_INSTRUCT + '\nQuery: mobile money');
});

test('vectorLiteral formats a valid vector', () => {
  const v = new Array(EMBED_DIM).fill(0.5);
  const lit = vectorLiteral(v);
  assert.ok(lit.startsWith('[0.5,0.5') && lit.endsWith(']'));
});

test('vectorLiteral rejects wrong length and non-numbers', () => {
  assert.throws(() => vectorLiteral([1, 2, 3]), /1024/);
  const bad = new Array(EMBED_DIM).fill(0); bad[5] = "1); drop table feed_items; --";
  assert.throws(() => vectorLiteral(bad), /non-finite/);
  const nan = new Array(EMBED_DIM).fill(0); nan[0] = NaN;
  assert.throws(() => vectorLiteral(nan), /non-finite/);
});
