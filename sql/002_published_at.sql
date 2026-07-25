-- Persist the publication date every discovery source already returns
-- (exa publishedDate, tavily published_date, brave page_age, rss isoDate).
-- Until now it was carried as far as Canonicalize and then dropped, so
-- "anything new today?" filtered on created_at = when WE scraped it.
-- Nullable by design: plenty of pages are genuinely undated, and an unknown
-- date must stay distinguishable from an old one.

alter table raw_docs   add column if not exists published_at timestamptz;
alter table feed_items add column if not exists published_at timestamptz;

-- recency queries sort newest-first and exclude undated rows
create index if not exists feed_items_published_at_idx
  on feed_items (published_at desc nulls last);
