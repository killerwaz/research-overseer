const test = require('node:test');
const assert = require('node:assert');
const O = require('../shared/obsidian.js');

test('save phrasings', () => {
  assert.deepEqual(O.saveAsk('save #3'), { go: true, nums: [3], it: false });
  assert.deepEqual(O.saveAsk('save 1 and #4 to obsidian'), { go: true, nums: [1, 4], it: false });
  assert.deepEqual(O.saveAsk('Save items 2, 3 & 5.'), { go: true, nums: [2, 3, 5], it: false });
  assert.deepEqual(O.saveAsk('save 1-3'), { go: true, nums: [1, 2, 3], it: false });
  assert.deepEqual(O.saveAsk('save the second one'), { go: true, nums: [2], it: false });
  assert.deepEqual(O.saveAsk('save the last one'), { go: true, nums: [-1], it: false });
  assert.deepEqual(O.saveAsk('save it to my vault'), { go: true, nums: [], it: true });
  assert.equal(O.saveAsk('bookmark #7').go, true);
});

test('not a save', () => {
  for (const q of ['how do I save money on GPUs?', 'save the planet', 'what does #3 say?', 'saved items?', 'save this for the weekend'])
    assert.equal(O.saveAsk(q).go, false, q);
});

test('positions are checked against the last list', () => {
  assert.deepEqual(O.savePositions(O.saveAsk('save #3'), 5), { nums: [3] });
  assert.deepEqual(O.savePositions(O.saveAsk('save the last one'), 5), { nums: [5] });
  assert.ok(O.savePositions(O.saveAsk('save #9'), 5).error.includes('no #9'));
  assert.deepEqual(O.savePositions(O.saveAsk('save it'), 1), { nums: [1] });
  assert.ok(O.savePositions(O.saveAsk('save it'), 4).error.startsWith('Which one?'));
  assert.ok(O.savePositions(O.saveAsk('save #1'), 0).error.startsWith('Nothing to save yet'));
});

test('file names are safe and unique per item', () => {
  assert.equal(O.noteFileName('GitHub - morluto/rea: Reverse engineer anything? | "v2"', 42), 'GitHub - morluto rea Reverse engineer anything v2 (42).md');
  assert.equal(O.noteFileName('', 7), 'Saved item (7).md');
  assert.ok(O.noteFileName('x'.repeat(300), 1).length < 100);
});

test('note: front matter, angle, summary, key points, excerpt, notes section', () => {
  const md = O.noteMarkdown({ id: 9, title: 'Bangladesh Bank: AI "rules"', canonical_url: 'https://x.test/a', summary: 'Sum.', angle: 'Why it matters.',
    score: 8, tags: ['AI Policy', 'Bangladesh'], published: '2026-10-01', structured: { key_points: [{ t: '1:05', point: 'First point.' }] },
    excerpt: 'Line one.\nLine two.' }, '2026-10-21');
  assert.ok(md.startsWith('---\ntitle: "Bangladesh Bank: AI \\"rules\\""\nsource: "https://x.test/a"\nsaved: 2026-10-21\npublished: 2026-10-01\nscore: 8\ntags: [research-overseer, ai-policy, bangladesh]\n---'));
  assert.ok(md.includes('**Angle:** Why it matters.'));
  assert.ok(md.includes('- [1:05] First point.'));
  assert.ok(md.includes('> Line one.\n> Line two.'));
  assert.ok(md.trimEnd().endsWith('## My notes'));
});

test('plan: already-saved items are not rewritten; record SQL is base64', () => {
  const rows = [{ k: 1, id: 5, title: 'New $785606.5 story', canonical_url: 'u', summary: 's' }, { k: 2, id: 6, title: 'Old', saved_as: 'Old (6).md' }];
  const p = O.savePlan(rows, 42, '2026-10-21');
  assert.deepEqual(p.files.map((f) => f.file), ['New $785606.5 story (5).md']);
  assert.equal(p.already[0].file, 'Old (6).md');
  assert.ok(!p.record.includes('785606'));
  assert.ok(p.record.includes('on conflict (feed_item_id) do nothing'));
  const r = O.saveReply(p, []);
  assert.ok(r.startsWith('Saved to Obsidian (Research Overseer Saves):\n#1 New $785606.5 story (5)'));
  assert.ok(r.includes('Already in your vault:\n#2 Old (6)'));
  assert.ok(O.saveReply(p, ['New $785606.5 story (5).md']).includes("Couldn't write"));
});

test('fetch SQL keeps to his chat and the asked positions', () => {
  const s = O.saveFetchSql('42', [3, 4]);
  assert.ok(s.includes('cr.chat_id = 42'));
  assert.ok(s.includes('u.k = any(array[3,4]::bigint[])'));
});
