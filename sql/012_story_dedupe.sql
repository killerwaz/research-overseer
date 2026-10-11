-- Story dedupe by meaning (2026-10-11), replacing 009's grouping key.
--
-- 009 grouped on the skill extraction (company+round, country+instrument). On
-- the live feed that merged 2 of 352 items, because most items never get a
-- structured extraction — while "Patronus AI raises $50M" sat in the feed four
-- times. Now each new item is compared with its closest neighbour by embedding
-- when it is stored (WF-21, shared/dedupe.js): >= 0.87 similarity merges,
-- 0.80-0.87 asks the 9B "same story?", below that it stands alone.
--
-- dup_of always points at the story's ROOT (the first item seen), never at
-- another duplicate, so a story is one level deep and the key is just
-- coalesce(dup_of, id). Deleting a root (a re-triage replaces the row) frees
-- its duplicates to stand alone rather than deleting them.

alter table feed_items add column if not exists dup_of bigint references feed_items(id) on delete set null;
create index if not exists feed_items_dup_of_idx on feed_items (dup_of);

create or replace view feed_stories as
with keyed as (
  select
    f.*,
    'st:' || coalesce(f.dup_of, f.id)::text as story_key,
    case
      when jsonb_typeof(f.structured -> 'amount_usd') = 'number'
        then (f.structured ->> 'amount_usd')::numeric
    end as amount_num
  from feed_items f
),
agg as (
  select
    story_key,
    count(*)::int                            as articles,
    max(score)                               as score,
    max(specificity)                         as specificity,
    max(angle_strength)                      as angle_strength,
    max(amount_num)                          as amount_usd,
    min(coalesce(published_at, created_at))  as first_published,
    max(coalesce(published_at, created_at))  as last_published,
    max(created_at)                          as created_at,
    max(run_id)                              as run_id,
    (array_agg(id  order by score desc nulls last, id))[1] as rep_id,
    array_agg(canonical_url order by score desc nulls last, id) as all_urls
  from keyed
  group by story_key
)
select
  a.story_key, a.articles, a.score, a.specificity, a.angle_strength, a.amount_usd,
  f.title, f.canonical_url, f.summary, f.angle, f.structured, f.tags,
  a.first_published, a.last_published, a.created_at, a.all_urls, a.run_id
from agg a
join feed_items f on f.id = a.rep_id;
