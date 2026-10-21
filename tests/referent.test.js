const test = require('node:test');
const assert = require('node:assert');
const { unsupportedFacts } = require('../shared/answer-check.js');
global.unsupportedFacts = unsupportedFacts;   // inlined before referent.js in the workflows
const { referentKind, refRoute, refNote, plainText, botSaidSql, itemBody, itemAnswer, plainSummary } = require('../shared/referent.js');
const { bigPictureQ } = require('../shared/synth.js');

test('messages that point at one thing already shown', () => {
  for (const t of ['summarize the video without the timestamps', 'summarize the video', 'Summarise this video please',
    'what does it say about pricing?', 'tl;dr it', 'explain that', 'tell me more about it', 'is it any good?',
    'summarize without timestamps', 'shorter please', 'summarize it in 3 bullets', 'can you recap that article',
    'rewrite the summary without links', 'what did the last one say', 'redo it in plain english', 'Summarize'])
    assert.strictEqual(referentKind(t), 'bare', t);
});

test('a shown thing picked by description goes to the agent', () => {
  for (const t of ['summarize the article about nvidia', 'the video from IBM, what did it say', 'tell me about the one on MCP'])
    assert.strictEqual(referentKind(t), 'described', t);
});

test('topics, plurals, links and ordinary questions are not references', () => {
  for (const t of ['summarize the videos about agents', 'summarize AI funding this week', "what's happening with MCP",
    'summary of nvidia export controls', 'is it worth it to switch to Qwen?', 'compare openai and anthropic',
    'https://youtu.be/cLqtxkYrMDI', 'summarize https://example.com/a', 'anything on stablecoins', 'yes', '#3', ''])
    assert.strictEqual(referentKind(t), '', t);
});

const MIXED = [{ title: 'Sourdough', url: 'https://littlespoonfarm.com/x' }, { title: 'Qwen3.8', url: 'https://www.youtube.com/watch?v=cLqtxkYrMDI' },
  { title: 'Starter', url: 'https://example.com/s' }];

test('route: one recent item -> answered in code; several -> agent; stale or none -> normal', () => {
  const q = 'summarize the video without the timestamps';
  assert.deepStrictEqual(refRoute(q, { n: 1, age_min: 3 }), { route: 'item', n: 1 });
  assert.deepStrictEqual(refRoute(q, { n: 6, age_min: 3 }), { route: 'agent' });
  assert.deepStrictEqual(refRoute('summarize the article about nvidia', { n: 1, age_min: 3 }), { route: 'agent' });
  assert.deepStrictEqual(refRoute(q, { n: 1, age_min: 500 }), { route: '' });
  assert.deepStrictEqual(refRoute(q, { n: 0, age_min: 1 }), { route: '' });
  assert.deepStrictEqual(refRoute(q, null), { route: '' });
  assert.deepStrictEqual(refRoute('summarize AI funding', { n: 1, age_min: 1 }), { route: '' });
});

test('"the video" in a mixed list means its only video', () => {
  assert.deepStrictEqual(refRoute('summarize the video', { items: MIXED, age_min: 2 }), { route: 'item', n: 2 });
  assert.deepStrictEqual(refRoute('summarize the article', { items: MIXED, age_min: 2 }), { route: 'agent' });
  const two = [...MIXED, { title: 'Other', url: 'https://youtu.be/abc' }];
  assert.deepStrictEqual(refRoute('summarize the video', { items: two, age_min: 2 }), { route: 'agent' });
});

test('the agent is told the list it is pointing into', () => {
  assert.match(refNote({ items: MIXED }), /1\. Sourdough; 2\. Qwen3\.8; 3\. Starter/);
  assert.match(refNote({ items: MIXED }), /get_item/);
});

test('the 18 Oct message no longer reaches synth once a list is recent', () => {
  const q = 'summarize the video without the timestamps';
  assert.ok(bigPictureQ(q), 'synth regex still matches on its own; refRoute must run first');
  assert.strictEqual(refRoute(q, { n: 1, age_min: 2 }).route, 'item');
});

test('memory text is what he read, without HTML', () => {
  assert.strictEqual(plainText('🎬 <b>Qwen &amp; Opus</b>\n• <a href="x">1:02</a> point'), '🎬 Qwen & Opus\n• 1:02 point');
});

test('botSaidSql tags the row, base64s the text, and records the list', () => {
  const sql = botSaidSql('999000002', '<b>$785606.5 it\'s</b>', [537], 'media');
  assert.match(sql, /'source', 'media'/);
  assert.ok(!sql.includes('785606'), 'text travels base64');
  assert.ok(sql.includes(Buffer.from("$785606.5 it's").toString('base64')));
  assert.match(sql, /array\[537\]::bigint\[\]/);
  assert.match(botSaidSql('999000002', 'no captions', [], 'media'), /^insert into n8n_chat_histories .* returning id$/);
  assert.strictEqual(botSaidSql('', 'x', [1]), 'select 1 as skipped');
  assert.strictEqual(botSaidSql('1', '', [1]), 'select 1 as skipped');
});

const ITEM = { id: 537, title: 'Qwen3.8 27B + DeepSeek Harness BEATS Opus 4.6', summary: 'Benchmarks Qwen3.8 27B on a 24 GB GPU against Opus 4.6.',
  structured: { key_points: [{ t: '1:02', point: 'Unsloth Studio quantises the model' }, { t: '5:40', point: 'The Minecraft clone works' }] } };

test('item body carries the request and the points without times', () => {
  const b = itemBody('qwen/qwen3.5-9b', 'summarize without timestamps', ITEM);
  assert.strictEqual(b.reasoning_effort, 'none');
  const u = b.messages[1].content;
  assert.match(u, /without timestamps/);
  assert.match(u, /- Unsloth Studio quantises the model/);
  assert.ok(!u.includes('1:02'));
});

test('itemAnswer keeps a faithful answer, falls back on invented figures or empty output', () => {
  assert.strictEqual(itemAnswer('Qwen3.8 27B ran on a 24 GB GPU and matched Opus 4.6.', ITEM, 'summarize').fallback, '');
  const bad = itemAnswer('It scored 92% on SWE-bench.', ITEM, 'summarize');
  assert.strictEqual(bad.fallback, 'unsupported figures');
  assert.strictEqual(bad.output, plainSummary(ITEM));
  assert.ok(!bad.output.includes('1:02'), 'fallback has no timestamps either');
  assert.strictEqual(itemAnswer('', ITEM, 'x').fallback, 'empty');
});

const { itemLookupSql, answerMessage } = require('../shared/referent.js');

test('a link instruction looks its item up with both texts base64, never as literals', () => {
  const sql = itemLookupSql("https://www.youtube.com/watch?v=x'1", 'cost $785606.5? no timestamps');
  assert.ok(!sql.includes("x'1") && !sql.includes('785606'));
  assert.ok(sql.includes(Buffer.from('cost $785606.5? no timestamps').toString('base64')));
  assert.match(sql, /from feed_items f where f\.canonical_url = convert_from/);
  assert.match(sql, /doc_chunks/);
});

test('the answer message carries the title and escapes the answer', () => {
  assert.strictEqual(answerMessage({ title: 'A & B' }, 'x < y'), '\u{1F3AC} <b>A &amp; B</b>\n\nx &lt; y');
});

test('exchangeSql: both memory rows, text as base64, bad chat id refused', () => {
  const { exchangeSql } = require('../shared/referent.js');
  const s = exchangeSql(-42, 'save #3', 'Saved $785606.5 note');
  assert.ok(s.startsWith("insert into n8n_chat_histories (session_id, message) values ('-42', jsonb_build_object('type', 'human'"));
  assert.ok(s.includes("'type', 'ai'"));
  assert.ok(!s.includes('785606'));
  assert.equal(exchangeSql('1; drop', 'a', 'b'), 'select 1 as skipped');
});
