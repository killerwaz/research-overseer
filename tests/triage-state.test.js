const test = require('node:test');
const assert = require('node:assert');
const { FAILED, MAX_TRIAGE_FAILURES, backlogHaving, runSummaryText } = require('../shared/triage-state.js');

test('backlog takes failed docs until they run out of tries', () => {
  const h = backlogHaving();
  assert.match(h, /^count\(f\.id\) <> 1 or /);   // never triaged / fan-out rows, as before
  assert.ok(h.includes("bool_or(f.summary = '" + FAILED + "')"));
  assert.ok(h.includes('max(rd.triage_failures) < ' + MAX_TRIAGE_FAILURES));
  assert.strictEqual(MAX_TRIAGE_FAILURES, 3);
});

test('a failed page is never reported as summarized', () => {
  // the review's repro: one page, its triage failed -> "Found 1 new page, all summarized."
  const t = runSummaryText({ made: 0, unsummarized: 1, retry: true });
  assert.ok(!/all summarized/.test(t));
  assert.strictEqual(t, "\u{1F52D} Saved 1 new page but couldn't summarize it (the model gave no usable answer). I will retry automatically.");
  assert.match(runSummaryText({ unsummarized: 2 }), /summarize them .* Say "fix feed" and I will retry\.$/);
});

test('mixed runs say how many were summarized', () => {
  assert.strictEqual(runSummaryText({ made: 3, unsummarized: 1, unread: 2, retry: true }),
    "\u{1F52D} Found 4 new pages, 3 summarized. 1 couldn't be summarized (the model gave no usable answer). I will retry automatically. 2 others couldn't be read.");
});

test('the old wordings are unchanged when nothing failed triage', () => {
  assert.strictEqual(runSummaryText({ made: 2 }), '\u{1F52D} Found 2 new pages, all summarized.');
  assert.strictEqual(runSummaryText({ made: 1, unread: 1 }), "\u{1F52D} Found 1 new page, all summarized. 1 other couldn't be read.");
  assert.strictEqual(runSummaryText({ unread: 3 }), "\u{1F52D} Nothing added. 3 pages couldn't be read.");
  assert.strictEqual(runSummaryText({}), '\u{1F52D} Nothing new — everything found was already in your feed.');
});

test('drain report: retried pages that worked, and ones given up after 3 tries', () => {
  const T = require('../shared/triage-state.js');
  assert.equal(T.drainReportText([], []), '');
  const r = T.drainReportText([{ title: 'Bangladesh Bank <AI> rules', score: 7 }], []);
  assert.ok(r.startsWith('\u{1F4C4} Summarized at last (the earlier try failed):\n• Bangladesh Bank &lt;AI&gt; rules [7]'));
  const g = T.drainReportText([], [{ title: 'Scanned report' }, { title: 'Slides' }]);
  assert.ok(g.includes("couldn't summarize these pages after 3 tries"));
  assert.ok(g.includes('• Slides'));
  assert.equal(T.drainReportSql([]), 'select null::text as recovered, null::text as given_up');
  const s = T.drainReportSql([5, 'x', 9]);
  assert.ok(s.includes('raw_doc_id in (5,9)'));
  assert.ok(s.includes('triage_failures >= 3'));
});
