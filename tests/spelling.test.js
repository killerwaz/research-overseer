const test = require('node:test');
const assert = require('node:assert');
const S = require('../shared/spelling.js');

test('only real words of 4+ letters are checked, at most 4', () => {
  assert.deepEqual(S.spellWords('Pathoa funding 2026 | AI bkesh'), ['pathoa', 'funding', 'bkesh']);
  assert.deepEqual(S.spellWords('a b c d e f g h i j k l'), []);
  assert.equal(S.spellWords('alpha bravo charlie delta echoo foxtrot').length, 4);
});

test('one-edit neighbours include the usual typos', () => {
  const e = S.edits1('pathoa');
  for (const w of ['pathao', 'patho', 'patthoa', 'pathia']) assert.ok(e.includes(w), w);
  assert.ok(!e.includes('pathoa'));
  assert.ok(S.edits1('husssain').includes('hussain'));
});

test('lookup SQL is one base64 payload', () => {
  const s = S.spellLookupSql(['pathoa']);
  assert.ok(s.includes("decode('"));
  assert.ok(!s.includes('pathoa'));
  assert.equal(S.spellLookupSql([]), 'select null::text as known, null::text as cands');
});

test('questions only for unknown words with neighbours, best-known first', () => {
  const q = S.spellQuestions(['pathoa', 'funding', 'zzzz'], JSON.stringify(['funding']),
    JSON.stringify([{ w: 'pathoa', c: 'path', n: 900 }, { w: 'pathoa', c: 'pathao', n: 2 }, { w: 'funding', c: 'fundina', n: 1 }]));
  assert.deepEqual(q, [{ typed: 'pathoa', cands: ['path', 'pathao'] }]);
});

test('the verdict must be one of the offered words', () => {
  assert.equal(S.readSpell('{"meant":"Pathao"}', ['path', 'pathao']), 'pathao');
  assert.equal(S.readSpell('{"meant":"none"}', ['haystack']), null);
  assert.equal(S.readSpell('{"meant":"paystack"}', ['haystack']), null);
  assert.equal(S.readSpell('garbage', ['x']), null);
});

test('fixes replace whole words only', () => {
  assert.equal(S.applySpelling('who founded pathoa | Pathoa funding', [{ typed: 'pathoa', meant: 'pathao' }]), 'who founded pathao | pathao funding');
  assert.equal(S.applySpelling('pathoas', [{ typed: 'pathoa', meant: 'pathao' }]), 'pathoas');
  assert.equal(S.applySpelling('x', []), 'x');
});

test('judge body is thinking-off JSON', () => {
  const b = S.spellJudgeBody('qwen/qwen3.5-9b', 'anything on pathoa?', 'pathoa', ['pathao']);
  assert.equal(b.reasoning_effort, 'none');
  assert.equal(b.response_format.type, 'json_schema');
  assert.ok(b.messages[1].content.includes('"pathao"'));
});
