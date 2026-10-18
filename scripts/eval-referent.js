// End to end: messages that point at something already shown (shared/referent.js).
// Through the router under a fake chat id — no Telegram, nothing of Wasim's.
// Each case seeds what the chat was last shown, sends one message, and checks
// which route ran and what came back.
//   node scripts/eval-referent.js
const fs = require('fs');
const path = require('path');
const { botSaidSql } = require('../shared/referent.js');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const ROUTER = 'http://localhost:5678/webhook/overseer-router-test-' + env.ZZ_WEBHOOK_SECRET;
const API = { 'X-N8N-API-KEY': env.N8N_API_KEY };
const FAKE = '999000002';
const sql = async (query) => (await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })).json();

async function run(q, since) {
  for (let tries = 0; tries < 40; tries++) {
    const list = await (await fetch('http://localhost:5678/api/v1/executions?workflowId=VQha8UiuOesJYa11&limit=5', { headers: API })).json();
    for (const e of list.data || []) {
      if (new Date(e.startedAt).getTime() < since - 2000 || !e.finished) continue;
      const d = await (await fetch('http://localhost:5678/api/v1/executions/' + e.id + '?includeData=true', { headers: API })).json();
      const rd = (d.data && d.data.resultData && d.data.resultData.runData) || {};
      const out = (n) => { try { return rd[n][0].data.main[0][0].json; } catch (x) { return null; } };
      if ((out('Test normalize') || {}).text !== q) continue;
      const ag = out('Overseer Agent') || {};
      const route = rd['Ref out'] ? 'item' : rd['Synth answer'] ? 'synth' : rd['Overseer Agent'] ? 'agent' : 'other';
      return { exec: e.id, route, reply: String((out('Prep reply') || {}).output || ''), fallback: (out('Ref out') || {}).ref_fallback,
        tools: (ag.intermediateSteps || []).map((x) => x.action.tool) };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { route: 'none', reply: '(no execution found)', tools: [] };
}

const VIDEO = 537;   // Qwen3.8 27B + DeepSeek Harness vs Opus 4.6 (youtu.be/cLqtxkYrMDI)
const seedOne = () => botSaidSql(FAKE, '🎬 <b>Qwen3.8 27B + DeepSeek Harness BEATS Opus 4.6 in Claude Code</b>\n\n(summary with timestamps)', [VIDEO], 'media');
const seedList = (ids, ageMin = 0) => "insert into chat_results (chat_id, item_ids, topic, created_at) values (" + FAKE + ", array[" + ids.join(',') + "]::bigint[], null, now() - interval '" + ageMin + " minutes') on conflict (chat_id) do update set item_ids = excluded.item_ids, created_at = excluded.created_at";
const TS = /\b\d{1,2}:\d{2}\b/;

const cases = [
  { q: 'summarize the video without the timestamps', seed: seedOne, route: 'item', ok: (r) => /qwen/i.test(r.reply) && !TS.test(r.reply) },
  { q: 'is it any good?', seed: seedOne, route: 'item', ok: (r) => r.reply.length > 20 },
  { q: 'summarize it in 3 bullets', seed: seedOne, route: 'item', ok: (r) => /qwen|opus/i.test(r.reply) },
  { q: 'summarize the video', seed: () => seedList([536, VIDEO, 535]), route: 'item', ok: (r) => /qwen/i.test(r.reply), note: 'the only video in a 3-item list' },
  { q: 'what did the first article say about the starter?', seed: () => seedList([536, VIDEO, 535]), route: 'agent', ok: (r) => r.tools.includes('get_item') && /starter|sourdough/i.test(r.reply) },
  { q: 'tell me more about the one on sourdough', seed: () => seedList([536, VIDEO, 535]), route: 'agent', ok: (r) => r.tools.includes('get_item') && /sourdough|starter/i.test(r.reply) },
  { q: 'summarize AI agent funding', seed: seedOne, route: 'synth', ok: () => true },
  { q: 'summarize the video without the timestamps', seed: () => seedList([VIDEO], 300), route: 'agent', ok: (r) => !/mod sun|n8n/i.test(r.reply), note: 'list 5 h old: asks, no overview' },
];

(async () => {
  const results = [];
  for (const c of cases) {
    await sql("delete from n8n_chat_histories where session_id = '" + FAKE + "'");
    await sql('delete from chat_memory where chat_id = ' + FAKE);
    await sql('delete from chat_results where chat_id = ' + FAKE);
    await sql(c.seed());
    const t0 = Date.now();
    try {
      await fetch(ROUTER, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: c.q, chat_id: FAKE }), signal: AbortSignal.timeout(240000) });
    } catch (e) { /* read from the execution */ }
    const r = await run(c.q, t0);
    const pass = r.route === c.route && c.ok(r);
    results.push({ pass, q: c.q, want: c.route, got: r.route, secs: Math.round((Date.now() - t0) / 1000), fallback: r.fallback, tools: r.tools.join(','), exec: r.exec, reply: r.reply.slice(0, 400) });
    console.log((pass ? 'PASS ' : 'FAIL ') + c.q + '  [' + r.route + (c.note ? ', ' + c.note : '') + ']\n   ' + r.reply.slice(0, 300).replace(/\n/g, ' / '));
  }
  await sql("delete from n8n_chat_histories where session_id = '" + FAKE + "'");
  await sql('delete from chat_memory where chat_id = ' + FAKE);
  await sql('delete from chat_results where chat_id = ' + FAKE);
  console.log('\n' + results.filter((r) => r.pass).length + '/' + results.length + ' passed');
  fs.writeFileSync(path.join(__dirname, '..', 'eval', 'referent-results.json'), JSON.stringify(results, null, 2));
})();
