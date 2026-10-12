-- #14 long-term memory (2026-10-13).
--
-- chat_memory: every finished exchange (his message + the reply he actually saw),
-- embedded as one "You: ... / Bot: ..." text. WF-00 searches it by meaning before
-- the agent runs, so the bot can use what was said beyond its 10-exchange window.
-- Measured on his 33 exchanges: question+answer pairs beat the question alone
-- (18/19 vs 16/19 right at the top); cutoff 0.50 found 17/19, kept 13/14
-- never-discussed questions empty (shared/recall.js).
-- Starts from the memory fix (96d6932): older n8n_chat_histories rows can hold
-- the reply the bot rejected rather than the one he saw. His call.
--
-- vocab_words: every word in article text, feed titles/summaries and his chats,
-- for the spelling fixer in WF-31 (shared/spelling.js). One typo in a name broke
-- feed search 57/66 times; a blind fixer "fixed" 10/23 real names that are not
-- in the feed (paystack -> haystack), so a candidate from this list is only used
-- when the 9B says the typed word is a typo of it.
--
-- Function bodies are single-quoted, not $$: n8n's Postgres node (the SQL
-- runner) rejects $-runs.

create table if not exists chat_memory (
  id          bigint generated always as identity primary key,
  chat_id     bigint not null,
  question    text not null,
  answer      text not null,
  embedding   vector(1024),
  created_at  timestamptz not null default now()
);
create index if not exists chat_memory_chat_idx on chat_memory (chat_id, created_at desc);

create table if not exists vocab_words (
  word  text primary key,
  ndoc  int not null default 0
);

create or replace function vocab_add(t text) returns void language sql as '
  insert into vocab_words (word, ndoc)
  select w, 1 from unnest(tsvector_to_array(to_tsvector(''simple'', coalesce(t, '''')))) w
  where w !~ ''[^a-z-]'' and length(w) >= 3
  on conflict (word) do update set ndoc = vocab_words.ndoc + 1';

create or replace function vocab_from_row() returns trigger language plpgsql as '
begin
  if tg_table_name = ''doc_chunks'' then perform vocab_add(new.text);
  elsif tg_table_name = ''feed_items'' then perform vocab_add(coalesce(new.title, '''') || '' '' || coalesce(new.summary, ''''));
  else perform vocab_add(new.question || '' '' || new.answer);
  end if;
  return new;
end';

drop trigger if exists vocab_doc_chunks on doc_chunks;
create trigger vocab_doc_chunks after insert on doc_chunks for each row execute function vocab_from_row();
drop trigger if exists vocab_feed_items on feed_items;
create trigger vocab_feed_items after insert on feed_items for each row execute function vocab_from_row();
drop trigger if exists vocab_chat_memory on chat_memory;
create trigger vocab_chat_memory after insert on chat_memory for each row execute function vocab_from_row();

-- backfill from what is already saved
insert into vocab_words (word, ndoc)
select word, sum(ndoc)::int from (
  select word, ndoc from ts_stat('select to_tsvector(''simple'', text) from doc_chunks')
  union all
  select word, ndoc from ts_stat('select to_tsvector(''simple'', coalesce(title, '''') || '' '' || coalesce(summary, '''')) from feed_items')
) s
where word !~ '[^a-z-]' and length(word) >= 3
group by word
on conflict (word) do update set ndoc = excluded.ndoc;
