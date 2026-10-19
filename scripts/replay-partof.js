// Replays the myth guard's part-of check (shared/deep-checks.js nearEachOther + the 9B
// PARTOF call in deep-research.js) on the saved REA pages in eval/9b-steps/pages.
// Expect: PhotoCraft / FilmCraft -> part_of ArtCraft; real REA projects -> no excerpt, or not part_of.
// Usage: node scripts/replay-partof.js
const fs = require('fs');
const path = require('path');
const { nearEachOther } = require('../shared/deep-checks.js');
const { PARTOF_SYSTEM, PARTOF_FORMAT, recoverJson } = require('../shared/deep-research.js');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'eval', '9b-steps', 'pages');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const CASES = [['PhotoCraft', true], ['FilmCraft', true], ['DX-Ball', false], ['TH04', false], ['Ledger Reborn', false], ['ReaCut', false], ['open-obsidian', false]];

async function partOf(part, whole, excerpt) {
  const r = await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify({ model: 'qwen/qwen3.5-9b', temperature: 0, reasoning_effort: 'none', max_tokens: 300, response_format: PARTOF_FORMAT,
      messages: [{ role: 'system', content: PARTOF_SYSTEM }, { role: 'user', content: `PART: ${part}\nWHOLE: ${whole}\n\n<excerpt>\n${excerpt}\n</excerpt>` }] }) });
  return recoverJson(((await r.json()).choices || [])[0].message);
}

(async () => {
  let bad = 0;
  for (const [part, expect] of CASES) {
    // the pipeline takes the first page where both names are close; here every page is shown
    const hits = fs.readdirSync(DIR).filter((f) => f.endsWith('.fit.md'))
      .map((f) => [f, nearEachOther(fs.readFileSync(path.join(DIR, f), 'utf8'), part, 'ArtCraft')]).filter((x) => x[1]);
    const verdicts = [];
    for (const [f, ex] of hits) { const v = await partOf(part, 'ArtCraft', ex); verdicts.push(`${f}: ${v && v.verdict} "${(v && v.quote || '').slice(0, 90)}"`); }
    const moved = verdicts.some((v) => /: part_of /.test(v));
    if (moved !== expect) bad++;
    console.log(`${moved === expect ? 'ok  ' : 'WRONG'} ${part}: ${hits.length ? (moved ? 'ruled out (part of ArtCraft)' : 'kept') : 'kept (never near ArtCraft)'}`);
    for (const v of verdicts) console.log('      ' + v);
  }
  console.log(bad ? `${bad} wrong` : 'all as expected');
  process.exit(bad ? 1 : 0);
})();
