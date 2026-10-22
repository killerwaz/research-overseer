// Replaces this instance's literal n8n ids in workflow JSON with the placeholders
// from scripts/ids.js, in place. For hand-maintained workflows and anything
// exported from the n8n UI; build scripts already emit placeholders.
//
//   node scripts/placeholderize.js workflows/wf40-full-sweep.json ...
//   node scripts/placeholderize.js --all
const fs = require('fs');
const path = require('path');
const instance = require('./instance.json');
const { credToken, credNameToken, wfToken } = require('./ids.js');

function placeholderize(wf, inst = instance) {
  const byCredId = new Map(Object.entries(inst.credentials).map(([k, c]) => [c.id, k]));
  for (const node of wf.nodes || []) {
    for (const ref of Object.values(node.credentials || {})) {
      const key = byCredId.get(ref && ref.id);
      if (key) { ref.id = credToken(key); ref.name = credNameToken(key); }
    }
  }
  // Workflow ids sit in executeWorkflow parameters, settings.errorWorkflow and
  // sometimes inside Code-node strings; an id is 16 random characters, so a
  // plain text swap cannot hit anything else.
  let s = JSON.stringify(wf, null, 2);
  for (const [k, id] of Object.entries(inst.workflows)) s = s.split(id).join(wfToken(k));
  for (const [k, c] of Object.entries(inst.credentials)) s = s.split(c.id).join(credToken(k));
  return JSON.parse(s);
}

if (require.main === module) {
  const root = path.join(__dirname, '..', 'workflows');
  let files = process.argv.slice(2);
  if (files[0] === '--all') {
    files = [...fs.readdirSync(root).filter((f) => f.endsWith('.json')).map((f) => path.join(root, f)),
      ...fs.readdirSync(path.join(root, 'tools')).filter((f) => f.endsWith('.json')).map((f) => path.join(root, 'tools', f))];
  }
  if (!files.length) throw new Error('usage: node scripts/placeholderize.js <workflow.json...> | --all');
  for (const f of files) {
    const before = fs.readFileSync(f, 'utf8');
    const after = JSON.stringify(placeholderize(JSON.parse(before)), null, 2) + '\n';
    if (after.replace(/\r/g, '') !== before.replace(/\r/g, '')) { fs.writeFileSync(f, after); console.log('placeholders ->', path.relative(process.cwd(), f)); }
  }
}

module.exports = { placeholderize };
