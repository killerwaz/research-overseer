// #17 Save to Obsidian (2026-10-21). Inlined into WF-00 ('Big picture?', 'Save prep',
// 'Save notes', 'Save reply').
//
// "save #3", "save 1 and 4", "save the first one", "save it" -> one markdown note
// per item in ONE folder of his vault ("Research Overseer Saves", mounted into n8n
// as /vault; nothing else on disk is reachable: N8N_RESTRICT_FILE_ACCESS_TO).
// Decided in code like the brief: no model. A note is never overwritten — he may
// have written in it — so the saves table (sql/018) answers "already saved".

const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1 };
const SAVE_MAX = 10;

// { go, nums: [3, 4] | [], it: bool }
function saveAsk(text) {
  const t = String(text || '').trim().replace(/[.!]+$/, '');
  const m = t.match(/^(?:please |pls |can you |could you )?(?:save|keep|clip|bookmark)\s+(.+?)(?:\s+(?:to|in|into|for)\s+(?:obsidian|my (?:vault|notes)|the vault|notes|later))?$/i);
  if (!m) return { go: false };
  const what = m[1].trim();
  if (/^(?:it|this|that|this one|that one)$/i.test(what)) return { go: true, nums: [], it: true };
  const ord = what.match(/^(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)(?:\s+(?:one|item|article|story|video))?$/i);
  if (ord) return { go: true, nums: [ORD[ord[1].toLowerCase()]], it: false };
  // "#3", "3", "#1 and #4", "1, 2 & 5", "items 2 and 3", "numbers 1-3"
  const body = what.replace(/^(?:items?|numbers?|nos?\.?|#)\s*/i, '');
  if (!/^#?\s?\d{1,3}(?:\s*(?:,|and|&|-|to)\s*#?\s?\d{1,3})*$/i.test(body)) return { go: false };
  const nums = [];
  const range = body.match(/^#?\s?(\d{1,3})\s*(?:-|to)\s*#?\s?(\d{1,3})$/i);
  if (range) { for (let i = Number(range[1]); i <= Number(range[2]) && nums.length < SAVE_MAX; i++) nums.push(i); }
  else for (const n of body.match(/\d{1,3}/g)) if (!nums.includes(Number(n))) nums.push(Number(n));
  return nums.length ? { go: true, nums: nums.slice(0, SAVE_MAX), it: false } : { go: false };
}

// Which list positions to fetch. listN = length of his last list; -1 = last.
function savePositions(ask, listN) {
  const n = Number(listN) || 0;
  if (ask.it) return n === 1 ? { nums: [1] } : { error: n ? 'Which one? Say "save #2" (your last list has ' + n + ' items).' : 'Nothing to save yet: ask for something first, then say "save #1".' };
  const nums = ask.nums.map((x) => (x === -1 ? n : x));
  const bad = nums.filter((x) => x < 1 || x > n);
  if (!n) return { error: 'Nothing to save yet: ask for something first, then say "save #1".' };
  if (bad.length) return { error: 'Your last list has ' + n + ' item' + (n === 1 ? '' : 's') + '; there is no #' + bad.join(', #') + '.' };
  return { nums };
}

// One row back: rows = his list items at those positions, with the cleaned page
// text, and whether each is already saved.
function saveFetchSql(chatId, nums) {
  const chat = String(chatId).replace(/[^0-9-]/g, '');
  const pos = nums.map(Number).filter((x) => Number.isInteger(x) && x > 0);
  return "select (select json_agg(x order by x.k)::text from (select u.k, f.id, f.title, f.canonical_url, f.summary, f.angle, f.score, f.specificity, f.angle_strength, f.tags, f.structured, " +
    "to_char(f.published_at, 'YYYY-MM-DD') as published, s.file_name as saved_as, " +
    "(select left(string_agg(dc.text, chr(10) || chr(10) order by dc.n), 1500) from (select * from doc_chunks c where c.raw_doc_id = f.raw_doc_id order by c.n limit 2) dc) as excerpt " +
    "from chat_results cr, unnest(cr.item_ids) with ordinality u(id, k) join feed_items f on f.id = u.id left join saves s on s.feed_item_id = f.id " +
    'where cr.chat_id = ' + chat + ' and u.k = any(array[' + pos.join(',') + ']::bigint[])) x) as rows';
}

// Windows + Obsidian safe file name; the title says what it is, no date (it is in the note).
function noteFileName(title, id) {
  const base = String(title || 'Saved item').replace(/[\\/:*?"<>|#^[\]{}]+/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 90) || 'Saved item';
  return base + ' (' + Number(id) + ').md';
}

const yamlStr = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim() + '"';
const tagOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function noteMarkdown(it, savedDay) {
  const tags = ['research-overseer', ...(Array.isArray(it.tags) ? it.tags : [])].map(tagOf).filter(Boolean);
  const kp = it.structured && Array.isArray(it.structured.key_points) ? it.structured.key_points : [];
  const lines = ['---',
    'title: ' + yamlStr(it.title),
    'source: ' + yamlStr(it.canonical_url),
    'saved: ' + savedDay,
    it.published ? 'published: ' + it.published : null,
    'score: ' + (it.score == null ? 'null' : it.score),
    'tags: [' + [...new Set(tags)].join(', ') + ']',
    '---', '',
    '# ' + String(it.title || 'Saved item').trim(), '',
    it.angle ? '**Angle:** ' + String(it.angle).trim() + '\n' : null,
    '## Summary', '', String(it.summary || '(no summary)').trim(), ''];
  if (kp.length) {
    lines.push('## Key points', '');
    for (const p of kp.slice(0, 12)) lines.push('- ' + (p.at || p.t ? '[' + (p.at || p.t) + '] ' : '') + String(p.point || p.text || p).trim());
    lines.push('');
  }
  if (it.excerpt) lines.push('## From the page', '', ...String(it.excerpt).trim().split(/\n+/).slice(0, 25).map((l) => '> ' + l), '');
  lines.push('[Open the source](' + String(it.canonical_url || '') + ')', '', '## My notes', '', '');
  return lines.filter((l) => l !== null).join('\n');
}

// What is written, what is recorded, what he is told. rows from saveFetchSql.
function savePlan(rows, chatId, savedDay) {
  const list = Array.isArray(rows) ? rows : [];
  const files = [], already = [];
  for (const it of list) {
    if (it.saved_as) { already.push({ n: Number(it.k), title: it.title, file: it.saved_as }); continue; }
    const file = noteFileName(it.title, it.id);
    files.push({ n: Number(it.k), id: Number(it.id), title: it.title, file, markdown: noteMarkdown(it, savedDay) });
  }
  return { files, already, record: saveRecordSql(files, chatId) };
}

// The saves rows for notes actually written (file names as base64).
function saveRecordSql(files, chatId) {
  const chat = String(chatId).replace(/[^0-9-]/g, '');
  const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');
  return files.length ? 'insert into saves (feed_item_id, chat_id, file_name) values ' +
    files.map((f) => '(' + Number(f.id) + ', ' + chat + ", convert_from(decode('" + b64(f.file) + "', 'base64'), 'UTF8'))").join(', ') +
    ' on conflict (feed_item_id) do nothing' : 'select 1 as skipped';
}

function saveReply(plan, failedFiles) {
  const bad = new Set(failedFiles || []);
  const ok = plan.files.filter((f) => !bad.has(f.file));
  const out = [];
  if (ok.length) out.push('Saved to Obsidian (Research Overseer Saves):\n' + ok.map((f) => '#' + f.n + ' ' + f.file.replace(/\.md$/, '')).join('\n'));
  if (plan.already.length) out.push('Already in your vault:\n' + plan.already.map((a) => '#' + a.n + ' ' + String(a.file).replace(/\.md$/, '')).join('\n'));
  if (bad.size) out.push("Couldn't write: " + [...bad].join(', ') + '. Is Docker\'s access to the vault folder still there?');
  return out.join('\n\n') || 'Nothing to save.';
}

module.exports = { saveAsk, savePositions, saveFetchSql, noteFileName, noteMarkdown, savePlan, saveRecordSql, saveReply, SAVE_MAX };
