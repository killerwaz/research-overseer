// End-to-end check of the run_discovery gate (shared/search-gate.js, WF-41
// 'Search asked?'). Sends bare topics to the LIVE bot under a fake chat and
// fails if any started a run; reports when the 9B tried run_discovery anyway
// (that is the case the gate exists for: "NOT RUN" came back, nothing started).
// Run: node scripts/eval-search-gate.js [repeats]
// LIVE=1 also sends one explicit "search for ..." and expects a run (costs one
// tavily/exa/brave search and ~6 minutes, and adds items to the real feed).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const ROUTER = 'http://localhost:5678/webhook/overseer-router-test-' + env.ZZ_WEBHOOK_SECRET;
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const API = { 'X-N8N-API-KEY': env.N8N_API_KEY };
const FAKE_CHAT = 999000003;
const REPEATS = Number(process.argv[2]) || 1;

const BARE = [
  'quantum error correction breakthroughs', // execution 37070 started run 102
  'best sourdough starter recipe', // execution 34834
  'Formula One team budget cap'
];
const EXPLICIT = 'search for MCP server security vulnerabilities';

async function sql(query) {
  const r = await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}
const maxRun = async () => Number((await sql('select max(id) as m from runs')).m);

async function execFor(q, since) {
  for (let tries = 0; tries < 40; tries++) {
    const list = await (await fetch('http://localhost:5678/api/v1/executions?workflowId=VQha8UiuOesJYa11&limit=100', { headers: API })).json();
    for (const e of list.data || []) {
      if (new Date(e.startedAt).getTime() < since - 2000 || !e.finished) continue;
      const d = await (await fetch('http://localhost:5678/api/v1/executions/' + e.id + '?includeData=true', { headers: API })).json();
      const run = (d.data && d.data.resultData && d.data.resultData.runData) || {};
      const out = (n) => { try { return run[n][0].data.main[0][0].json; } catch (x) { return null; } };
      if ((out('Test normalize') || {}).text !== q) continue;
      const steps = [...((out('Overseer Agent') || {}).intermediateSteps || []), ...((out('Guarded agent') || {}).intermediateSteps || [])];
      const disc = steps.filter((s) => s.action && s.action.tool === 'run_discovery');
      return { exec: e.id, search_ok: (out('Big picture?') || {}).search_ok, reply: String((out('Prep reply') || {}).output || ''),
        tried: disc.length, refused: disc.filter((s) => /NOT RUN/.test(JSON.stringify(s.observation || ''))).length };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { exec: null, reply: '(no execution found)', tried: 0, refused: 0 };
}

async function ask(q) {
  await sql("delete from n8n_chat_histories where session_id = '" + FAKE_CHAT + "'");
  await sql('delete from chat_memory where chat_id = ' + FAKE_CHAT);
  const before = await maxRun();
  const t0 = Date.now();
  try {
    await fetch(ROUTER, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: q, chat_id: FAKE_CHAT }), signal: AbortSignal.timeout(600000) });
  } catch (e) { /* read from the execution */ }
  const x = await execFor(q, t0);
  return { q, ...x, runs: (await maxRun()) - before, secs: Math.round((Date.now() - t0) / 1000) };
}

(async () => {
  const results = [];
  for (let r = 0; r < REPEATS; r++) {
    for (const q of BARE) {
      const x = await ask(q);
      x.pass = x.runs === 0 && x.search_ok === 'false';
      results.push(x);
      console.log((x.pass ? 'ok ' : 'XX ') + String(x.secs).padStart(3) + 's runs=' + x.runs + ' search_ok=' + x.search_ok +
        (x.tried ? ' [9B tried run_discovery ' + x.tried + 'x, refused ' + x.refused + ']' : '') + ' exec ' + x.exec + '  ' + q);
    }
  }
  if (process.env.LIVE === '1') {
    const x = await ask(EXPLICIT);
    x.pass = x.runs > 0 && x.search_ok === 'true';
    results.push(x);
    console.log((x.pass ? 'ok ' : 'XX ') + String(x.secs).padStart(3) + 's runs=' + x.runs + ' search_ok=' + x.search_ok + ' exec ' + x.exec + '  ' + EXPLICIT);
    if (!x.pass) console.log('      ' + x.reply.replace(/\s+/g, ' ').slice(0, 300));
  }
  const bare = results.filter((x) => x.q !== EXPLICIT);
  console.log(JSON.stringify({ bare_ok: bare.filter((x) => x.pass).length + '/' + bare.length,
    runs_started_bare: bare.reduce((n, x) => n + x.runs, 0), discovery_attempts_refused: bare.reduce((n, x) => n + x.refused, 0) + '/' + bare.reduce((n, x) => n + x.tried, 0),
    ...(process.env.LIVE === '1' ? { explicit_ran: results[results.length - 1].pass } : {}) }));
})().catch((e) => { console.error(e.message); process.exit(1); });
