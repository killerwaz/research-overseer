// #13 verifier eval: does the second reading (shared/synth.js verifyBody) catch
// sentences that pin a true fact on the wrong thing, without flagging good ones?
// Base = eval/verify-base.json (hand-checked answers); eval/verify-broken.json
// adds one subtly wrong sentence per broken answer. Runs LM Studio directly.
//   node scripts/eval-verify.js            -> workbench/data/verify-<tag>.json
//   TAG=v2 node scripts/eval-verify.js
//   PER=1 TAG=per node scripts/eval-verify.js   (one call per sentence)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.unsupportedFacts = require('../shared/answer-check.js').unsupportedFacts;
const S = require('../shared/synth.js');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const MODEL = 'qwen/qwen3.5-9b';
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'verify-base.json'), 'utf8'));
const lab = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'verify-broken.json'), 'utf8'));

async function ask(body) {
  const r = await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  const j = await r.json();
  return String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
}

const answerOf = (r) => r.output.replace(/^Your feed has only.*\n/, '').split('\n\nSources:')[0];
const itemsOf = (r) => r.items.map((i) => ({ ...i, evidence: { text: i.evidence } }));
const label = (id, s) => {
  if (lab.real_bad.some((x) => x.id === id && s.includes(x.contains))) return 'bad';
  if (lab.borderline.some((x) => x.id === id && s.includes(x.contains))) return 'borderline';
  return 'good';
};

(async () => {
  const runs = [];
  for (const r of base.filter((r) => r.items.length && r.status !== 'nothing')) {
    runs.push({ id: r.id, kind: 'base', answer: answerOf(r), items: itemsOf(r), brokenSentence: null });
  }
  for (const b of lab.broken) {
    const r = base.find((x) => x.id === b.id);
    const ss = S.sentences(answerOf(r));
    const k = ss.findIndex((s) => s.includes(b.replaces));
    if (k < 0) throw new Error('broken ' + b.id + ': no sentence contains "' + b.replaces + '"');
    ss[k] = b.with;
    runs.push({ id: b.id, kind: 'broken: ' + b.kind, answer: ss.join(' '), items: itemsOf(r), brokenSentence: b.with });
  }
  const out = [];
  let tp = 0, fn = 0, fp = 0, good = 0, secs = 0, unparsed = 0;
  const seenFp = new Set();
  for (const run of runs) {
    const t0 = Date.now();
    // PER=1: one call per cited sentence (only that sentence and its items)
    let v;
    if (process.env.PER === '1') {
      v = { unsupported: [], checked: 0, parsed: true };
      for (const c of S.claimSentences(run.answer, run.items)) {
        const one = S.parseVerify(await ask(S.verifyBody(MODEL, c.s, run.items)), c.s, run.items);
        v.checked++; if (!one.parsed) v.parsed = false; v.unsupported.push(...one.unsupported);
      }
    } else v = S.parseVerify(await ask(S.verifyBody(MODEL, run.answer, run.items)), run.answer, run.items);
    const dt = (Date.now() - t0) / 1000;
    secs += dt;
    if (!v.parsed) unparsed++;
    const flagged = new Set(v.unsupported.map((u) => u.s));
    const rows = [];
    for (const c of S.claimSentences(run.answer, run.items)) {
      const isBroken = c.s === run.brokenSentence;
      const truth = isBroken ? 'bad' : label(run.id, c.s);
      const f = flagged.has(c.s);
      const why = f ? v.unsupported.find((u) => u.s === c.s).why : '';
      rows.push({ s: c.s, truth, flagged: f, why });
      if (truth === 'borderline') continue;
      // base sentences recur in every broken copy of the answer: score each once, from the base run
      if (!isBroken && run.kind !== 'base') { if (f && truth === 'good') seenFp.add(run.id + '|' + c.s + '|copy'); continue; }
      if (truth === 'bad') { if (f) tp++; else fn++; } else { good++; if (f) fp++; }
    }
    const caught = run.brokenSentence ? (flagged.has(run.brokenSentence) ? 'CAUGHT' : 'missed') : '';
    console.log(String(run.id).padStart(2) + ' ' + run.kind.padEnd(42) + ' ' + dt.toFixed(1).padStart(5) + 's  ' + caught.padEnd(7) +
      ' flags: ' + v.unsupported.length + '/' + v.checked + (v.parsed ? '' : ' (UNPARSED)'));
    for (const x of rows.filter((x) => x.flagged || (x.truth === 'bad' && !x.flagged))) {
      console.log('      ' + (x.flagged ? 'flag ' : 'MISS ') + x.truth.padEnd(10) + ' ' + x.s.slice(0, 110) + (x.why ? '\n                 why: ' + x.why : ''));
    }
    out.push({ ...run, items: undefined, rows, secs: dt });
  }
  const summary = { caught: tp + '/' + (tp + fn), false_alarms: fp + '/' + good + ' good sentences (base runs)',
    false_alarms_on_copies: seenFp.size, unparsed, avg_secs: Math.round(secs / runs.length * 10) / 10 };
  console.log(JSON.stringify(summary));
  fs.writeFileSync(path.join(ROOT, 'workbench', 'data', 'verify-' + (process.env.TAG || 'v1') + '.json'), JSON.stringify({ summary, out }, null, 1));
})();
