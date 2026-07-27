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

module.exports = { parseContent, tagsPg };
