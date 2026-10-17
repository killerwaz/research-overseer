// Does the fit check (shared/feed-fit.js) tell "these items answer the question"
// from "these items only share words with it"?
// Run: node scripts/eval-fit.js [--verbose] [--runs=N] [ids...]
// Cases: eval/fit-eval.json (local only). Each case = a question, the tag the
// router would pass, and want = true (the shown items answer it) / false (they
// only share words with it). Items come from the LIVE WF-31 (readtools harness),
// the top 8, as the router lists them; the 9B judges them with the shipping
// prompts: one fit call, or for relation questions ("products built with X")
// one named-and-quoted call per item. Read-only.
const fs = require('fs');
const path = require('path');
const F = require('../shared/feed-fit.js');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const HARNESS = 'http://localhost:5678/webhook/overseer-readtools-harness-' + env.ZZ_WEBHOOK_SECRET;
const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'fit-eval.json'), 'utf8'));
const verbose = process.argv.includes('--verbose');
const runs = Number((process.argv.find((a) => a.startsWith('--runs=')) || '--runs=1').split('=')[1]);
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

async function feed(c) {
  const r = await fetch(HARNESS, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'query_feed', tag: c.tag || c.q, user_text: c.q, limit: '8', chat_id: 999000001 }) });
  return ((await r.json()).items || []).slice(0, 8).map((i) => ({ n: i.n, title: i.title, summary: i.summary || '', evidence: F.evidenceText(i.evidence) }));
}
async function llm(body) {
  const r = await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  return j.choices && j.choices[0].message.content;
}
async function judge(q, items) {
  const t0 = Date.now();
  if (F.relationQ(q)) {
    const names = [];
    for (const i of items) { const raw = await llm(F.namedBody('qwen/qwen3.5-9b', q, i)); const n = F.readNamed(raw, i, q); if (n) names.push(i.n + ':' + n + (verbose ? ' «' + (JSON.parse(raw).quote || '').slice(0, 160) + '»' : '')); }
    return { got: names.length > 0, detail: 'relation, named: ' + (names.join('; ') || 'none'), secs: (Date.now() - t0) / 1000 };
  }
  const v = F.readFit(await llm(F.fitBody('qwen/qwen3.5-9b', q, items)));
  return { got: v ? v.answers : true, detail: v ? `yes ${v.yes} partly ${v.partly} no ${v.no}` + (v.gap ? ' | gap: ' + v.gap : '') : 'unreadable', secs: (Date.now() - t0) / 1000 };
}

(async () => {
  const tally = { true: [0, 0], false: [0, 0] }, secs = [];
  for (const c of cases.filter((c) => !only.length || only.includes(c.id))) {
    const items = await feed(c);
    if (!items.length) { console.log('-   ', c.id, 'no items (nothing to judge)', c.q); continue; }
    for (let k = 0; k < runs; k++) {
      const { got, detail, secs: s } = await judge(c.q, items);
      secs.push(s);
      const ok = got === c.want;
      if (c.want != null) { tally[c.want][0] += ok; tally[c.want][1]++; }
      console.log(c.want == null ? '??  ' : ok ? 'ok  ' : 'MISS', c.id, 'want', c.want, 'got', got, '(' + detail + ')', s.toFixed(1) + 's', c.q);
      if (verbose && k === 0) items.forEach((i) => console.log('      ', i.n, i.title.slice(0, 90)));
    }
  }
  const avg = secs.reduce((a, b) => a + b, 0) / (secs.length || 1);
  console.log(`\nanswers kept (want true): ${tally.true[0]}/${tally.true[1]}   misses caught (want false): ${tally.false[0]}/${tally.false[1]}   avg ${avg.toFixed(1)} s`);
})();
