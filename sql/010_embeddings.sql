-- Semantic search over the feed.
--
-- WF-31's topic filter matches words. Measured 2026-10-10 on eval/search-eval.json:
-- it finds 22/23 topics asked in the feed's own wording but only 3/8 paraphrases
-- ("AI that can buy things for you" never reaches the agent-payments items).
-- Each feed item now carries an embedding of its title + summary + angle + tags
-- (shared/embed.js docText), written by WF-21 right after triage and backfilled
-- by scripts/backfill-embeddings.js.
--
-- 1024 = Qwen3-Embedding-0.6B (shared/embed.js says why not nomic). Switching
-- models means a new column size and a re-run of the backfill; the source text
-- stays in feed_items, so that is cheap.
--
-- No index: at a few hundred rows an exact scan is fast and exact. Add HNSW if
-- the feed passes ~20k items.

create extension if not exists vector;

alter table feed_items add column if not exists embedding vector(1024);
