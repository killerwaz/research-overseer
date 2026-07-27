const test = require('node:test');
const assert = require('node:assert');
const { parseContent, tagsPg } = require('../shared/triage-validate.js');

const good = {
  summary: 'A summary.', angle: 'An angle.',
  relevance: 5, specificity: 4, angle_strength: 3, tags: ['ai-agents']
};
const reply = (content, extra = {}) => ({ choices: [{ message: Object.assign({ content }, extra) }] });

test('accepts a well-formed reply', () => {
  assert.deepEqual(parseContent(reply(JSON.stringify(good))), good);
});

test('tolerates code fences around the JSON', () => {
  assert.deepEqual(parseContent(reply('```json\n' + JSON.stringify(good) + '\n```')), good);
});

// Regression: Qwen strands the JSON in reasoning_content when it thinks past
// the token budget, leaving content empty. This cost a retry per occurrence.
test('recovers JSON stranded in reasoning_content', () => {
  const r = reply('', { reasoning_content: 'Thinking... ' + JSON.stringify(good) + ' done' });
  assert.deepEqual(parseContent(r), good);
});

test('rejects missing or out-of-range axes', () => {
  const drop = (k) => { const o = Object.assign({}, good); delete o[k]; return o; };
  for (const k of ['summary', 'relevance', 'specificity', 'angle_strength', 'tags']) {
    assert.equal(parseContent(reply(JSON.stringify(drop(k)))), null, 'missing ' + k);
  }
  for (const v of [0, 6, 2.5, '4']) {
    assert.equal(parseContent(reply(JSON.stringify(Object.assign({}, good, { specificity: v })))), null,
      'specificity ' + JSON.stringify(v));
  }
});

test('rejects empty tags, garbage and empty replies', () => {
  assert.equal(parseContent(reply(JSON.stringify(Object.assign({}, good, { tags: [] })))), null);
  assert.equal(parseContent(reply('not json at all')), null);
  assert.equal(parseContent(reply('')), null);
  assert.equal(parseContent({}), null);
  assert.equal(parseContent({ error: 'timeout of 120000ms exceeded' }), null);
});

test('angle may be null — that is a real triage outcome', () => {
  const o = Object.assign({}, good, { angle: null });
  assert.deepEqual(parseContent(reply(JSON.stringify(o))), o);
});

test('tags become a safe Postgres array literal', () => {
  assert.equal(tagsPg(['AI-Agents', 'Inference-Cost']), '{ai-agents,inference-cost}');
  assert.equal(tagsPg([]), '{}');
  assert.equal(tagsPg(null), '{}');
});

test('hostile tags cannot break out of the array literal', () => {
  assert.equal(tagsPg(['a"b', 'c,d', 'e}f', 'g\\h']), '{ab,cd,ef,gh}');
});

test('caps at five tags', () => {
  assert.equal(tagsPg(['a', 'b', 'c', 'd', 'e', 'f', 'g']), '{a,b,c,d,e}');
});
