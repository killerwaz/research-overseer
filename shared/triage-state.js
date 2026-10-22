// A failed triage, from storage to retry to the run message (sql/020, 2026-10-22).
//
// When the model gives no usable answer twice, WF-21 still stores a feed row —
// summary 'TRIAGE_FAILED', no axes, score 0 — so the page is never dropped, and
// bumps raw_docs.triage_failures. Code review finding 3: the drain's backlog was
// "docs without exactly one feed row", so a failed doc (one row) was never
// retried, and the run message counted it as summarized.
//
// Inlined into WF-20's Compose summary; FAILED / backlogHaving are used by the
// build scripts for SQL.

const FAILED = 'TRIAGE_FAILED';
const MAX_TRIAGE_FAILURES = 3;

// HAVING clause for `raw_docs rd left join feed_items f on f.raw_doc_id = rd.id
// group by rd.id`: never triaged, stale fan-out rows, or failed with tries left.
function backlogHaving() {
  return "count(f.id) <> 1 or (bool_or(f.summary = '" + FAILED + "') and max(rd.triage_failures) < " + MAX_TRIAGE_FAILURES + ')';
}

// The first line of the run message. made = pages summarized, unsummarized =
// pages saved with a failed triage, unread = pages that could not be scraped.
// retry = the drain is on, so failed pages are retried without asking.
function runSummaryText({ made = 0, unsummarized = 0, unread = 0, retry = false } = {}) {
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const later = retry ? 'I will retry automatically.' : 'Say "fix feed" and I will retry.';
  const unreadNote = unread ? ' ' + plural(unread, made + unsummarized ? 'other' : 'page') + " couldn't be read." : '';
  if (!made && !unsummarized) {
    return unread ? '\u{1F52D} Nothing added.' + unreadNote : '\u{1F52D} Nothing new — everything found was already in your feed.';
  }
  if (!unsummarized) return '\u{1F52D} Found ' + plural(made, 'new page') + ', all summarized.' + unreadNote;
  const them = unsummarized === 1 ? 'it' : 'them';
  if (!made) {
    return '\u{1F52D} Saved ' + plural(unsummarized, 'new page') + " but couldn't summarize " + them +
      ' (the model gave no usable answer). ' + later + unreadNote;
  }
  return '\u{1F52D} Found ' + plural(made + unsummarized, 'new page') + ', ' + made + ' summarized. ' + unsummarized +
    " couldn't be summarized (the model gave no usable answer). " + later + unreadNote;
}

module.exports = { FAILED, MAX_TRIAGE_FAILURES, backlogHaving, runSummaryText };
