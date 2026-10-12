// #13 end to end: questions through the live router (test webhook, fake chat id,
// never Telegram), reading each reply and the path it took from the execution.
// Checks that big-picture questions go to WF-45 and everything else does not.
//   node scripts/eval-synth-e2e.js          path test (7 questions)
//   ALL=1 node scripts/eval-synth-e2e.js    + the 12 synthesis eval questions,
//                                           replies saved to workbench/data/synth-e2e.json
const fs = require('fs');
const path = require('path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const API = { 'X-N8N-API-KEY': env.N8N_API_KEY };
const ROUTER = 'http://localhost:5678/webhook/overseer-router-test-' + env.ZZ_WEBHOOK_SECRET;
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const FAKE_CHAT = 999000001;

// [question, expected path] — synth | agent
const CASES = [
  ["what's happening with AI policy in South Asia?", 'synth'],
  ['how are companies handling the cost of GPUs?', 'synth'],
  ['what does my feed say about MCP security?', 'synth'],
  ['tell me more about #2', 'agent'],
  ['anything on bangladesh bank?', 'agent'],
  ['how are my sources doing?', 'agent'],
  ['who bought Langfuse?', 'agent'],
];
if (process.env.ALL === '1') {
  const extra = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'synth-eval.json'), 'utf8')).questions.map((c) => [c.q, 'synth']);
  for (const e of extra) if (!CASES.some((c) => c[0] === e[0])) CASES.push(e);
}

async function sentReply(q, since) {
  for (let tries = 0; tries < 40; tries++) {
    const list = await (await fetch('http://localhost:5678/api/v1/executions?workflowId=VQha8UiuOesJYa11&limit=5', { headers: API })).json();
    for (const e of list.data || []) {
      if (new Date(e.startedAt).getTime() < since - 2000 || !e.finished) continue;
      const d = await (await fetch('http://localhost:5678/api/v1/executions/' + e.id + '?includeData=true', { headers: API })).json();
      const run = (d.data && d.data.resultData && d.data.resultData.runData) || {};
      const out = (n) => { try { return run[n][0].data.main[0][0].json; } catch (x) { return null; } };
      if ((out('Test normalize') || {}).text !== q) continue;
      const sr = out('Synth result');
      const sa = out('Synth answer') || {};
      const prep = out('Prep reply') || {};
      return { path: sr ? 'synth' : 'agent', status: sr ? sr.synth_status : '', reply: String(prep.output || ''),
        buttons: prep.reply_markup ? prep.reply_markup.inline_keyboard.flat().length : 0, exec: e.id,
        verify: sa.verify || null, synth_secs: sa.seconds };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { path: '?', reply: '(no reply found)', buttons: 0 };
}

(async () => {
  await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: "delete from n8n_chat_histories where session_id = '" + FAKE_CHAT + "'" }) });
  // and its long-term memory (#14): an old run's answers must not be recalled
  await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'delete from chat_memory where chat_id = ' + FAKE_CHAT }) });
  let ok = 0;
  const saved = [];
  for (const [q, want] of CASES) {
    const t0 = Date.now();
    try { await fetch(ROUTER, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: q, chat_id: FAKE_CHAT }), signal: AbortSignal.timeout(300000) }); } catch (e) {}
    const r = await sentReply(q, t0);
    const secs = Math.round((Date.now() - t0) / 1000);
    const pass = r.path === want;
    if (pass) ok++;
    console.log((pass ? 'ok ' : 'XX ') + want.padEnd(5) + ' got ' + r.path.padEnd(5) + ' ' + String(secs).padStart(3) + 's ' +
      (r.status ? '[' + r.status + '] ' : '') + 'buttons ' + r.buttons + '  ' + q);
    if (r.verify) console.log('      verify: ' + JSON.stringify(r.verify).slice(0, 400));
    console.log('      ' + r.reply.replace(/\s+/g, ' ').slice(0, 300));
    saved.push({ q, want, ...r, secs });
  }
  console.log(ok + '/' + CASES.length + ' took the expected path');
  fs.writeFileSync(path.join(__dirname, '..', 'workbench', 'data', 'synth-e2e.json'), JSON.stringify(saved, null, 1));
})();
