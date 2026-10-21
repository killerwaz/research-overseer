-- #17 Save to Obsidian (2026-10-21): which feed items he saved, and as which note.
-- "save #3" writes one markdown note into the vault folder mounted at /vault;
-- a second "save" of the same item answers "already in your vault" instead of
-- overwriting a note he may have written in.

create table if not exists saves (
  feed_item_id  bigint primary key references feed_items(id) on delete cascade,
  chat_id       bigint not null,
  file_name     text not null,
  saved_at      timestamptz not null default now()
);
