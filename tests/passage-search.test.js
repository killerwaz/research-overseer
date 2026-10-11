const test = require('node:test');
const assert = require('node:assert');
const { passageCtes, evidenceSnippet, PASSAGE_SIM, KW_COVER } = require('../shared/passage-search.js');

test('passageCtes bakes in the shipped cutoffs and only accepts numbers', () => {
  const s = passageCtes();
  assert.ok(s.includes('>= ' + PASSAGE_SIM) && s.includes('>= ' + KW_COVER));
  assert.ok(s.startsWith('boiler as (') && /\bpdoc as \(/.test(s));
  assert.ok(s.includes('text_md5 not in (select text_md5 from boiler)'));
  assert.throws(() => passageCtes({ sim: '0.5; drop table x' }));
  assert.ok(passageCtes({ sim: -1, cover: 0 }).includes('>= -1'));
});

test('keyword lexemes are cast, not re-parsed (hyphenated names survive)', () => {
  // to_tsquery would split 'flash-lit' into flash & lit and never match "Flash-Lite".
  assert.ok(passageCtes().includes('quote_literal(ql.lex)::tsquery'));
  assert.ok(!passageCtes().includes('to_tsquery('));
});

test('evidenceSnippet centres on the first keyword it finds', () => {
  const text = 'Intro words. '.repeat(60) + 'Jan 2026: ClickHouse acquires Langfuse (20K GitHub stars). ' + 'Outro words. '.repeat(60);
  const s = evidenceSnippet(text, ['Langfuse'], 200);
  assert.ok(s.includes('ClickHouse acquires Langfuse'));
  assert.ok(s.length <= 202 && s.startsWith('…') && s.endsWith('…'));
});

test('evidenceSnippet: short text is returned whole, no keyword falls back to the start', () => {
  assert.strictEqual(evidenceSnippet('short  text', ['x'], 200), 'short text');
  const long = 'a'.repeat(1000);
  assert.strictEqual(evidenceSnippet(long, ['zzz'], 200), 'a'.repeat(200) + '…');
  assert.strictEqual(evidenceSnippet(null, [], 200), '');
});
