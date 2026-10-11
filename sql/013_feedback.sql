-- 👍/👎 on feed items (2026-10-11).
--
-- One vote per item: tapping again replaces it, so the row is the latest
-- opinion, not a history. Votes land on whatever item the message showed —
-- for a deduped story that is its representative (sql/012), which is the
-- row triage's examples are read from.
--
-- Used two ways: the Telegram buttons write here (WF-00), and every triage
-- reads the most recent likes and dislikes as calibration examples
-- (shared/feedback.js tasteBlock) — few-shot preference examples, the
-- cheapest personalisation that needs no training.

create table if not exists feedback (
  feed_item_id bigint primary key references feed_items(id) on delete cascade,
  vote         smallint not null check (vote in (-1, 1)),
  chat_id      bigint,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists feedback_updated_idx on feedback (updated_at desc);
