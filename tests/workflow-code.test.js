// Every Code node in workflows/ must at least parse. Inlining several shared/
// files into one node can collide on a top-level name: on 2026-10-18
// search-gate.js and sweep-confirm.js both declared YES in 'Big picture?', and
// WF-00 failed on every message until it was fixed. Run after npm run build.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AsyncFunction = (async () => {}).constructor;
const DIR = path.join(__dirname, '..', 'workflows');

test('every Code node in workflows/ parses', () => {
  const bad = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
    const w = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    for (const n of w.nodes || []) {
      const code = n.parameters && n.parameters.jsCode;
      if (!code) continue;
      try { new AsyncFunction(code); } catch (e) { bad.push(f + ' / ' + n.name + ': ' + e.message); }
    }
  }
  assert.deepStrictEqual(bad, []);
});
