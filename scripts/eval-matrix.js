// Fix 1 trial: runs the end-to-end answer eval (x RUNS) and the 39-case search
// eval under each switch setting, then restores the switches it found.
// Run: node scripts/eval-matrix.js [config ...]     (default: all configs)
// Results: workbench/data/answers-<config>-<run>.json and workbench/data/matrix.json.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNS = Number(process.env.RUNS || 2);
const CONFIGS = {
  base:        'two=false rerank=off mentions=false check=false',
  check:       'two=false rerank=off mentions=false check=true',
  two:         'two=true rerank=off mentions=false check=false',
  'rr-llm':    'two=false rerank=llm mentions=false check=false',
  'rr-model':  'two=false rerank=model mentions=false check=false',
  mentions:    'two=false rerank=off mentions=true check=false',
  'all-llm':   'two=true rerank=llm mentions=true check=true',
  'all-model': 'two=true rerank=model mentions=true check=true',
  // after the answer check was reworked (figures only, JSON line breaks, K/M/B as numbers)
  'check-v2':  'two=false rerank=off mentions=false check=true',
  'all-llm-v2': 'two=true rerank=llm mentions=true check=true'
};
const node = (args, env) => execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
const OUT = path.join(ROOT, 'workbench', 'data', 'matrix.json');
const matrix = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

const before = node(['scripts/fix-switches.js']).trim();
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CONFIGS);
try {
  for (const name of names) {
    node(['scripts/fix-switches.js', ...CONFIGS[name].split(' ')]);
    const runs = [];
    for (let i = 1; i <= RUNS; i++) {
      const t0 = Date.now();
      node(['scripts/eval-answers.js'], { EVAL_LABEL: name + '-' + i });
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'workbench', 'data', 'answers-' + name + '-' + i + '.json'), 'utf8'));
      runs.push({ ...d.summary, missed: d.results.filter((r) => !r.pass).map((r) => r.id), avg_s: Math.round(d.results.reduce((a, r) => a + r.secs, 0) / d.results.length), minutes: Math.round((Date.now() - t0) / 60000) });
    }
    const search = node(['scripts/eval-search.js']).trim().split('\n').slice(-3).join(' | ');
    matrix[name] = { switches: CONFIGS[name], runs, search, at: new Date().toISOString() };
    fs.writeFileSync(OUT, JSON.stringify(matrix, null, 1));
    console.log(name, JSON.stringify(runs), search);
  }
} finally {
  const prev = JSON.parse(before);
  const back = { fix_two_passages: 'two', fix_rerank: 'rerank', fix_mentions: 'mentions', fix_answer_check: 'check' };
  node(['scripts/fix-switches.js', ...Object.entries(back).map(([k, s]) => s + '=' + (prev[k] || (s === 'rerank' ? 'off' : 'false')))]);
}
