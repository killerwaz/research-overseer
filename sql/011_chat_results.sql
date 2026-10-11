-- The last result list each chat was shown, so a follow-up can name an item
-- by its number instead of re-searching.
--
-- Before this, "tell me more about the first one" made the router run a fresh
-- query_feed with whatever keywords it guessed — usually tighter than the list
-- it was following up on, so it came back empty (2026-10-09: a 20-item
-- Bangladesh list, then "no recent high-quality items"). WF-31 now numbers
-- every result (n = 1, 2, 3...) and stores the ids here; get_item resolves
-- n against this row. Server-side, so it does not depend on the 9B carrying
-- ids through its memory, which Tidy memory strips anyway.
--
-- One row per chat, overwritten by every list: "the first one" always means
-- the first item of the most recent list, which is what a person means too.

create table if not exists chat_results (
  chat_id    bigint primary key,
  item_ids   bigint[] not null,
  topic      text,
  created_at timestamptz not null default now()
);
