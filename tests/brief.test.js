const test = require('node:test');
const assert = require('node:assert');
const B = require('../shared/brief.js');

const NOW = '2026-10-21T06:00:00.000Z';   // Wed 21 Oct 12:00 Dhaka

test('brief phrasings are recognised; RSS and feed questions are not', () => {
  for (const q of ['brief me', 'Brief me please', 'catch me up', 'what did I miss?', 'give me a brief', 'recap', 'fill me in', 'bring me up to speed'])
    assert.equal(B.briefAsk(q).go, true, q);
  for (const q of ['anything new today?', 'anything on bangladesh bank?', "what's happening with AI agents?", 'deep search: REA', 'who is a brief history author'])
    assert.equal(B.briefAsk(q).go, false, q);
});

test('a window and a topic are pulled out', () => {
  assert.deepEqual(B.briefAsk('brief me on Bangladesh'), { go: true, more: false, topic: 'Bangladesh', days: '' });
  assert.deepEqual(B.briefAsk('catch me up on funding this week'), { go: true, more: false, topic: 'funding', days: '7' });
  assert.deepEqual(B.briefAsk('catch me up on this week'), { go: true, more: false, topic: '', days: '7' });
  assert.deepEqual(B.briefAsk('catch me up on everything'), { go: true, more: false, topic: '', days: '' });
  assert.equal(B.briefAsk('brief me, last 3 days').days, '3');
  assert.equal(B.briefAsk('what did I miss today?').days, '1');
});

test('"more" only right after a brief that offered more', () => {
  assert.equal(B.briefAsk('more', '49 new stories since Wed 14 Oct 06:58, 14 scored 7+. Best 5:\n...\n\nSay "more" for the next 5.').more, true);
  assert.equal(B.briefAsk('next 5', 'More since Wed 14 Oct 06:58 (6–10 of 49):\n...\n\nSay "more" for the next 5.').more, true);
  assert.equal(B.briefAsk('more', 'Here are the items on Nvidia.').go, false);
  // the agent copying the layout is not a brief
  assert.equal(B.briefAsk('more', 'Here’s what your feeds have on Bangladesh right now:\n\nTop 5:\n...\n\nSay "more" for the next 5.').go, false);
});

test('first brief looks back 7 days and moves "last"; a later one starts there', () => {
  const p1 = B.briefPlan(B.briefAsk('brief me'), {}, NOW);
  assert.equal(p1.since, '2026-10-14T06:00:00.000Z');
  assert.equal(p1.store.last, NOW);
  assert.equal(p1.from_last, false);
  const p2 = B.briefPlan(B.briefAsk('brief me'), p1.store, '2026-10-22T06:00:00.000Z');
  assert.equal(p2.since, NOW);
  assert.equal(p2.from_last, true);
});

test('topic and explicit-window briefs leave "last" alone; "more" pages on', () => {
  const st = { last: NOW, since: NOW, page: 0, topic: '' };
  const t = B.briefPlan({ go: true, more: false, topic: 'Pathao', days: '' }, st, '2026-10-22T06:00:00.000Z');
  assert.equal(t.store.last, NOW);
  assert.equal(t.since, NOW);
  const w = B.briefPlan(B.briefAsk('catch me up on this week'), st, '2026-10-22T06:00:00.000Z');
  assert.equal(w.store.last, NOW);
  assert.equal(w.since, '2026-10-15T06:00:00.000Z');
  const m = B.briefPlan({ go: true, more: true }, t.store, '2026-10-22T06:01:00.000Z');
  assert.equal(m.page, 1);
  assert.equal(m.topic, 'Pathao');
  assert.equal(m.since, NOW);
});

test('SQL filters on arrival time, pages by 5, and carries topic text as base64', () => {
  const s = B.briefSql({ since: NOW, topic: "o'brien $785606.5", page: 2 });
  assert.ok(s.includes("s.created_at >= '2026-10-21T06:00:00.000Z'::timestamptz"));
  assert.ok(s.includes('limit 5 offset 10'));
  assert.ok(!s.includes('785606'), 'topic text must not reach the query raw');
  assert.ok(!B.briefSql({ since: NOW, topic: '', page: 0 }).includes('tsvector'));
  assert.throws(() => B.briefSql({ since: 'garbage' }));
});

test('reply: counts, best 5, numbering across pages, nothing new', () => {
  const plan = { since: NOW, topic: '', page: 0, from_last: true };
  const rows = [1, 2, 3, 4, 5].map((i) => ({ id: 100 + i, title: 'Story ' + i, angle: 'Why ' + i, score: 10 - i, articles: i === 1 ? 3 : 1 }));
  const r = B.briefReply(plan, rows, 23, 12);
  assert.ok(r.output.startsWith('23 new stories since your last brief (Wed 21 Oct 12:00), 12 scored 7+. Best 5:'));
  assert.ok(r.output.includes('1. Story 1 (3 sources) [9]\n   Why 1'));
  assert.ok(r.output.endsWith('Say "more" for the next 5.'));
  assert.deepEqual(r.items.map((i) => i.n), [1, 2, 3, 4, 5]);
  const r2 = B.briefReply({ ...plan, page: 4 }, rows.slice(0, 3), 23, 12);
  assert.deepEqual(r2.items.map((i) => i.n), [21, 22, 23]);
  assert.ok(!r2.output.includes('Say "more"'));
  assert.equal(B.briefReply({ ...plan, topic: 'Pathao' }, [], 0, 0).output, 'Nothing new on Pathao since your last brief (Wed 21 Oct 12:00).');
  assert.ok(B.briefReply({ ...plan, page: 5 }, [], 23, 12).output.startsWith('That was all of them: 23 new stories'));
});

test('topic brief: WF-31 items in the brief layout, spelling noted, nothing found', () => {
  const r = B.briefTopicReply('pathoa', { spelling: 'searched for "pathao" (the message said "pathoa") — mention it in one short clause',
    items: [{ n: 1, id: 5, title: 'AI Policy for Bangladesh', score: 0, angle: 'x' }, { n: 2, id: 6, title: 'National Strategy', score: 6, articles: 2 }] });
  assert.ok(r.output.startsWith('Best on pathoa (searched for "pathao" (the message said "pathoa")):'));
  assert.ok(r.output.includes('2. National Strategy (2 sources) [6]'));
  assert.deepEqual(r.items.map((i) => i.id), [5, 6]);
  assert.equal(B.briefTopicReply('kaggle', { items: [] }).output, 'Your feed has nothing on kaggle yet.');
});

test('topic brief pages: 6 rows asked, 5 shown, "more" shows 6-10 numbered on', () => {
  assert.equal(B.briefTopicLimit(0), '6');
  assert.equal(B.briefTopicLimit(1), '11');
  const mk = (k) => Array.from({ length: k }, (_, i) => ({ n: i + 1, id: 10 + i, title: 'T' + (i + 1), score: 5 }));
  const p0 = B.briefTopicReply('mcp', { items: mk(6) }, 0);
  assert.ok(p0.output.startsWith('Best on mcp:'));
  assert.ok(p0.output.endsWith('Say "more" for the next 5.'));
  assert.equal(p0.items.length, 5);
  const p1 = B.briefTopicReply('mcp', { items: mk(8) }, 1);
  assert.ok(p1.output.startsWith('More on mcp:'));
  assert.deepEqual(p1.items.map((i) => i.n), [6, 7, 8]);
  assert.ok(!p1.output.includes('Say "more"'));
  // "more" after it is a topic page; the agent's copy of the layout is not
  assert.equal(B.briefAsk('more', p0.output).topic_more, true);
  assert.equal(B.briefTopicReply('mcp', { items: mk(5) }, 1).output, 'That was everything on mcp.');
});
