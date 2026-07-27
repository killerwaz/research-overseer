// Validation of the triage model's reply. Inlined into WF-21 by
// scripts/build-wf20.js; covered by tests/triage-validate.test.js.

// Qwen puts chain-of-thought in reasoning_content. When it thinks past the
// token budget, `content` comes back empty with the JSON stranded in there —
// recover it rather than burning a retry.
function parseContent(j) {
  try {
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    let c = msg.content;
    if (!c && msg.reasoning_content) {
      const m = String(msg.reasoning_content).match(/\{[\s\S]*\}/);
      if (m) c = m[0];
    }
    if (!c) return null;
    c = String(c).trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const o = JSON.parse(c);
    const ok = (v) => Number.isInteger(v) && v >= 1 && v <= 5;
    if (o && typeof o.summary === 'string' && ok(o.relevance) &&
        ok(o.specificity) && ok(o.angle_strength) &&
        Array.isArray(o.tags) && o.tags.length >= 1) return o;
    return null;
  } catch (e) { return null; }
}

// Postgres array literal. Tags arrive from a model, so treat them as hostile:
// braces, quotes, commas and backslashes would all corrupt the literal.
function tagsPg(tags) {
  const clean = (tags || []).slice(0, 5)
    .map(t => String(t).toLowerCase().replace(/[{}",\\]/g, '').trim())
    .filter(Boolean);
  return '{' + clean.join(',') + '}';
}

// The six fields every triage returns, skill or no skill.
const BASE_FIELDS = ['summary', 'angle', 'relevance', 'specificity', 'angle_strength', 'tags'];

// A skill widens the response schema, so the reply carries extra properties.
// Split them off into their own object: the fixed columns stay columns, the
// skill's fields go to feed_items.structured as JSON.
function splitStructured(o) {
  if (!o || typeof o !== 'object') return { structured: null };
  const structured = {};
  let any = false;
  for (const k of Object.keys(o)) {
    if (BASE_FIELDS.includes(k)) continue;
    structured[k] = o[k];
    any = true;
  }
  return { structured: any ? structured : null };
}

// Merge a skill's extra properties into the base response schema. strict mode
// requires every declared property to be listed as required, so add both.
function withSkill(baseSchema, extraProps) {
  const s = JSON.parse(JSON.stringify(baseSchema));
  if (!extraProps || typeof extraProps !== 'object') return s;
  const target = s.json_schema.schema;
  for (const [k, v] of Object.entries(extraProps)) {
    if (BASE_FIELDS.includes(k)) continue; // a skill may not redefine the core
    target.properties[k] = v;
    if (!target.required.includes(k)) target.required.push(k);
  }
  return s;
}

module.exports = { parseContent, tagsPg, splitStructured, withSkill, BASE_FIELDS };
