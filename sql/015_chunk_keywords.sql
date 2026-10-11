-- Keyword side of passage search (2026-10-12).
--
-- Meaning alone blurs exact names: "who bought Langfuse?" ranked pages
-- comparing Langfuse with its rivals above the one line that says ClickHouse
-- acquired it, and "how much has Harvey raised?" missed the funding table.
-- Postgres full-text search put the right article first for both
-- (scripts/eval-passages.js, 2026-10-12). shared/passage-search.js fuses the
-- two.
--
-- tsv: english stemming, the same config WF-31's item keyword rule uses.
-- text_md5: the same promo block copied onto many pages ("StrictlyVC returns
-- to New York", 72 passages = 30 texts) is boilerplate; search skips any text
-- found on 3+ pages.

alter table doc_chunks add column if not exists tsv tsvector
  generated always as (to_tsvector('english', text)) stored;
create index if not exists doc_chunks_tsv_idx on doc_chunks using gin (tsv);

alter table doc_chunks add column if not exists text_md5 text
  generated always as (md5(text)) stored;
create index if not exists doc_chunks_md5_idx on doc_chunks (text_md5);
