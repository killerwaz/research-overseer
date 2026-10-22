// Deploys workflow JSON to the live n8n instance over its REST API.
//
// Substitutes instance-local placeholders on the way out, so the committed
// files never carry live values:
//   __TG_TOKEN__   <- .env TELEGRAM_BOT_TOKEN     (wf00)
//   __TG_CHAT__    <- .env TG_CHAT_ID             (wf00, wf20, wf30, wf99)
//   __ZZ_SECRET__  <- .env ZZ_WEBHOOK_SECRET      (wf00 test hook, tools/*)
//   __CRED_*__ __CREDNAME_*__ __WF43__ __WFID_*__ <- instance.json (every credential / workflow id; scripts/ids.js)
//   __BEAT__       <- beat.md                     (wf20, wf30 triage prompt)
//   __EXA_KEY__ __BRAVE_KEY__ __FIRECRAWL_KEY__ __LM_KEY__ <- .env (wf46 'Deep run')
//
// The PUT body is {name, nodes, connections, settings} ONLY — n8n rejects the
// full GET payload.
//
// Usage:
//   node scripts/deploy.js wf20-process-urls tools/zz-sql-runner ...
//   node scripts/deploy.js --all
// wf46-deep-research first runs scripts/deep-gate.js (known myths) and is refused on a failure;
// --skip-gate overrides.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const instance = require('./instance.json');
const { idSubstitutions } = require('./ids.js');

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// The beat is substituted into both a JSON string (wf30's HTTP body) and JS
// source inlined inside a Code node (wf20), so it must be plain prose — any
// quote, backtick or backslash would need context-dependent escaping.
function loadBeat() {
  const p = path.join(ROOT, 'beat.md');
  if (!fs.existsSync(p)) return undefined;
  const beat = fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ').trim();
  if (!beat) throw new Error('beat.md is empty');
  if (/['"\\`]/.test(beat)) throw new Error('beat.md must not contain quotes, backticks or backslashes');
  return beat;
}

async function main() {
  const env = loadEnv();
  const apiKey = env.N8N_API_KEY;
  if (!apiKey) throw new Error('N8N_API_KEY not in .env');
  const base = env.N8N_API_URL || 'http://localhost:5678';

  const subs = {
    __TG_TOKEN__: env.TELEGRAM_BOT_TOKEN,
    __TG_CHAT__: env.TG_CHAT_ID,
    __ZZ_SECRET__: env.ZZ_WEBHOOK_SECRET,
    __MEDIA_TOKEN__: env.MEDIA_TOKEN,
    // wf46 deep research: its one Code node calls these APIs itself (no n8n credentials in Code nodes)
    __EXA_KEY__: env.EXA_API_KEY,
    __BRAVE_KEY__: env.BRAVE_API_KEY,
    __FIRECRAWL_KEY__: env.FIRECRAWL_API_KEY,
    __LM_KEY__: env.LMSTUDIO_API_KEY,
    __BEAT__: loadBeat()
  };
  // Every credential and workflow id (__CRED_POSTGRES__, __WF31__, __WFID_TOOLS_ZZ_SQL_RUNNER__ ...)
  // resolves from instance.json, so the committed JSON never names one instance's ids (scripts/ids.js).
  Object.assign(subs, idSubstitutions(instance));

  let names = process.argv.slice(2);
  const skipGate = names.includes('--skip-gate');
  names = names.filter((n) => n !== '--skip-gate');
  if (names[0] === '--all') names = Object.keys(instance.workflows);
  if (!names.length) throw new Error('usage: node scripts/deploy.js <name...> | --all  [--skip-gate]');

  // wf46 deep research deploys only if no known myth comes back (scripts/deep-traps.json)
  if (names.includes('wf46-deep-research') && !skipGate && !require('./deep-gate.js').main()) {
    throw new Error('wf46-deep-research NOT deployed: the deep gate failed (see above; --skip-gate to override)');
  }

  for (const name of names) {
    const key = name.replace(/\.json$/, '');
    const id = instance.workflows[key];
    if (!id) throw new Error(`no workflow id for "${key}" in scripts/instance.json`);

    const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', key + '.json'), 'utf8'));
    let body = JSON.stringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
    for (const [ph, val] of Object.entries(subs)) {
      if (!body.includes(ph)) continue;
      if (!val) throw new Error(`${key} needs ${ph} but no value is available (check .env; for __BEAT__, copy beat.example.md to beat.md)`);
      body = body.replaceAll(ph, val);
    }
    const left = body.match(/__(?:CRED|CREDNAME|WF|WFID|TG|ZZ|MEDIA|EXA|BRAVE|FIRECRAWL|LM|BEAT)[A-Z0-9_]*__/);
    if (left) throw new Error(`${key} still has ${left[0]} after substitution (missing from scripts/ids.js or instance.json?)`);

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
