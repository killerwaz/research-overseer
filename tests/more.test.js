const test = require('node:test');
const assert = require('node:assert');
const M = require('../shared/more.js');

const Q = JSON.stringify({ tag: 'nvidia', since: '', min_score: '', max_age_days: '', min_relevance: '', group_stories: '' });

test('route: brief list, feed search, or nothing pageable', () => {
  assert.equal(M.moreRoute('more', 'brief', null, 5), 'brief');
  assert.equal(M.moreRoute('next 5', 'brief-topic', Q, 5), 'brief');
  assert.equal(M.moreRoute('more', null, Q, 10), 'feed');
  assert.equal(M.moreRoute('show me more', '', Q, 0), 'none');
  assert.equal(M.moreRoute('more', '', null, 3), 'none');      // a pasted link's list, a re-sent PDF
  assert.equal(M.moreRoute('tell me more about #2', '', Q, 10), '');
});

test('the next page reuses the stored search with room to skip what was shown', () => {
  assert.deepEqual(M.moreInputs(Q, 10), { tag: 'nvidia', since: '', min_score: '', max_age_days: '', min_relevance: '', group_stories: '', limit: '20' });
});

test('reply skips items already shown, even when WF-31 reorders them', () => {
  const items = [3, 1, 7, 2, 8, 9, 10, 11, 12].map((id) => ({ id, title: 'T' + id, score: 5 }));
  const r = M.moreReply([1, 2, 3], { items }, Q);
  assert.deepEqual(r.items.map((i) => [i.n, i.id]), [[4, 7], [5, 8], [6, 9], [7, 10], [8, 11]]);
  assert.ok(r.output.startsWith('More on nvidia:\n\n4. T7 [5]'));
  assert.ok(r.output.endsWith('Say "more" for the next 5.'));
  assert.deepEqual(r.ids, [1, 2, 3, 7, 8, 9, 10, 11]);
});

test('nothing left; two topics read naturally; list SQL is numbers only', () => {
  assert.equal(M.moreReply([1, 2], { items: [{ id: 1 }, { id: 2 }] }, Q).output, 'That was everything on nvidia: 2 items shown.');
  const two = JSON.stringify({ tag: 'nigeria ai | bangladesh bank' });
  assert.ok(M.moreReply([1], { items: [{ id: 5, title: 'X' }] }, two).output.startsWith('More on nigeria ai and bangladesh bank:'));
  assert.equal(M.moreListSql(42, [1, 'x', 7]), 'update chat_results set item_ids = array[1,7]::bigint[], topic = null, created_at = now() where chat_id = 42');
  assert.ok(!M.moreListSql('42; drop', [1]).includes('drop'));
  assert.equal(M.moreListSql('abc', [1]), '');
});
