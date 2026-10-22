// Placeholders for every instance-local n8n id (code review finding 1, 2026-10-22).
//
// Build scripts and the committed workflow JSON carry these tokens, never a real
// credential or workflow id; scripts/deploy.js fills them in from
// scripts/instance.json on the way out. So a fresh install edits instance.json
// and deploys, and every reference follows — before, the JSON kept the original
// instance's ids (25 of 26 bodies) and WF-40's four sub-workflow calls had no
// builder to regenerate them.
//
// Numbered workflows keep the existing __WF43__ form; tools get __WFID_<KEY>__.
// Hand-edited JSON (exported from n8n) is converted with scripts/placeholderize.js;
// tests/ids.test.js fails if a literal id is committed.
const instance = require('./instance.json');

const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
const credToken = (key) => `__CRED_${slug(key)}__`;
const credNameToken = (key) => `__CREDNAME_${slug(key)}__`;
function wfToken(key) {
  const num = (key.match(/^wf(\d+)/) || [])[1];
  return num ? `__WF${num}__` : `__WFID_${slug(key)}__`;
}

// Same shape as instance.json, so a build script swaps one require for the other.
const PLACEHOLDERS = {
  credentials: Object.fromEntries(Object.keys(instance.credentials)
    .map((k) => [k, { id: credToken(k), name: credNameToken(k) }])),
  workflows: Object.fromEntries(Object.keys(instance.workflows).map((k) => [k, wfToken(k)]))
};

// token -> real value, for deploy.js. `inst` defaults to this checkout's instance.json.
function idSubstitutions(inst = instance) {
  const out = {};
  for (const [k, c] of Object.entries(inst.credentials)) {
    out[credToken(k)] = c.id;
    out[credNameToken(k)] = c.name;
  }
  for (const [k, id] of Object.entries(inst.workflows)) {
    out[wfToken(k)] = id;
    const num = (k.match(/^wf(\d+)/) || [])[1];
    if (num) out[`__WF${num}_ID__`] = id;   // older spelling, still in a few nodes
  }
  return out;
}

module.exports = { PLACEHOLDERS, idSubstitutions, credToken, credNameToken, wfToken };
