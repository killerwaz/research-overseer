const test = require('node:test');
const assert = require('node:assert');
const { twinAction, hostOf, sameStoryBody, parseSame } = require('../shared/dedupe.js');

test('twinAction: merge above 0.87, ask the 9B in 0.80-0.87, new below', () => {
  assert.strictEqual(twinAction(0.945), 'merge');   // Natural $30M, two outlets
  assert.strictEqual(twinAction(0.87), 'merge');
  assert.strictEqual(twinAction(0.864), 'check');   // ttok 1.0 vs 0.4 — the 9B says no
  assert.strictEqual(twinAction(0.80), 'check');
  assert.strictEqual(twinAction(0.799), 'new');
  for (const x of [null, undefined, '', 'abc', NaN]) assert.strictEqual(twinAction(x), 'new', String(x));
  assert.strictEqual(twinAction('0.9'), 'merge');    // Postgres numerics arrive as strings
});

test('hostOf works without URL', () => {
  assert.strictEqual(hostOf('https://www.TechCrunch.com/2026/x?y=1'), 'techcrunch.com');
  assert.strictEqual(hostOf('ftp://x'), '');
  assert.strictEqual(hostOf(''), '');
});

test('sameStoryBody: thinking off, schema enforced, both sides with source', () => {
  const b = sameStoryBody({ title: 'A t', url: 'https://a.com/1', summary: 's'.repeat(900) }, { title: 'B t', url: 'https://b.org/2', summary: 'x' });
  assert.strictEqual(b.reasoning_effort, 'none');
  assert.strictEqual(b.response_format.json_schema.name, 'same_story');
  assert.match(b.messages[1].content, /^A: A t \(a\.com\)\n/);
  assert.match(b.messages[1].content, /\n\nB: B t \(b\.org\)\nx$/);
  assert.ok(b.messages[1].content.length < 900);
});

test('parseSame: content, stranded reasoning, junk', () => {
  assert.strictEqual(parseSame({ content: '{"same": true}' }), true);
  assert.strictEqual(parseSame({ content: '', reasoning_content: 'hmm {"same": false}' }), false);
  assert.strictEqual(parseSame({ content: 'yes' }), null);
  assert.strictEqual(parseSame({ content: '{"same": "yes"}' }), null);
  assert.strictEqual(parseSame(null), null);
});
