const test = require('node:test');
const assert = require('node:assert');
const F = require('../shared/feed-fit.js');

const LIVE = 'The feed has 10 items on products using the reverse engineer anything repo. Here are the top ones:\n\n' +
  '1. GitHub - NabilRFG12/Reverse-Engineer-anything — Open-source project. Score 8.\n\n2. Reverse Engineer Anything | MindStudio — framework. Score 5.\n\n' +
  '3. GitHub - morluto/awesome-reverse-engineering — list. Score 3.\n\n4. REA GitHub Repository - Geeky Gadgets — profile. Score 3.\n\n' +
  '5. GitHub - zane-programs/reversing-with-claude-code — talk. Score 8.\n\n6. reverse-engineer-anything · GitHub Topics — listing. Score 2.\n\n7. GitHub - 0xfroOty/rea — CLI. Score 7.';

test('fixCount says how many are shown when the intro claims more', () => {
  const out = F.fixCount(LIVE);
  assert.match(out, /^The feed has 10 matches \(7 shown\) on products using/);
  assert.strictEqual(out.split('\n').slice(1).join('\n'), LIVE.split('\n').slice(1).join('\n'), 'the list itself is untouched');
});

test('fixCount leaves matching counts, unlisted replies and list-body numbers alone', () => {
  const twenty = 'Found 3 items on MCP security. Here are the best ones:\n\n1. A — x\n2. B — y\n3. C — z';
  assert.strictEqual(F.fixCount(twenty), twenty);
  assert.strictEqual(F.fixCount('Argentina won in 2022 after 3 items of extra time.'), 'Argentina won in 2022 after 3 items of extra time.');
  const body = 'Here are the best ones:\n\n1. A — 81.7% of 200 items\n2. B — y';
  assert.strictEqual(F.fixCount(body), body);
});

test('evidenceText flattens WF-31 evidence shapes', () => {
  assert.strictEqual(F.evidenceText({ text: 'ClickHouse acquires Langfuse' }), 'ClickHouse acquires Langfuse');
  assert.strictEqual(F.evidenceText([{ text: 'a' }, { text: 'b' }]), 'a … b');
  assert.strictEqual(F.evidenceText({ fragments: ['x', 'y'] }), 'x … y');
  assert.strictEqual(F.evidenceText(null), '');
});

test('shownFeedItems finds the listed items in the tool steps, in reply order', () => {
  const steps = [{ action: { tool: 'query_feed' }, observation: JSON.stringify({ count: 3, items: [
    { n: 1, id: 11, title: 'One', summary: 's1', evidence: { text: 'e1' } },
    { n: 2, id: 12, title: 'Two', summary: 's2' },
    { n: 3, id: 13, title: 'Three', summary: 's3' }] }) }];
  const got = F.shownFeedItems('Here:\n3. Three — z\n1. One — x', steps);
  assert.deepStrictEqual(got.map((i) => i.n), [3, 1]);
  assert.strictEqual(got[1].evidence, 'e1');
});

test('relationQ picks "things built with / using X", not topics or facts', () => {
  for (const q of ['anything on products using reverse engineer anything github repo?', 'top 5 apps people built with REA',
    'find me the top 5 products that have used no. 2 to build other products.', 'which companies are using LangGraph in production?',
    'which startups are building on n8n?', 'which banks in Bangladesh are using AI?']) assert.ok(F.relationQ(q), q);
  for (const q of ['anything on MCP security?', 'Who bought Langfuse?', 'how are companies handling the cost of GPUs?',
    'How many marketing teams call AI adoption their top priority?', 'tools for agent evaluation',
    'What do companies exporting AI chips to China have to certify about their customers?']) assert.ok(!F.relationQ(q), q);
});

test('readNamed accepts a named, quoted thing and rejects the subject, forks and made-up quotes', () => {
  const q = 'which companies are using LangGraph in production?';
  const snyk = { title: 'How Snyk Turned an Internal Support Agent into a Customer Feature', summary: '',
    evidence: 'Snyk productized an internal support agent into a customer-facing feature using LangGraph for orchestration.' };
  const ok = JSON.stringify({ subject: 'LangGraph', names_one: true, name: 'Snyk', quote: 'Snyk productized an internal support agent into a customer-facing feature using LangGraph for orchestration' });
  assert.strictEqual(F.readNamed(ok, snyk, q), 'Snyk');
  const madeUp = JSON.stringify({ subject: 'LangGraph', names_one: true, name: 'Snyk', quote: 'Snyk runs LangGraph for every customer in production today' });
  assert.strictEqual(F.readNamed(madeUp, snyk, q), null);
  const rea = 'anything on products using reverse engineer anything github repo?';
  const fork = { title: 'GitHub - NabilRFG12/Reverse-Engineer-anything: Reverse engineer anything with agents', summary: '', evidence: '' };
  const self = JSON.stringify({ subject: 'reverse engineer anything', names_one: true, name: 'Reverse-Engineer-anything', quote: 'GitHub - NabilRFG12/Reverse-Engineer-anything: Reverse engineer anything with agents' });
  assert.strictEqual(F.readNamed(self, fork, rea), null);
  assert.strictEqual(F.readNamed(JSON.stringify({ subject: 'LangGraph', names_one: false, name: '', quote: '' }), snyk, q), null);
  assert.strictEqual(F.readNamed('not json', snyk, q), null);
});

test('readNamed rejects an item that never mentions the subject (the Aula keyboard, 2026-10-18)', () => {
  const rea = 'anything on products using reverse engineer anything github repo?';
  const aula = { title: 'AI Borked my Keyboard - Reversing the Aula F108 Pro Software', summary: 'Practitioners can use LLMs with MCP tooling to automate low-level reverse engineering tasks.',
    evidence: 'I used Claude with Ghidra over MCP to reverse engineering the Aula F108 Pro configuration software.' };
  const v = JSON.stringify({ subject: 'reverse engineer anything github repo', names_one: true, name: 'Aula F108 Pro',
    quote: 'I used Claude with Ghidra over MCP to reverse engineering the Aula F108 Pro configuration software.' });
  assert.strictEqual(F.readNamed(v, aula, rea), null);
  const invented = JSON.stringify({ subject: 'Ghidra', names_one: true, name: 'Aula F108 Pro',
    quote: 'I used Claude with Ghidra over MCP to reverse engineering the Aula F108 Pro configuration software.' });
  assert.strictEqual(F.readNamed(invented, aula, rea), null, 'a subject that is not in the question');
});

test('an acronym subject matches its spelled-out form in the item', () => {
  const q = 'which companies use MCP in production?';
  const mcp = { title: 'Introducing the Model Context Protocol \\ Anthropic', summary: '',
    evidence: 'Early adopters like Block and Apollo have integrated MCP into their systems.' };
  const v = JSON.stringify({ subject: 'MCP', names_one: true, name: 'Block', quote: 'Early adopters like Block and Apollo have integrated MCP into their systems.' });
  assert.strictEqual(F.readNamed(v, mcp, q), 'Block');
  const noMention = { title: 'Introducing the Model Context Protocol', summary: '', evidence: 'Early adopters like Block and Apollo joined the program.' };
  const v2 = JSON.stringify({ subject: 'MCP', names_one: true, name: 'Block', quote: 'Early adopters like Block and Apollo joined the program.' });
  assert.strictEqual(F.readNamed(v2, noMention, q), 'Block', 'the title spells it out');
});

test('readFit: no yes = a miss; unreadable = null', () => {
  assert.deepStrictEqual(F.readFit(JSON.stringify({ items: [{ n: 1, fits: 'no' }, { n: 2, fits: 'partly' }], gap: 'they cover the repo itself.' })),
    { answers: false, yes: 0, partly: 1, no: 1, gap: 'they cover the repo itself' });
  assert.strictEqual(F.readFit(JSON.stringify({ items: [{ n: 1, fits: 'yes' }], gap: '' })).answers, true);
  assert.strictEqual(F.readFit('{"items": []}'), null);
  assert.strictEqual(F.readFit('oops'), null);
});

test('fitBody and namedBody keep thinking off and carry the passage', () => {
  const item = { n: 1, title: 'T', summary: 'S', evidence: 'ClickHouse acquires Langfuse' };
  const f = F.fitBody('m', 'Who bought Langfuse?', [item]);
  assert.strictEqual(f.reasoning_effort, 'none');
  assert.match(f.messages[1].content, /Passage: ClickHouse acquires Langfuse/);
  const n = F.namedBody('m', 'which companies use X?', item);
  assert.strictEqual(n.reasoning_effort, 'none');
  assert.match(n.messages[1].content, /Passage: ClickHouse/);
});
