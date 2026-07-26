-- Two judgement axes replacing the collapsed single `relevance` score.
-- `relevance` is kept for now so old and new scoring can be compared on the
-- same rows; drop it once the axes are trusted.
--
-- No `novelty` column: exa and brave date ~100% of results, so recency is
-- computed from published_at instead of asked of the model.

alter table feed_items
  add column if not exists specificity    int check (specificity    between 1 and 5),
  add column if not exists angle_strength int check (angle_strength between 1 and 5);

-- 2..10 once triaged on the new prompt, 0 for rows scored before it (sorts last)
alter table feed_items
  add column if not exists score int generated always as (
    coalesce(specificity, 0) + coalesce(angle_strength, 0)
  ) stored;

create index if not exists feed_items_score_idx
  on feed_items (score desc, created_at desc);

-- after the axes are trusted:
-- alter table feed_items drop column relevance;
