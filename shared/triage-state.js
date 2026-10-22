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

// After a WF-30 drain pass, for the pages he was TOLD had failed ("I will retry
// automatically"): the retry worked (recovered) or the last try failed (givenUp).
// Never-failed orphans stay silent, as before. rows: [{ title, score }]. '' = no message.
function drainReportText(recovered, givenUp) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const line = (r) => '• ' + esc(String(r.title || r.canonical_url || 'untitled').slice(0, 120)) + (r.score != null ? ' [' + r.score + ']' : '');
  const rec = recovered || [], gone = givenUp || [];
  const out = [];
  if (rec.length) out.push('\u{1F4C4} Summarized at last (the earlier try failed):\n' + rec.map(line).join('\n') + '\nThey are in your feed now: ask about them, or say "brief me".');
  if (gone.length) out.push("\u{26A0} I couldn't summarize " + (gone.length === 1 ? 'this page' : 'these pages') + ' after ' + MAX_TRIAGE_FAILURES +
    ' tries, so I stopped retrying. ' + (gone.length === 1 ? 'It stays' : 'They stay') + ' saved, without a summary:\n' + gone.map(line).join('\n'));
  return out.join('\n\n');
}

// One row back for the drained doc ids that had failed before: recovered and given up.
function drainReportSql(docIds) {
  const ids = (docIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return 'select null::text as recovered, null::text as given_up';
  const list = ids.join(',');
  return "select (select json_agg(json_build_object('title', f.title, 'score', f.score))::text from feed_items f where f.raw_doc_id in (" + list + ") and f.summary is distinct from '" + FAILED + "') as recovered, " +
    "(select json_agg(json_build_object('title', coalesce(f.title, rd.title), 'score', null))::text from raw_docs rd join feed_items f on f.raw_doc_id = rd.id where rd.id in (" + list + ") and f.summary = '" + FAILED + "' and rd.triage_failures >= " + MAX_TRIAGE_FAILURES + ') as given_up';
}

module.exports = { FAILED, MAX_TRIAGE_FAILURES, backlogHaving, runSummaryText, drainReportText, drainReportSql };
