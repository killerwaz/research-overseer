const test = require('node:test');
const assert = require('node:assert');
const { profileFor, TRIAGE_PROFILES, TRIAGE_SCHEMA, TRIAGE_SYSTEM } = require('../shared/triage-config.js');

test('rss reads less than the search sources', () => {
  // Not a speed optimisation — measured, read length does not affect latency.
  // It is a context/quality choice: a feed blurb has nothing after 2500 chars.
  assert.ok(profileFor('rss').content_chars < profileFor('exa').content_chars,
    'rss headlines should not buy the same read as a dense analyst piece');
});

test('a hand-pasted URL gets the deepest read', () => {
  assert.ok(profileFor('manual').content_chars >= profileFor('exa').content_chars);
});

test('unknown, empty and missing sources fall back to default', () => {
  for (const s of ['wat', '', null, undefined, 'RSS ']) {
    assert.ok(profileFor(s), JSON.stringify(s));
  }
  assert.deepEqual(profileFor('wat'), TRIAGE_PROFILES.default);
  assert.deepEqual(profileFor(null), TRIAGE_PROFILES.default);
});

test('source matching is case and whitespace insensitive', () => {
  assert.deepEqual(profileFor(' RSS '), TRIAGE_PROFILES.rss);
  assert.deepEqual(profileFor('Exa'), TRIAGE_PROFILES.exa);
});

test('every profile is complete and sane', () => {
  for (const [name, p] of Object.entries(TRIAGE_PROFILES)) {
    assert.equal(typeof p.model, 'string', name + '.model');
    assert.ok(p.model.length > 0, name + '.model non-empty');
    assert.ok(p.content_chars > 0 && p.content_chars <= 20000, name + '.content_chars');
    // Qwen reasons before emitting JSON; too small a budget strands the answer
    assert.ok(p.max_tokens >= 2000, name + '.max_tokens leaves room to think');
    // LM Studio defaults this model to thinking OFF (for the router); triage
    // must opt back in, and 'none' would silently disable it
    assert.ok(['low', 'medium', 'high'].includes(p.reasoning_effort), name + '.reasoning_effort turns thinking on');
  }
});

test('schema demands both axes and forbids extra fields', () => {
  const s = TRIAGE_SCHEMA.json_schema.schema;
  for (const f of ['summary', 'angle', 'relevance', 'specificity', 'angle_strength', 'tags']) {
    assert.ok(s.required.includes(f), f + ' required');
  }
  assert.equal(s.additionalProperties, false);
  // field order is load-bearing: the angle must be written before it is rated
  const order = Object.keys(s.properties);
  assert.ok(order.indexOf('angle') < order.indexOf('angle_strength'));
  assert.ok(order.indexOf('summary') < order.indexOf('relevance'));
});

test('no novelty axis — recency comes from published_at', () => {
  assert.ok(!('novelty' in TRIAGE_SCHEMA.json_schema.schema.properties));
  assert.ok(!/novelty/i.test(TRIAGE_SYSTEM));
});
