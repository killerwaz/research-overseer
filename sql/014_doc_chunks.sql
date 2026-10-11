-- Passage search inside full articles (#12, 2026-10-12).
--
-- feed_items.embedding (sql/010) covers what an item is ABOUT: title, summary,
-- angle, tags. A question whose answer sits in the body ("who led Baseten's
-- round?") cannot reach it. Each saved page is now cleaned and cut into
-- ~2,500-char passages (shared/chunk.js) and each passage is embedded with
-- the article title in front of it, so "the company raised $2B" still knows
-- which company.
--
-- Written by WF-21 after triage (replaced per doc, so re-triage never
-- duplicates) and backfilled by scripts/backfill-chunks.js. Keyed on the raw
-- doc, not the feed item: the item row is replaced on every re-triage, the
-- page is not. Deleting the page (WF-20 'replace') deletes its passages.
--
-- start_s: seconds into the video/podcast where the passage starts (media
-- docs only), so an answer can link to the moment.
--
-- No index: ~2,700 rows at the backfill, an exact scan takes milliseconds.
-- Add HNSW past ~20k rows, as with feed_items.

create table if not exists doc_chunks (
  raw_doc_id  bigint not null references raw_docs(id) on delete cascade,
  n           int not null,
  text        text not null,
  start_s     int,
  embedding   vector(1024),
  created_at  timestamptz not null default now(),
  primary key (raw_doc_id, n)
);
