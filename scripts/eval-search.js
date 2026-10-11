// Runs eval/search-eval.json against the LIVE WF-31 (through the readtools
// harness) and scores it. Run before and after any change to feed search.
// Run: node scripts/eval-search.js [--verbose]
// eval/ is local-only (it holds real Telegram messages).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const HARNESS = 'http://localhost:5678/webhook/overseer-readtools-harness-' + env.ZZ_WEBHOOK_SECRET;
const { cases } = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'search-eval.json'), 'utf8'));
const verbose = process.argv.includes('--verbose');
const TOP = 5;

(async () => {
  const tally = { present: [0, 0], absent: [0, 0] };
  const prec = [];
  for (const c of cases) {
    const r = await fetch(HARNESS, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'query_feed', tag: c.q, limit: '20' }) });
    const out = await r.json();
    const items = (out.items || []);
    let pass = null;
    if (c.kind === 'present') {
      const re = new RegExp(c.must, 'i');
      const top = items.slice(0, TOP);
      const on = top.filter((i) => re.test((i.title || '') + ' ' + (i.summary || ''))).length;
      pass = on > 0;
      if (top.length) prec.push(on / top.length);
    } else if (c.kind === 'absent') {
      pass = items.length === 0;
    }
    if (pass !== null) { tally[c.kind][1]++; if (pass) tally[c.kind][0]++; }
    const mark = pass === null ? ' ~ ' : pass ? 'ok ' : 'XX ';
    console.log(mark + c.kind.padEnd(8) + String(items.length).padStart(3) + ' results  ' + c.q);
    if (verbose || pass === false) {
      for (const i of items.slice(0, 3)) console.log('        ' + (i.similarity != null ? Number(i.similarity).toFixed(3) + ' ' : '') + (i.title || '').slice(0, 70));
    }
  }
  console.log(`\npresent: ${tally.present[0]}/${tally.present[1]} found a matching item in the top ${TOP}`);
  console.log(`absent:  ${tally.absent[0]}/${tally.absent[1]} correctly returned nothing`);
  console.log(`precision: ${(100 * prec.reduce((a, b) => a + b, 0) / Math.max(1, prec.length)).toFixed(0)}% of top-${TOP} results match the topic label (labels are loose regexes; compare runs, not absolutes)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
