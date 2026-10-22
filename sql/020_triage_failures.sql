-- Failed triage is retried (2026-10-22, code review finding 3). WF-21 bumps this
-- each time it stores a TRIAGE_FAILED row; the WF-30 drain re-triages a failed
-- doc until it reaches 3 (shared/triage-state.js), so a page the model can never
-- read stops costing GPU time instead of being retried every 5 minutes forever.
-- Before this, the drain only took docs without exactly one feed row, and a
-- failed doc has exactly one: item 450 had sat failed since 2026-10-09.

alter table raw_docs add column if not exists triage_failures int not null default 0;
