// Marks same-story duplicates in the existing feed (sql/012), oldest first, with
// the rule WF-21 applies to every new item (shared/dedupe.js).
//   node scripts/backfill-dedupe.js            dry run: prints what it would merge
//   node scripts/backfill-dedupe.js --apply    writes dup_of
// SQL goes through the ZZ runner webhook; the 9B check goes to LM Studio.
const fs = require('fs');
const path = require('path');
const { twinAction, sameStoryBody, parseSame } = require('../shared/dedupe.js');

const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
const APPLY = process.argv.includes('--apply');
const SQL_URL = 'http://localhost:5678/webhook/overseer-sql-runner-' + env.ZZ_WEBHOOK_SECRET;

async function sql(query) {
  const r = await fetch(SQL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}

async function same(a, b) {
  const r = await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify(sameStoryBody(a, b)) });
  return parseSame(((await r.json()).choices || [{}])[0].message);
}

(async () => {
  // Each item against its closest OLDER neighbour, so the root is always the
  // first copy seen — what WF-21 does live, where every candidate is older.
  const rows = JSON.parse((await sql(`select json_agg(x order by self)::text as j from (
    select me.id as self, me.title as ta, left(me.summary, 400) as sa, me.canonical_url as ua,
           c.id as cand, c.root, c.sim, c.title as tb, left(c.summary, 400) as sb, c.canonical_url as ub
    from feed_items me
    cross join lateral (
      select f.id, coalesce(f.dup_of, f.id) as root, 1 - (f.embedding <=> me.embedding) as sim, f.title, f.summary, f.canonical_url
      from feed_items f
      where f.id < me.id and f.embedding is not null and f.summary <> 'TRIAGE_FAILED'
      order by f.embedding <=> me.embedding limit 1) c
    where me.embedding is not null and me.summary <> 'TRIAGE_FAILED') x`)).j || '[]');

  const root = new Map();   // resolves roots assigned earlier in this same pass
  const merges = [];
  let asked = 0;
  for (const r of rows) {
    const act = twinAction(r.sim);
    let merge = act === 'merge';
    if (act === 'check') {
      asked++;
      merge = (await same({ title: r.ta, url: r.ua, summary: r.sa }, { title: r.tb, url: r.ub, summary: r.sb })) === true;
    }
    if (!merge) continue;
    const to = root.get(Number(r.cand)) || Number(r.root);
    root.set(Number(r.self), to);
    merges.push({ self: Number(r.self), to, sim: Number(r.sim).toFixed(3), how: act, a: r.ta, b: r.tb });
  }
  for (const m of merges) console.log(m.sim, m.how.padEnd(5), String(m.a).slice(0, 55).padEnd(55), '->', String(m.b).slice(0, 55));
  console.log(`\n${rows.length} items checked, ${asked} asked the 9B, ${merges.length} marked duplicate, ${new Set(merges.map((m) => m.to)).size} stories affected`);
  if (!APPLY) return console.log('dry run — pass --apply to write');
  for (let i = 0; i < merges.length; i += 50) {
    const vals = merges.slice(i, i + 50).map((m) => `(${m.self}, ${m.to})`).join(',');
    await sql(`update feed_items f set dup_of = v.root from (values ${vals}) v(id, root) where f.id = v.id returning 1`);
  }
  console.log('applied:', (await sql('select count(*) as n from feed_items where dup_of is not null')).n);
})();
