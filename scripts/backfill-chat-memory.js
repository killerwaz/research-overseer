// Copies finished exchanges from n8n's chat memory into chat_memory (sql/016),
// embedded the way WF-00 stores new ones (shared/recall.js memoryDoc).
// Usage: node scripts/backfill-chat-memory.js <chat_id> <first n8n_chat_histories id> [YYYY-MM-DD]
// Wasim's call (2026-10-13): start from the memory fix (96d6932) — older rows can
// hold the reply the bot rejected rather than the one he saw. n8n's table has no
// timestamps, so the date is given.
const fs = require('fs');
const path = require('path');
const { EMBED_MODEL, vectorLiteral } = require('../shared/embed.js');
const { memoryDoc, shouldRemember, rememberSql } = require('../shared/recall.js');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const [chatId, fromId, day] = process.argv.slice(2);
if (!/^-?\d+$/.test(chatId || '') || !/^\d+$/.test(fromId || '')) {
  console.error('usage: node scripts/backfill-chat-memory.js <chat_id> <first history id> [YYYY-MM-DD]');
  process.exit(1);
}
const sql = (query) => fetch('http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  .then((r) => r.json()).then((j) => (Array.isArray(j) ? j[0] : j));

(async () => {
  const r = await sql("select json_agg(x order by id)::text as rows from (select id, message->>'type' as t, message->>'content' as c " +
    "from n8n_chat_histories where session_id = '" + chatId + "' and id >= " + Number(fromId) + " and message->>'type' in ('human', 'ai')) x");
  const rows = JSON.parse(r.rows || '[]');
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].t === 'human' && rows[i + 1] && rows[i + 1].t === 'ai' && shouldRemember(rows[i].c, rows[i + 1].c)) pairs.push({ q: rows[i].c, a: rows[i + 1].c });
  }
  for (const p of pairs) {
    const e = await fetch('http://localhost:1234/v1/embeddings', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
      body: JSON.stringify({ model: EMBED_MODEL, input: [memoryDoc(p.q, p.a)] }) }).then((x) => x.json());
    let q = rememberSql(chatId, p.q, p.a, vectorLiteral(e.data[0].embedding));
    if (day) q = q.replace('(chat_id, question, answer, embedding) values (', '(created_at, chat_id, question, answer, embedding) values (' + "'" + day.replace(/[^0-9-]/g, '') + " 12:00+06', ");
    const res = await sql(q);
    console.log(res.id ? 'stored #' + res.id : JSON.stringify(res), '|', p.q.slice(0, 60));
  }
  console.log(pairs.length, 'exchanges');
})();
