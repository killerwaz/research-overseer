// Does each phrasing take the right path? Watches runs.max_id to tell whether
// a search actually started, rather than trusting the reply text.
const ROUTER = 'http://localhost:5678/webhook/scout-router-test-__ZZ_SECRET__';
const SQL = 'http://localhost:5678/webhook/scout-sql-runner-__ZZ_SECRET__';

async function maxRun() {
  const r = await fetch(SQL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'select max(id) as m from runs' }) });
  return Number((await r.json()).m);
}

async function ask(text, ms = 100000) {
  const before = await maxRun();
  const t0 = Date.now();
  let reply = '(timed out client-side — server kept working)';
  try {
    const r = await fetch(ROUTER, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    reply = (j.result && j.result.text) || JSON.stringify(j).slice(0, 200);
  } catch (e) { /* keep placeholder */ }
  const secs = Math.round((Date.now() - t0) / 1000);
  const after = await maxRun();
  return { reply, secs, ranSearch: after > before };
}

const cases = [
  { text: "what's happening with inference costs",   wantSearch: false, why: 'a question — must propose and wait' },
  { text: 'search around for AI chip export rules',  wantSearch: true,  why: 'explicit verb — may run' },
  { text: 'catch me up on funding this week',        wantSearch: false, why: 'retrospective — read the feed' },
  { text: 'anything new today?',                     wantSearch: true,  why: 'rss is free — no confirmation' }
];

(async () => {
  for (const c of cases) {
    const r = await ask(c.text);
    const pass = r.ranSearch === c.wantSearch;
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + r.secs + 's  search=' + r.ranSearch +
      ' (want ' + c.wantSearch + ')  ' + c.why);
    console.log('  >>> ' + c.text);
    console.log('  <<< ' + String(r.reply).replace(/\n+/g, ' ').slice(0, 150) + '\n');
    await new Promise(r => setTimeout(r, 3000));
  }
})();
