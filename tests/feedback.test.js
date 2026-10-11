const test = require('node:test');
const assert = require('node:assert');
const { itemKeyboard, listKeyboard, parseVote, votedKeyboard, shownItems, tasteBlock } = require('../shared/feedback.js');

test('itemKeyboard carries the item id, not a list number', () => {
  const k = itemKeyboard(412);
  assert.deepStrictEqual(k.inline_keyboard[0].map((b) => b.callback_data), ['fb:1:412', 'fb:-1:412']);
  assert.strictEqual(itemKeyboard('x'), null);
  assert.strictEqual(itemKeyboard(0), null);
});

test('listKeyboard: two items per row, first 10, numbered', () => {
  const items = Array.from({ length: 13 }, (_, i) => ({ n: i + 1, id: 100 + i }));
  const k = listKeyboard(items);
  assert.strictEqual(k.inline_keyboard.length, 5);
  assert.deepStrictEqual(k.inline_keyboard[0].map((b) => b.text), ['1 👍', '1 👎', '2 👍', '2 👎']);
  assert.strictEqual(k.inline_keyboard[4][3].callback_data, 'fb:-1:109');
  assert.deepStrictEqual(listKeyboard([{ n: 1, id: 7 }]), itemKeyboard(7));   // one item: plain buttons
  assert.strictEqual(listKeyboard([]), null);
  assert.strictEqual(listKeyboard([{ n: 1, id: 'bad' }]), null);
  for (const row of k.inline_keyboard) for (const b of row) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});

test('parseVote accepts only our format', () => {
  assert.deepStrictEqual(parseVote('fb:1:42'), { vote: 1, id: 42 });
  assert.deepStrictEqual(parseVote('fb:-1:42'), { vote: -1, id: 42 });
  for (const d of ['fb:2:42', 'fb:1:x', 'xx', '', null, 'fb:1:42; drop table']) assert.strictEqual(parseVote(d), null, String(d));
});

test('votedKeyboard ticks the choice and un-ticks the other button of that item only', () => {
  const k = listKeyboard([{ n: 1, id: 5 }, { n: 2, id: 6 }]);
  const a = votedKeyboard(k, 5, 1);
  assert.deepStrictEqual(a.inline_keyboard[0].map((b) => b.text), ['1 👍 ✅', '1 👎', '2 👍', '2 👎']);
  const b = votedKeyboard(a, 5, -1);
  assert.deepStrictEqual(b.inline_keyboard[0].map((x) => x.text), ['1 👍', '1 👎 ✅', '2 👍', '2 👎']);
  assert.strictEqual(votedKeyboard(null, 5, 1), null);
});

test('shownItems finds numbered items in tool observations of any shape', () => {
  const obs = JSON.stringify([{ out: { count: 2, items: [{ n: 1, id: 9, title: 'A' }, { n: 2, id: 3, title: 'B', structured: { n: 5, id: 1, title: 'x' } }] } }]);
  const steps = [{ action: { tool: 'query_feed' }, observation: obs },
    { action: { tool: 'get_item' }, observation: { out: { found: true, item: { n: 2, id: 3, title: 'B' } } } }];
  assert.deepStrictEqual(shownItems(steps), [{ n: 1, id: 9 }, { n: 2, id: 3 }]);
  assert.deepStrictEqual(shownItems([{ observation: 'not json' }]), []);
  assert.deepStrictEqual(shownItems(undefined), []);
});

test('tasteBlock: empty until the first vote, then likes and dislikes, capped', () => {
  assert.strictEqual(tasteBlock([]), '');
  assert.strictEqual(tasteBlock(null), '');
  const rows = [{ vote: 1, title: 'Patronus $50M', summary: 'agent eval  funding\n round' }, { vote: -1, title: 'AI will change everything' },
    ...Array.from({ length: 9 }, (_, i) => ({ vote: 1, title: 'L' + i }))];
  const t = tasteBlock(rows);
  assert.match(t, /^\n\nWASIM'S RATINGS/);
  assert.match(t, /Liked \(👍\):\n- Patronus \$50M — agent eval funding round\n/);
  assert.match(t, /Disliked \(👎\):\n- AI will change everything$/);
  assert.strictEqual((t.match(/^- L/gm) || []).length, 5);   // 6 likes max, one is Patronus
});
