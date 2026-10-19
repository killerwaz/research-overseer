// Runs shared/deep-research.js from a terminal: the same code WF-46 'Deep run' runs.
// Usage:
//   node scripts/deep-research.js "what products were built with X?"
//   node scripts/deep-research.js --cases eval/research-eval.json --out eval/deep-pipeline/out-port [id ...]
// Search, page and extraction results are cached in eval/deep-pipeline/cache (the
// prototype's cache, same keys), so a re-run costs nothing for what was fetched before.
// NO_CACHE=1 runs live. Keys from .env: EXA_API_KEY, BRAVE_API_KEY, FIRECRAWL_API_KEY, LMSTUDIO_API_KEY.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
// in n8n both files are pasted into one Code node, so the checks are plain globals there.
// DEEP_DIR=eval/deep-pipeline/v3-snapshot runs an older copy, for blind A/B grading.
const DIR = process.env.DEEP_DIR ? path.resolve(process.env.DEEP_DIR) : path.join(ROOT, 'shared');
Object.assign(global, require(path.join(DIR, 'deep-checks.js')));
const { deepResearch } = require(path.join(DIR, 'deep-research.js'));

const CACHE = path.join(ROOT, 'eval', 'deep-pipeline', 'cache');
const cacheFile = (kind, req) => path.join(CACHE, kind === 'x9b'
  ? 'x9b-' + crypto.createHash('sha1').update(req).digest('hex').slice(0, 16) + '.json'
  : kind + '-' + crypto.createHash('sha1').update(kind + JSON.stringify(req)).digest('hex').slice(0, 16) + '.json');
const cache = process.env.NO_CACHE === '1' ? null : {
  get: async (kind, req) => { const f = cacheFile(kind, req); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; },
  set: async (kind, req, v) => { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cacheFile(kind, req), JSON.stringify(v)); },
};

async function http({ method, url, headers, body, timeout }) {
  const r = await fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout || 60000) });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t }; }
}

const io = (log) => ({
  http, cache, log, progress: async (s) => log('  ... ' + s),
  keys: { exa: env.EXA_API_KEY, brave: env.BRAVE_API_KEY, firecrawl: env.FIRECRAWL_API_KEY, lmstudio: env.LMSTUDIO_API_KEY },
  lmUrl: 'http://localhost:1234/v1/chat/completions',
  today: process.env.TODAY || new Date().toISOString().slice(0, 10),
});

(async () => {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--cases'), oi = args.indexOf('--out');
  if (ci < 0) {
    const r = await deepResearch(args.join(' '), io(console.log));
    console.log('\n' + r.reply + '\n');
    console.log(JSON.stringify({ seconds: r.trace.seconds, stages: r.trace.stages, calls: r.trace.calls, empty: r.trace.empty, spend: r.trace.spend }));
    return;
  }
  // batch: one case at a time; writes <out>/<id>.json (trace) and .md (the reply); skips finished cases
  const cases = JSON.parse(fs.readFileSync(path.resolve(args[ci + 1]), 'utf8')).cases;
  const out = path.resolve(args[oi + 1]);
  const want = args.filter((a, i) => i !== ci && i !== ci + 1 && i !== oi && i !== oi + 1);
  fs.mkdirSync(out, { recursive: true });
  for (const c of cases) {
    if (want.length && !want.includes(c.id)) continue;
    if (fs.existsSync(path.join(out, c.id + '.json'))) { console.log('skip', c.id); continue; }
    try {
      const r = await deepResearch(c.question, io(() => {}));
      fs.writeFileSync(path.join(out, c.id + '.json'), JSON.stringify({ ...r.trace, reply: r.reply, sources: r.sources }, null, 1));
      fs.writeFileSync(path.join(out, c.id + '.md'), r.reply + '\n');
      console.log(`DONE ${c.id} ${r.trace.seconds}s calls ${JSON.stringify(r.trace.calls)} empty ${r.trace.empty}`);
    } catch (e) { console.log(`FAILED ${c.id}: ${e.stack}`); }
  }
  console.log('ALL DONE');
})();
