// Flips the Fix 1 trial switches (settings table) — read by WF-31 and WF-00
// on every message, no redeploy needed.
// Run: node scripts/fix-switches.js                     show
//      node scripts/fix-switches.js two=true rerank=llm mentions=true check=true
//      node scripts/fix-switches.js off                 all off (Fix 1 switches; web is separate)
//      node scripts/fix-switches.js web=true            Fix 2: web answers when the feed has none
//      node scripts/fix-switches.js synth=fast          #13: big-picture questions get one cited answer (off | fast | think)
//      node scripts/fix-switches.js verify=true         #13: check each sentence of that answer, fix/quote/drop flagged ones
//      node scripts/fix-switches.js recall=false        #14: stop searching earlier chats (default on; exchanges are still stored)
// rerank: off | llm (the 9B scores the candidates)
const fs = require('fs');
const path = require('path');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const SQL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;
const KEYS = { two: 'fix_two_passages', rerank: 'fix_rerank', mentions: 'fix_mentions', check: 'fix_answer_check', web: 'fix_web', synth: 'fix_synth', verify: 'fix_verify', recall: 'fix_recall' };
const ALLOWED = { two: ['true', 'false'], rerank: ['off', 'llm'], mentions: ['true', 'false'], check: ['true', 'false'], web: ['true', 'false'], synth: ['off', 'fast', 'think'], verify: ['true', 'false'], recall: ['true', 'false'] };

async function sql(query) {
  const r = await fetch(SQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}

(async () => {
  const args = process.argv.slice(2);
  const set = {};
  if (args[0] === 'off') Object.assign(set, { two: 'false', rerank: 'off', mentions: 'false', check: 'false' });
  for (const a of args.filter((x) => x.includes('='))) {
    const [k, v] = a.split('=');
    if (!KEYS[k] || !ALLOWED[k].includes(v)) throw new Error('bad switch ' + a + ' (allowed: ' + JSON.stringify(ALLOWED) + ')');
    set[k] = v;
  }
  if (Object.keys(set).length) {
    const values = Object.entries(set).map(([k, v]) => "('" + KEYS[k] + "', '" + v + "', now())").join(', ');
    await sql('insert into settings (key, value, updated_at) values ' + values +
      ' on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at');
  }
  const r = await sql("select json_object_agg(key, value)::text as j from settings where key like 'fix_%'");
  console.log(r.j || '{}');
})().catch((e) => { console.error(e.message); process.exit(1); });
