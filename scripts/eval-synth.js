// #13 synthesis eval, run locally: the same pipeline as WF-45 (WF-31 search via
// the read-tools harness, shared/synth.js, LM Studio) without touching the live
// router or its switches. Writes workbench/data/synth-<mode>.json for the
// hand check of every citation.
//
//   node scripts/eval-synth.js fast          # thinking off
//   node scripts/eval-synth.js think         # thinking on
//   ONLY=1,4 node scripts/eval-synth.js fast
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
global.unsupportedFacts = require('../shared/answer-check.js').unsupportedFacts;
const S = require('../shared/synth.js');

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const MODEL = 'qwen/qwen3.5-9b';
const FAKE_CHAT = '999000001';
const mode = process.argv[2] === 'think' ? 'think' : 'fast';
const only = (process.env.ONLY || '').split(',').filter(Boolean).map(Number);
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'synth-eval.json'), 'utf8')).questions
  .filter((c) => !only.length || only.includes(c.id));

async function search(question) {
  const r = await fetch('http://localhost:5678/webhook/overseer-readtools-harness-' + env.ZZ_WEBHOOK_SECRET, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: 'query_feed', tag: S.synthTopic(question) || question, user_text: question, limit: '8', chat_id: FAKE_CHAT }) });
  return ((await r.json()).items || []).slice(0, S.SYNTH_MAX_ITEMS);
}

async function ask(body) {
  const r = await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  const j = await r.json();
  return String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
}

(async () => {
  const out = [];
  for (const c of SET) {
    const t0 = Date.now();
    const items = await search(c.q);
    const tSearch = Date.now() - t0;
    let status, answer = '', first = '', firstProblems = [], problems = [], output;
    if (!items.length) { status = 'no items'; output = S.formatFallback([]); } else {
      first = await ask(S.synthBody(MODEL, c.q, items, mode));
      const c1 = S.checkSynth(first, items, c.q);
      if (c1.ok) { status = c1.nothing ? 'nothing' : 'ok first try'; answer = first; } else {
        firstProblems = c1.problems;
        const second = await ask(S.synthBody(MODEL, c.q, items, mode, { previous: first || '(empty)', problems: c1.problems }));
        const c2 = S.checkSynth(second, items, c.q);
        if (c2.ok) { status = c2.nothing ? 'nothing' : 'ok after rewrite'; answer = second; } else {
          problems = c2.problems;
          const kept = S.salvage(second, c2);
          if (kept) { status = 'salvaged'; answer = kept; } else status = 'fallback list';
        }
      }
      output = answer ? S.finalReply(answer, items).output : S.formatFallback(items);
    }
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    out.push({ id: c.id, kind: c.kind, q: c.q, mode, status, secs, search_secs: Math.round(tSearch / 100) / 10, first_problems: firstProblems, problems, output,
      items: items.map((it) => ({ n: it.n, id: it.id, title: S.itemTitle(it), score: it.score, summary: it.summary, evidence: S.evidenceText(it.evidence).slice(0, 1500) })) });
    console.log(String(c.id).padStart(2) + ' ' + c.kind.padEnd(6) + ' ' + status.padEnd(16) + ' ' + String(secs).padStart(5) + 's  items ' + items.length + '  ' + c.q);
    if (firstProblems.length) console.log('     first: ' + firstProblems.join(' | ').slice(0, 200));
  }
  const dir = path.join(ROOT, 'workbench', 'data');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'synth-' + mode + '.json'), JSON.stringify(out, null, 1));
  const n = (s) => out.filter((r) => r.status === s).length;
  const nothing = n('nothing');
  const avg = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : 0;
  console.log(JSON.stringify({ mode, ok_first: n('ok first try'), ok_rewrite: n('ok after rewrite'), salvaged: n('salvaged'), fallback: n('fallback list'), no_items: n('no items'), nothing,
    avg_secs: avg(out.map((r) => r.secs)), max_secs: Math.max(...out.map((r) => r.secs)) }));
})();
