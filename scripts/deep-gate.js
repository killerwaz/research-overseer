// Deploy gate for wf46-deep-research: runs every trap in scripts/deep-traps.json through
// the pipeline (scripts/deep-research.js, cached) and fails if any reply repeats a myth.
// Usage:
//   node scripts/deep-gate.js                 run all traps, exit 1 on any failure
//   node scripts/deep-gate.js --check <dir>   only check replies already in <dir>/<id>.md
// scripts/deploy.js runs it before deploying wf46 (skip with --skip-gate).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkTrap } = require('../shared/deep-traps.js');

const ROOT = path.join(__dirname, '..');
const TRAPS = path.join(__dirname, 'deep-traps.json');

function gate(dir) {
  const { cases } = JSON.parse(fs.readFileSync(TRAPS, 'utf8'));
  let failed = 0;
  for (const c of cases) {
    const f = path.join(dir, c.id + '.md');
    const fails = fs.existsSync(f) ? checkTrap(fs.readFileSync(f, 'utf8'), c) : ['no reply (the run failed)'];
    console.log(`${fails.length ? 'FAIL' : 'pass'} ${c.id}`);
    for (const x of fails) console.log('     ' + x);
    if (fails.length) failed++;
  }
  console.log(`${cases.length - failed}/${cases.length} traps passed`);
  return failed === 0;
}

function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--check');
  let dir;
  if (ci >= 0) dir = path.resolve(args[ci + 1]);
  else {
    dir = path.join(ROOT, 'eval', 'deep-pipeline', 'gate-' + new Date().toISOString().replace(/[:.]/g, '-'));
    console.log(`deep gate: running ${TRAPS} -> ${dir} (several minutes per trap on a cold cache)`);
    const r = spawnSync(process.execPath, [path.join(__dirname, 'deep-research.js'), '--cases', TRAPS, '--out', dir],
      { stdio: 'inherit', cwd: ROOT });
    if (r.status !== 0) { console.log('deep gate: the pipeline run failed'); return false; }
  }
  return gate(dir);
}

if (require.main === module) process.exit(main() ? 0 : 1);
module.exports = { gate, main };
