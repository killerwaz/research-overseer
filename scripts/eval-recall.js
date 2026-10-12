// #14 end to end: long-term recall through the live router, under a fake chat id.
// Seeds that chat's chat_memory with every exchange of his real chat (embedded as
// WF-00 stores them), leaves its n8n memory EMPTY — so anything the bot knows
// about earlier chats came through recall — asks eval/recall-eval.json (local
// only: his real Telegram text), reads each reply from the finished execution,
// then deletes the fake chat's rows.
// Usage: node scripts/eval-recall.js [case ids...]
const fs = require('fs');
const path = require('path');
const { EMBED_MODEL, vectorLiteral } = require('../shared/embed.js');
const { memoryDoc, shouldRemember, rememberSql } = require('../shared/recall.js');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const ROUTER = 'http://localhost:5678/webhook/overseer-router-test-' + env.ZZ_WEBHOOK_SECRET;
const SET = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'recall-eval.json'), 'utf8'));
const FAKE_CHAT = 999000014;
const only = process.argv.slice(2).map(Number).filter(Boolean);
const API = { 'X-N8N-API-KEY': env.N8N_API_KEY };

const sql = (query) => fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  .then((r) => r.json()).then((j) => (Array.isArray(j) ? j[0] : j));
const maxRun = async () => Number((await sql('select max(id) as m from runs')).m);

async function seed() {
  const r = await sql("select json_agg(x order by id)::text as rows from (select id, message->>'type' as t, message->>'content' as c " +
    "from n8n_chat_histories where session_id = '" + env.TG_CHAT_ID + "' and message->>'type' in ('human', 'ai')) x");
  const rows = JSON.parse(r.rows || '[]');
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!(rows[i].t === 'human' && rows[i + 1] && rows[i + 1].t === 'ai' && shouldRemember(rows[i].c, rows[i + 1].c))) continue;
    const e = await fetch('http://localhost:1234/v1/embeddings', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
      body: JSON.stringify({ model: EMBED_MODEL, input: [memoryDoc(rows[i].c, rows[i + 1].c)] }) }).then((x) => x.json());
    await sql(rememberSql(FAKE_CHAT, rows[i].c, rows[i + 1].c, vectorLiteral(e.data[0].embedding)));
    n++;
  }
  return n;
}

async function cleanup() {
  await sql('delete from chat_memory where chat_id = ' + FAKE_CHAT);
  await sql("delete from n8n_chat_histories where session_id = '" + FAKE_CHAT + "'");
}

// What WF-00 sent ('Prep reply'), read from its finished execution (as eval-answers.js).
async function sent(q, since) {
  for (let tries = 0; tries < 25; tries++) {
    const list = await (await fetch('http://localhost:5678/api/v1/executions?workflowId=VQha8UiuOesJYa11&limit=5', { headers: API })).json();
    for (const e of list.data || []) {
      if (new Date(e.startedAt).getTime() < since - 2000 || !e.finished) continue;
      const d = await (await fetch('http://localhost:5678/api/v1/executions/' + e.id + '?includeData=true', { headers: API })).json();
      const run = (d.data && d.data.resultData && d.data.resultData.runData) || {};
      const out = (n) => { try { return run[n][0].data.main[0][0].json; } catch (x) { return null; } };
      if ((out('Test normalize') || {}).text !== q) continue;
      const ms = ['Recall prep', 'Recall embed', 'Recall sql', 'Recall search', 'Recall note']
        .reduce((s, n) => s + ((run[n] && run[n][0] && run[n][0].executionTime) || 0), 0);
      const ag = out('Overseer Agent') || {};
      return { reply: String((out('Prep reply') || {}).output || ''), recall_n: (out('Recall note') || {}).recall_n || 0,
        redo: Boolean(out('Guarded agent')), stored: Boolean(out('Remember')), recall_ms: ms,
        tools: (ag.intermediateSteps || []).map((x) => x.action.tool) };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { reply: '(no reply found)', tools: [] };
}

(async () => {
  await cleanup();
  console.log('seeded', await seed(), 'exchanges into chat', FAKE_CHAT);
  const cases = SET.cases.filter((c) => !only.length || only.includes(c.id));
  const res = [];
  try {
    for (const c of cases) {
      // every question starts from an empty short-term memory: only recall can know
      await sql("delete from n8n_chat_histories where session_id = '" + FAKE_CHAT + "'");
      const runBefore = await maxRun();
      const t0 = Date.now();
      try {
        await fetch(ROUTER, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: c.q, chat_id: FAKE_CHAT }), signal: AbortSignal.timeout(240000) });
      } catch (e) { /* read from the execution */ }
      const secs = Math.round((Date.now() - t0) / 1000);
      const s = await sent(c.q, t0);
      const web = /^(From the web|Not in your feed)/.test(s.reply.trim());
      let pass = c.expect ? new RegExp(c.expect, 'i').test(s.reply) : !new RegExp(c.forbid, 'i').test(s.reply);
      if (c.no_web && web) pass = false;
      if ((await maxRun()) > runBefore) pass = false;
      res.push({ ...c, pass, secs, ...s, web });
      console.log((pass ? 'ok ' : 'XX ') + String(c.id).padStart(3) + ' ' + String(secs).padStart(3) + 's recall ' + s.recall_n +
        ' (' + s.recall_ms + ' ms)' + (s.redo ? ' [guard redo]' : '') + (web ? ' [web]' : '') + (s.stored ? '' : ' [NOT STORED]') + '  ' + c.q);
      console.log('      ' + s.reply.replace(/\s+/g, ' ').slice(0, 300));
    }
  } finally {
    await cleanup();
  }
  const pos = res.filter((r) => r.expect), neg = res.filter((r) => !r.expect);
  console.log(JSON.stringify({ recalled: pos.filter((r) => r.pass).length + '/' + pos.length, not_invented: neg.filter((r) => r.pass).length + '/' + neg.length,
    avg_recall_ms: Math.round(res.reduce((s, r) => s + (r.recall_ms || 0), 0) / Math.max(1, res.length)) }));
})().catch((e) => { console.error(e.message); process.exit(1); });
