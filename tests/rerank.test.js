const test = require('node:test');
const assert = require('node:assert');
const { switchesFrom, rerankCandidates, rerankLlmBody, parseLlmScores, applyRerank, isPassingMention, RERANK_TOP } = require('../shared/rerank.js');

const row = (id, o) => Object.assign({ id, topic: 't', title: 'T' + id, summary: 'S' + id }, o);

test('switchesFrom reads the settings, unknown = off', () => {
  assert.deepStrictEqual(switchesFrom({}), { two: false, rerank: 'off', mentions: false, check: false });
  assert.deepStrictEqual(switchesFrom({ fix_two_passages: 'true', fix_rerank: 'llm', fix_mentions: 'true', fix_answer_check: 'true' }),
    { two: true, rerank: 'llm', mentions: true, check: true });
  assert.strictEqual(switchesFrom({ fix_rerank: 'yes' }).rerank, 'off');
});

test('rerankCandidates takes listed rows only, up to the mode limit, 2 passages when asked', () => {
  const rows = [row(1, { ptext: 'a', ptext2: 'a2' }), row(2, { outside: true, ptext: 'x' }), row(3, {}), ...Array.from({ length: 10 }, (_, k) => row(10 + k, { ptext: 'p' }))];
  const one = rerankCandidates(rows, 'model', false);
  assert.strictEqual(new Set(one.map.map((m) => m.row)).size, RERANK_TOP.model);
  assert.ok(!one.map.some((m) => m.row === 1)); // outside row skipped
  assert.strictEqual(one.docs[1], 'T3\nS3');     // summary-only row offers title + summary
  const two = rerankCandidates(rows, 'model', true);
  assert.deepStrictEqual(two.map.slice(0, 2), [{ row: 0, which: 1 }, { row: 0, which: 2 }]);
  assert.deepStrictEqual(rerankCandidates(rows, 'off', true), { docs: [], map: [] });
});

test('LLM scores parse to 0..1 and must match the count', () => {
  assert.deepStrictEqual(parseLlmScores({ content: '{"scores":[10,5,0]}' }, 3), [1, 0.5, 0]);
  assert.strictEqual(parseLlmScores({ content: '{"scores":[10]}' }, 3), null);
  assert.strictEqual(parseLlmScores({ content: 'nope' }, 1), null);
  const b = rerankLlmBody('m', 'q?', ['x'.repeat(5000), 'y']);
  assert.strictEqual(b.reasoning_effort, 'none');
  assert.ok(b.messages[1].content.length < 2600);
});

test('applyRerank reorders reranked rows and swaps in the better second passage', () => {
  const rows = [row(1, { ptext: 'p1', pn: 1, ptext2: 'p1b', pn2: 4 }), row(2, { ptext: 'p2', pn: 2 }), row(3, { ptext: 'p3', pn: 3 })];
  const map = [{ row: 0, which: 1 }, { row: 0, which: 2 }, { row: 1, which: 1 }];
  const out = applyRerank(rows, map, [0.1, 0.3, 0.9]);
  assert.deepStrictEqual(out.map((r) => r.id), [2, 1, 3]);   // row 3 was not reranked: keeps its place
  assert.strictEqual(out[1].ptext, 'p1b'); assert.strictEqual(out[1].pn, 4); assert.strictEqual(out[1].rr, 0.3);
  assert.strictEqual(applyRerank(rows, map, null), rows);    // reranker down = unchanged
});

test('passing mention = found only in text and the passage does not answer', () => {
  assert.strictEqual(isPassingMention({ ptext: 'x', sim: 0.2, psim: 0.29 }), true);           // "weather in Dhaka"
  assert.strictEqual(isPassingMention({ ptext: 'x', sim: 0.2, psim: 0.31, rr: 0.98 }), false); // Harvey table, reranked
  assert.strictEqual(isPassingMention({ ptext: 'x', sim: 0.2, psim: 0.6 }), false);
  assert.strictEqual(isPassingMention({ ptext: 'x', kw_hit: true, psim: 0.1 }), false);        // summary keyword match
  assert.strictEqual(isPassingMention({ sim: 0.1 }), false);
});
