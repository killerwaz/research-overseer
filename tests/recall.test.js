const test = require('node:test');
const assert = require('node:assert');
const R = require('../shared/recall.js');

const VEC = '[' + new Array(1024).fill(0.01).join(',') + ']';

test('the stored text is the exchange as he saw it', () => {
  assert.equal(R.memoryDoc('who bought langfuse?', 'ClickHouse, in January 2026.'), 'You: who bought langfuse?\nBot: ClickHouse, in January 2026.');
  assert.ok(R.memoryDoc('q', 'x'.repeat(5000)).length <= 2000);
});

test('taps and empty replies are not remembered', () => {
  assert.equal(R.shouldRemember('cb:fb:12:1', 'saved'), false);
  assert.equal(R.shouldRemember('hello', ''), false);
  assert.equal(R.shouldRemember('hello', '(empty reply)'), false);
  assert.equal(R.shouldRemember('who founded Pathao?', 'Hussain Elius [1].'), true);
});

test('remember SQL carries text as base64 and refuses a bad chat id', () => {
  const s = R.rememberSql(-1001, "costs $785606.5 'quoted'", 'answer', VEC);
  assert.ok(!s.includes('$785606'), 'raw web text must not reach the query');
  assert.ok(s.startsWith('insert into chat_memory'));
  assert.ok(s.includes("'::vector"));
  assert.equal(R.rememberSql('12; drop table x', 'q', 'a', VEC), 'select 1 as skipped');
  assert.ok(R.rememberSql(5, 'q', 'a', null).includes('null)'));
});

test('recall SQL filters by chat and cutoff, and degrades without a vector', () => {
  const s = R.recallSql('42', VEC);
  assert.ok(s.includes('where chat_id = 42'));
  assert.ok(s.includes('r.sim >= 0.5'));
  assert.equal(R.recallSql('42', null), 'select null::text as rows');
  assert.equal(R.recallSql('x', VEC), 'select null::text as rows');
});

test('the note shows the date and question, and is empty without hits', () => {
  assert.equal(R.recallNote(null), '');
  assert.equal(R.recallNote('[]'), '');
  const n = R.recallNote(JSON.stringify([{ day: '13 Oct', question: "who's husssain elius of pathao", answer: 'From the web (not your feed): Hussain Elius founded Pathao in 2015 [1].', sim: 0.59 }]));
  assert.ok(n.startsWith('[earlier chats with this user'));
  assert.ok(n.includes('(13 Oct) You: who\'s husssain elius of pathao | Bot: From the web'));
  assert.ok(n.includes('say when'));
});

test('a reply counts as using recall only when it says so and there was a hit', () => {
  assert.equal(R.usesRecall('On 13 Oct I told you Hussain Elius founded Pathao.', 1), true);
  assert.equal(R.usesRecall('Earlier you asked about Anchorless: Rahat Ahmed runs it.', 2), true);
  assert.equal(R.usesRecall('Hussain Elius founded Pathao.', 1), false);
  assert.equal(R.usesRecall('On 13 Oct I told you so.', 0), false);
});

test('an answer built on an earlier chat that answered goes to the judge, not straight to the web', () => {
  const { needsWeb } = require('../shared/web-fallback.js');
  const noAns = (r) => needsWeb({ question: r.question, reply: r.answer }).web;
  const pathao = [{ day: '13 Oct', question: "who's husssain elius of pathao", answer: 'From the web (not your feed): Hussain Elius is a serial entrepreneur and the founder of Pathao [1].' }];
  const reply = 'On 13 Oct I told you from the web that Hussain Elius co-founded Pathao in March 2015. Your feed doesn\u2019t have this topic.';
  assert.equal(needsWeb({ question: 'who founded Pathao again?', reply }).web, true, 'the wording rule alone would send it');
  assert.equal(R.answeredFromRecall(reply, pathao, noAns), true);
  // a recalled "nothing found" is no answer: the web may still help
  const mod = [{ question: 'i want to know more about the You Should Know mod', answer: 'The feed has nothing on "You Should Know mod" right now.' }];
  assert.equal(R.answeredFromRecall('On 13 Oct I told you the feed had nothing on it. The feed still has nothing.', mod, noAns), false);
  // the reply must actually use the recall
  assert.equal(R.answeredFromRecall('Your feed has nothing on Pathao.', pathao, noAns), false);
});

test('a question about past chats with nothing recalled says there is no record', () => {
  assert.ok(R.recallNote([], 'what did we discuss about nvidia earnings?').includes('none match'));
  assert.ok(R.recallNote(null, 'remind me what you said about the Paystack acquisition').includes('no record'));
  assert.equal(R.recallNote([], 'anything on nvidia earnings?'), '');
});

test('questions about this chat are recognised (never sent to the web)', () => {
  for (const q of ['what did you tell me about openai funding?', 'what did we discuss about nvidia earnings?', 'remind me what you said about the Paystack acquisition', 'did I ask about Pathao?'])
    assert.equal(R.asksHistory(q), true, q);
  for (const q of ['who bought langfuse?', 'what is the capital of Peru?', 'tell me about #3', 'can you tell me how tall Everest is?',
    'could you tell me who bought langfuse?', 'what have you found on nvidia?', 'what did you find on bangladesh bank?'])
    assert.equal(R.asksHistory(q), false, q);
});
