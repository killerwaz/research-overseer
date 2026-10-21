-- The spelling fixer's word list stops learning from chats (2026-10-21).
--
-- sql/016 also fed vocab_words from chat_memory (so "Elius", from a web answer,
-- would stop being "fixed" to "elias"). But every exchange stores HIS words too,
-- typos included: once "pathoa" and "kaggle" had been typed to the bot they were
-- "known" words, and "brief me on pathoa" found nothing (WF-31 trace, 2026-10-21).
-- A fixer that unlearns typos is worse than one that misses a rare web-only name.
-- The word list is now articles only: doc_chunks text + feed titles/summaries.

drop trigger if exists vocab_chat_memory on chat_memory;

truncate vocab_words;

insert into vocab_words (word, ndoc)
select word, sum(ndoc)::int from (
  select word, ndoc from ts_stat('select to_tsvector(''simple'', text) from doc_chunks')
  union all
  select word, ndoc from ts_stat('select to_tsvector(''simple'', coalesce(title, '''') || '' '' || coalesce(summary, '''')) from feed_items')
) s
where word !~ '[^a-z-]' and length(word) >= 3
group by word
on conflict (word) do update set ndoc = excluded.ndoc;
