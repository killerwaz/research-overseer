// Deploys workflow JSON to the live n8n instance over its REST API.
//
// Substitutes instance-local placeholders on the way out, so the committed
// files never carry live values:
//   __TG_TOKEN__   <- .env TELEGRAM_BOT_TOKEN     (wf00)
//   __TG_CHAT__    <- .env TG_CHAT_ID             (wf00, wf20, wf30, wf99)
//   __ZZ_SECRET__  <- .env ZZ_WEBHOOK_SECRET      (wf00 test hook, tools/*)
//   __WF40_ID__    <- instance.json workflows     (wf30)
//
// The PUT body is {name, nodes, connections, settings} ONLY — n8n rejects the
// full GET payload.
//
// Usage:
//   node scripts/deploy.js wf20-process-urls tools/zz-sql-runner ...
//   node scripts/deploy.js --all
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const instance = require('./instance.json');

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function main() {
  const env = loadEnv();
  const apiKey = env.N8N_API_KEY;
  if (!apiKey) throw new Error('N8N_API_KEY not in .env');
  const base = env.N8N_API_URL || 'http://localhost:5678';

  const subs = {
    __TG_TOKEN__: env.TELEGRAM_BOT_TOKEN,
    __TG_CHAT__: env.TG_CHAT_ID,
    __ZZ_SECRET__: env.ZZ_WEBHOOK_SECRET
  };
  // __WF31__ / __WF40_ID__ style tokens resolve to workflow ids by number.
  for (const [key, id] of Object.entries(instance.workflows)) {
    const num = (key.match(/^wf(\d+)/) || [])[1];
    if (num) { subs[`__WF${num}__`] = id; subs[`__WF${num}_ID__`] = id; }
  }

  let names = process.argv.slice(2);
  if (names[0] === '--all') names = Object.keys(instance.workflows);
  if (!names.length) throw new Error('usage: node scripts/deploy.js <name...> | --all');

  for (const name of names) {
    const key = name.replace(/\.json$/, '');
    const id = instance.workflows[key];
    if (!id) throw new Error(`no workflow id for "${key}" in scripts/instance.json`);

    const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', key + '.json'), 'utf8'));
    let body = JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
    for (const [ph, val] of Object.entries(subs)) {
      if (!body.includes(ph)) continue;
      if (!val) throw new Error(`${key} needs ${ph} but its .env value is missing`);
      body = body.replaceAll(ph, val);
    }

    const res = await fetch(`${base}/api/v1/workflows/${id}`, {
      method: 'PUT',
      headers: { 'X-N8N-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) throw new Error(`${key} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    console.log(`${key} -> deployed (${id})`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
