// End-to-end: asks the LIVE bot (WF-00, through the router test hook) the
// questions in eval/passage-eval.json and checks each reply for the answer.
// Run: node scripts/eval-answers.js [id ...]
//
// Uses a fake chat id, so nothing reaches Wasim's Telegram (the send fails
// quietly, onError continue) and his chat memory is untouched; the reply is
// read back from that fake chat's memory. Fails a case outright if a run
// (a paid search) started — these are all questions about the existing feed.
// Results go to workbench/data/answers.json (answers-$EVAL_LABEL.json when EVAL_LABEL is set).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const ROUTER = 'http://localhost:5678/webhook/overseer-router-test-' + env.ZZ_WEBHOOK_SECRET;
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'passage-eval.json'), 'utf8'));
const FAKE_CHAT = 999000001;
const only = process.argv.slice(2).map(Number).filter(Boolean);

async function sql(query) {
  const r = await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}
const maxRun = async () => Number((await sql('select max(id) as m from runs')).m);
const API = { 'X-N8N-API-KEY': env.N8N_API_KEY };
// What WF-00 would have sent ('Prep reply'), read from its finished execution.
// Not from memory: the answer guard rewrites memory after the fact.
async function sentReply(q, since) {
  for (let tries = 0; tries < 20; tries++) {
    const list = await (await fetch('http://localhost:5678/api/v1/executions?workflowId=VQha8UiuOesJYa11&limit=5', { headers: API })).json();
    for (const e of list.data || []) {
      if (new Date(e.startedAt).getTime() < since - 2000 || !e.finished) continue;
      const d = await (await fetch('http://localhost:5678/api/v1/executions/' + e.id + '?includeData=true', { headers: API })).json();
      const run = (d.data && d.data.resultData && d.data.resultData.runData) || {};
      const out = (n) => { try { return run[n][0].data.main[0][0].json; } catch (x) { return null; } };
      if ((out('Test normalize') || {}).text !== q) continue;
      const ag = out('Overseer Agent') || {};
      return { reply: String((out('Prep reply') || {}).output || ''), exec: e.id, redo: Boolean(out('Guarded agent')),
        tools: (ag.intermediateSteps || []).map((x) => x.action.tool + ' ' + JSON.stringify(x.action.toolInput)) };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { reply: '(no reply found)', tools: [] };
}

(async () => {
  // A fresh conversation per run: earlier test answers must not leak into this one.
  await sql("delete from n8n_chat_histories where session_id = '" + FAKE_CHAT + "'");
  // and its long-term memory (#14): an old run's answers must not be recalled
  await sql('delete from chat_memory where chat_id = ' + FAKE_CHAT);
  // WEB=1: Fix 2 is on — absent topics must come back from the web, feed
// questions must NOT go to the web, and the general questions run too.
const WEB = process.env.WEB === '1';
const cases = [...SET.questions, ...SET.absent.filter((a) => !a.near), ...(WEB ? SET.general || [] : [])].filter((c) => !only.length || only.includes(c.id));
  const results = [];
  for (const c of cases) {
    const runBefore = await maxRun();
    const t0 = Date.now();
    try {
      await fetch(ROUTER, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: c.q, chat_id: FAKE_CHAT }), signal: AbortSignal.timeout(240000) });
    } catch (e) { /* the reply is read from the execution below */ }
    const secs = Math.round((Date.now() - t0) / 1000);
    const sent = await sentReply(c.q, t0);
    const reply = sent.reply;
    const searched = (await maxRun()) > runBefore;
    let pass;
    const fromWeb = /^(From the web|Not in your feed)/.test(reply.trim());
    if (c.expect) pass = new RegExp(c.expect, 'i').test(reply) && (!WEB || (c.id >= 200) === fromWeb);
    else if (WEB) pass = fromWeb;
    else pass = /nothing|\bno\b[^.]{0,30}\b(items?|results?|matches|coverage|articles?|news|stor(y|ies)|information|info|details|data)\b|doesn.t (have|mention|cover|say)|not (find|found|in the feed|covered)|couldn.t find/i.test(reply);
    if (searched) pass = false;
    results.push({ id: c.id, q: c.q, expect: c.expect || '(nothing found)', pass, searched, secs, reply, tools: sent.tools, redo: sent.redo, exec: sent.exec, web: fromWeb });
    console.log((pass ? 'ok ' : 'XX ') + String(c.id).padStart(3) + ' ' + String(secs).padStart(3) + 's ' + (searched ? 'STARTED A RUN ' : '') +
      (sent.tools.length ? '' : '[no tool] ') + (sent.redo ? '[guard redo] ' : '') + c.q);
    if (!pass) console.log('      tools: ' + (sent.tools.join(' ; ') || 'none') + '\n      ' + reply.replace(/\s+/g, ' ').slice(0, 400));
  }
  const q = results.filter((r) => r.expect !== '(nothing found)' && r.id < 200), a = results.filter((r) => r.expect === '(nothing found)'), g = results.filter((r) => r.id >= 200);
  const summary = { answered: q.filter((r) => r.pass).length + '/' + q.length, absent_ok: a.filter((r) => r.pass).length + '/' + a.length,
    runs_started: results.filter((r) => r.searched).length, ...(WEB ? { general_ok: g.filter((r) => r.pass).length + '/' + g.length, web_answers: results.filter((r) => r.web).length } : {}) };
  console.log(JSON.stringify(summary));
  fs.mkdirSync(path.join(ROOT, 'workbench', 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'workbench', 'data', 'answers' + (process.env.EVAL_LABEL ? '-' + process.env.EVAL_LABEL : '') + '.json'), JSON.stringify({ generated_at: new Date().toISOString(), summary, results }));
})().catch((e) => { console.error(e.message); process.exit(1); });
