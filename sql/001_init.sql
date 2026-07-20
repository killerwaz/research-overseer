-- The Scout — initial schema (build spec §4)
-- Run against Supabase before Phase 1 acceptance.

-- URLs ever seen, keyed on canonical form
create table seen_urls (
  canonical_url text primary key,
  first_seen    timestamptz not null default now(),
  source        text
);

-- Full scraped documents
create table raw_docs (
  id            bigint generated always as identity primary key,
  canonical_url text not null references seen_urls(canonical_url),
  title         text,
  markdown      text not null,          -- fit_markdown from Crawl4AI / markdown from Firecrawl
  scraper       text not null,          -- 'crawl4ai' | 'firecrawl'
  scraped_at    timestamptz not null default now(),
  run_id        bigint
);

-- Triaged output the agent reads from
create table feed_items (
  id            bigint generated always as identity primary key,
  raw_doc_id    bigint not null references raw_docs(id),
  canonical_url text not null,
  title         text,
  summary       text,                   -- Qwen 2-3 sentence summary
  angle         text,                   -- Qwen: content angle / hook
  relevance     int check (relevance between 1 and 5),
  tags          text[],
  created_at    timestamptz not null default now(),
  run_id        bigint
);

-- User-controlled scheduling
create table schedules (
  id          bigint generated always as identity primary key,
  type        text not null check (type in ('recurring','onetime')),
  cron        text,
  run_at      timestamptz,
  label       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  last_run    timestamptz
);

-- RSS feed registry, agent-managed
create table sources (
  id         bigint generated always as identity primary key,
  kind       text not null default 'rss',
  url        text not null unique,
  label      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Run ledger: makes "what happened last night" answerable and honest
create table runs (
  id            bigint generated always as identity primary key,
  trigger       text not null,          -- 'manual' | 'schedule' | 'agent'
  scope         text not null,          -- 'full_sweep' | 'exa' | 'tavily' | 'brave' | 'rss' | 'url'
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',  -- running | ok | partial | failed
  urls_found    int default 0,
  urls_new      int default 0,          -- after dedupe
  urls_scraped  int default 0,
  items_created int default 0,
  error         text
);

create index on feed_items (created_at desc);
create index on runs (started_at desc);
