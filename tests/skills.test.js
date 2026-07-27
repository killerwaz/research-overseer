const test = require('node:test');
const assert = require('node:assert');
const { splitStructured, withSkill, BASE_FIELDS } = require('../shared/triage-validate.js');
const { TRIAGE_SCHEMA } = require('../shared/triage-config.js');

const base = { summary: 's', angle: 'a', relevance: 4, specificity: 4, angle_strength: 3, tags: ['x'] };

test('no skill means no structured payload', () => {
  assert.equal(splitStructured(base).structured, null);
});

test('skill fields are split out, core fields are not', () => {
  const withExtra = Object.assign({}, base, { company: 'Acme', amount_usd: 12000000, investors: ['a16z'] });
  const { structured } = splitStructured(withExtra);
  assert.deepEqual(structured, { company: 'Acme', amount_usd: 12000000, investors: ['a16z'] });
  for (const f of BASE_FIELDS) assert.ok(!(f in structured), f + ' must stay a column');
});

test('nulls from a non-matching article still count as extraction', () => {
  // "this article is not about a raise" is a real answer worth storing
  const { structured } = splitStructured(Object.assign({}, base, { company: null, amount_usd: null }));
  assert.deepEqual(structured, { company: null, amount_usd: null });
});

test('withSkill adds properties and marks them required', () => {
  const s = withSkill(TRIAGE_SCHEMA, { company: { type: ['string', 'null'] } });
  const sch = s.json_schema.schema;
  assert.ok('company' in sch.properties);
  assert.ok(sch.required.includes('company'), 'strict mode requires every property listed');
  assert.equal(sch.additionalProperties, false);
});

test('withSkill does not mutate the shared base schema', () => {
  const before = JSON.stringify(TRIAGE_SCHEMA);
  withSkill(TRIAGE_SCHEMA, { company: { type: 'string' } });
  assert.equal(JSON.stringify(TRIAGE_SCHEMA), before, 'base schema leaked a skill field');
});

test('a skill cannot redefine or drop a core field', () => {
  const s = withSkill(TRIAGE_SCHEMA, { summary: { type: 'number' }, relevance: { type: 'string' } });
  assert.equal(s.json_schema.schema.properties.summary.type, 'string');
  assert.equal(s.json_schema.schema.properties.relevance.type, 'integer');
});

test('missing or malformed skill schema falls back to base', () => {
  for (const bad of [null, undefined, 'nonsense', 42]) {
    const s = withSkill(TRIAGE_SCHEMA, bad);
    assert.deepEqual(Object.keys(s.json_schema.schema.properties), Object.keys(TRIAGE_SCHEMA.json_schema.schema.properties));
  }
});
