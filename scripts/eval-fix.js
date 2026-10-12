// #13: what happens to a flagged sentence. Takes every sentence the per-sentence
// checker flagged (workbench/data/verify-per.json) and runs the chain:
// fix with the checker's reason -> re-check the fix -> else quote the source ->
// else drop. Prints each result for the hand check.
//   node scripts/eval-fix.js   -> workbench/data/fix-chain.json
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.unsupportedFacts = require('../shared/answer-check.js').unsupportedFacts;
const S = require('../shared/synth.js');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const MODEL = 'qwen/qwen3.5-9b';
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'verify-base.json'), 'utf8'));
const per = JSON.parse(fs.readFileSync(path.join(ROOT, 'workbench', 'data', 'verify-per.json'), 'utf8'));

async function ask(body) {
  const r = await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  const j = await r.json();
  return String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
}

(async () => {
  const seen = new Set();
  const flagged = [];
  for (const o of per.out) for (const r of o.rows) {
    if (!r.flagged || seen.has(r.s)) continue;
    seen.add(r.s);
    flagged.push({ id: o.id, s: r.s, why: r.why, truth: r.truth });
  }
  const out = [];
  const tally = {};
  for (const f of flagged) {
    const items = base.find((r) => r.id === f.id).items.map((i) => ({ ...i, evidence: { text: i.evidence } }));
    const t0 = Date.now();
    let result = 'dropped', text = '';
    const fix = S.readFix(await ask(S.fixBody(MODEL, f.s, f.why, items)), f.s);
    if (fix) {
      const v = S.parseVerify(await ask(S.verifyBody(MODEL, fix, items)), fix, items);
      if (v.parsed && !v.unsupported.length) { result = 'fixed'; text = fix; }
      else { text = fix; result = 'fix failed re-check'; }
    }
    if (result !== 'fixed') {
      const q = S.bestQuote(f.s, items);
      if (q) { result = result === 'fix failed re-check' ? 'quoted (fix failed)' : 'quoted (no fix)'; text = q; }
      else { result = 'dropped'; text = ''; }
    }
    const secs = (Date.now() - t0) / 1000;
    tally[result] = (tally[result] || 0) + 1;
    out.push({ ...f, result, text, secs });
    console.log('\nQ' + f.id + ' [' + f.truth + '] ' + result + ' (' + secs.toFixed(1) + ' s)\n  was: ' + f.s + '\n  why: ' + f.why.slice(0, 160) + '\n  now: ' + (text || '(dropped)'));
  }
  const avg = out.reduce((a, b) => a + b.secs, 0) / out.length;
  console.log('\n' + JSON.stringify({ flagged: out.length, ...tally, avg_secs: Math.round(avg * 10) / 10 }));
  fs.writeFileSync(path.join(ROOT, 'workbench', 'data', 'fix-chain.json'), JSON.stringify(out, null, 1));
})();
