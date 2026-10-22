const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const instance = require('../scripts/instance.json');
const { PLACEHOLDERS, idSubstitutions } = require('../scripts/ids.js');
const { placeholderize } = require('../scripts/placeholderize.js');

const root = path.join(__dirname, '..', 'workflows');
const files = [...fs.readdirSync(root).filter((f) => f.endsWith('.json')),
  ...fs.readdirSync(path.join(root, 'tools')).filter((f) => f.endsWith('.json')).map((f) => 'tools/' + f)];
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('committed workflows name no instance id (code review finding 1)', () => {
  const ids = [...Object.values(instance.credentials).map((c) => c.id), ...Object.values(instance.workflows)];
  for (const f of files) {
    const hits = ids.filter((id) => read(f).includes(id));
    assert.deepStrictEqual(hits, [], `${f} carries literal ids — run node scripts/placeholderize.js ${'workflows/' + f}`);
  }
});

test('every credential reference is a placeholder, listed or not', () => {
  // Exa and Brave were missing from instance.json, so the literal-id check above could not see them
  for (const f of files) {
    for (const n of JSON.parse(read(f)).nodes) {
      for (const [type, c] of Object.entries(n.credentials || {})) {
        assert.match(c.id, /^__CRED_[A-Z0-9_]+__$/, `${f} "${n.name}" ${type}: ${c.id} — add it to instance.json, then placeholderize`);
      }
    }
  }
});

test('every id placeholder in workflows/ is one deploy.js can fill', () => {
  const known = idSubstitutions();
  for (const f of files) {
    for (const t of read(f).match(/__(?:CRED|CREDNAME|WF|WFID)[A-Z0-9_]*__/g) || []) {
      assert.ok(t in known, `${f}: ${t} has no value in instance.json`);
    }
  }
});

test('a fresh instance gets its own ids everywhere', () => {
  const fresh = { credentials: { postgres: { id: 'NEWPG', name: 'my pg' } }, workflows: { 'wf40-full-sweep': 'NEW40', 'tools/zz-sql-runner': 'NEWSQL' } };
  const subs = idSubstitutions(fresh);
  assert.strictEqual(subs.__CRED_POSTGRES__, 'NEWPG');
  assert.strictEqual(subs.__CREDNAME_POSTGRES__, 'my pg');
  assert.strictEqual(subs.__WF40__, 'NEW40');
  assert.strictEqual(subs.__WF40_ID__, 'NEW40');
  assert.strictEqual(subs.__WFID_TOOLS_ZZ_SQL_RUNNER__, 'NEWSQL');
  assert.deepStrictEqual(PLACEHOLDERS.credentials.postgres, { id: '__CRED_POSTGRES__', name: '__CREDNAME_POSTGRES__' });
});

test('placeholderize turns an n8n export into placeholders', () => {
  const pg = instance.credentials.postgres;
  const wf = { nodes: [{ credentials: { postgres: { id: pg.id, name: 'renamed in the UI' } },
    parameters: { workflowId: { value: instance.workflows['wf21-triage-one'] } } }],
    settings: { errorWorkflow: instance.workflows['wf99-error-workflow'] } };
  const out = placeholderize(wf);
  assert.deepStrictEqual(out.nodes[0].credentials.postgres, { id: '__CRED_POSTGRES__', name: '__CREDNAME_POSTGRES__' });
  assert.strictEqual(out.nodes[0].parameters.workflowId.value, '__WF21__');
  assert.strictEqual(out.settings.errorWorkflow, '__WF99__');
});
