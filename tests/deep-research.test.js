const test = require('node:test');
const assert = require('node:assert');
// in n8n deep-checks.js and deep-research.js share one Code node; give the checks the same globals here
Object.assign(global, require('../shared/deep-checks.js'));
const D = require('../shared/deep-research.js');

test('hostOf works without URL (n8n Code nodes have none)', () => {
  assert.strictEqual(D.hostOf('https://www.github.com/morluto/rea'), 'github.com');
  assert.strictEqual(D.hostOf('http://rea.tools:8080/showcase'), 'rea.tools');
  assert.strictEqual(D.hostOf('not a url'), '');
});

test('the shipped source uses nothing an n8n Code node lacks', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'shared', 'deep-research.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['require(', 'fetch(', 'new URL', 'process.', 'Buffer.']) assert.ok(!src.includes(bad), bad);
});

test('subjectOnly: the subject and its mirrors, not things named after it', () => {
  const names = ['Reverse Engineer Anything', 'REA'];
  assert.ok(D.subjectOnly('REA GitHub repository', names, 'rea', 'morluto'));
  assert.ok(D.subjectOnly('morluto/rea', names, 'rea', 'morluto'));
  assert.ok(!D.subjectOnly('ReaCut', names, 'rea', 'morluto'));
  assert.ok(!D.subjectOnly('Ledger Reborn', names, 'rea', 'morluto'));
});

test('templates: built_with searches the showcase and GitHub, a claim looks for its original number', () => {
  const b = D.deepTemplates({ shape: 'built_with', search_name: 'REA', extra_queries: [] }, '2026-10-19');
  assert.ok(b.some((q) => /showcase/.test(q.q)) && b.some((q) => q.engine === 'brave' && /site:github\.com/.test(q.q)));
  const c = D.deepTemplates({ shape: 'is_claim_true', search_name: 'Klarna', claim: 'Klarna fired 700 people for AI', extra_queries: [] }, '2026-10-19');
  assert.ok(c.some((q) => /700 original announcement/.test(q.q)));
});

// The whole pipeline, offline: every search, page read and 9B call answered by a fake io.
function fakeIo() {
  const page = 'Ledger Reborn is a desktop accounting app. I used REA to investigate QuickBooks and rebuilt it as Ledger Reborn. It has 52 tests.';
  const calls = [];
  const lm = (name, user) => {
    if (name === 'plan') return { shape: 'built_with', search_name: 'REA', also_called: [], claim: '', a: '', b: '', axis: '', region: '', since: '',
      answer_is: 'products built with REA', not_answer: ['articles about REA'], extra_queries: [] };
    if (name === 'findings') return { findings: [{ entity: 'Ledger Reborn', finding: 'Ledger Reborn was rebuilt using REA.', quote: 'I used REA to investigate QuickBooks and rebuilt it as Ledger Reborn.', date: '2026-10-13', candidate: true },
      { entity: 'Ledger Reborn', finding: 'Ledger Reborn has 52 tests.', quote: 'It has 52 tests.', date: '2026-10-13', candidate: true },
      { entity: 'X', finding: 'made up', quote: 'this sentence is not on the page at all', date: '', candidate: true }] };
    if (name === 'relation') return { quote: 'rebuilt it as Ledger Reborn', relation: 'made_with' };
    if (name === 'verdict') return { verdict: 'supported', why: 'the page says so' };
    if (name === 'answer') return { headline: 'One product built with REA', verdict: 'Ledger Reborn was built with REA [1].', ranked_by: '',
      items: [{ name: 'Ledger Reborn', point: 'desktop accounting app with 52 tests', caveat: 'a preview release', sources: [1] }], limits: ['only one page read'], evidence_thin: true };
    throw new Error('unexpected format ' + name);
  };
  return { calls, io: {
    today: '2026-10-19', lmUrl: 'http://lm/v1/chat/completions', keys: { exa: 'e', brave: 'b', firecrawl: 'f', lmstudio: 'l' },
    http: async (req) => {
      calls.push(req.url);
      if (req.url.startsWith('http://lm')) {
        const name = req.body.response_format.json_schema.name;
        assert.strictEqual(req.body.reasoning_effort, 'none', 'thinking stays off');
        return { status: 200, body: { choices: [{ message: { content: JSON.stringify(lm(name, req.body.messages[1].content)) } }] } };
      }
      if (req.url.includes('exa.ai')) return { status: 200, body: { results: [{ url: 'https://github.com/someone/ledger-reborn/discussions/2198', title: 'Ledger Reborn', publishedDate: '2026-10-13', text: page.repeat(20) }] } };
      if (req.url.includes('brave.com')) return { status: 200, body: { web: { results: [] } } };
      if (req.url.includes('firecrawl')) return { status: 200, body: { data: { markdown: page.repeat(20), metadata: { title: 'page' } } } };
      throw new Error('unexpected url ' + req.url);
    } } };
}

test('deepResearch runs end to end on a fake io and cites only real sources', async () => {
  const { io, calls } = fakeIo();
  const progress = [];
  io.progress = async (s) => progress.push(s);
  const r = await D.deepResearch('top products built with REA', io);
  // the fake writer marks the evidence thin, so the headline must say so (shared/deep-checks.js hedgeHeadline)
  assert.match(r.reply, /^\*\*Evidence is thin: one product built with REA\*\*/);
  assert.match(r.reply, /1\. \*\*Ledger Reborn\*\*/);
  assert.deepStrictEqual(r.sources.map((s) => s.n), [1]);
  assert.match(r.reply, /Sources:\n\[1\] Ledger Reborn - https:\/\/github\.com\/someone\/ledger-reborn\/discussions\/2198/);
  assert.ok(r.trace.droppedQuotes >= 1, 'a quote not on the page is dropped');
  assert.ok(r.trace.rulings.confirmed.includes('Ledger Reborn'));
  assert.ok(progress.length >= 5 && /writing/.test(progress[progress.length - 1]));
  assert.ok(calls.some((u) => u.includes('exa.ai')));
});

test('deepResearch stops checking at the deadline and still answers', async () => {
  const { io } = fakeIo();
  io.deadline = Date.now() - 1;   // already late: no relation or fact checks
  const r = await D.deepResearch('top products built with REA', io);
  assert.strictEqual(r.trace.calls.relation, 0);
  assert.strictEqual(r.trace.calls.verify, 0);
  assert.ok(r.reply.length > 0);
});
