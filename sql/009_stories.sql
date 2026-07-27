-- Story-level grouping.
--
-- URL dedupe is exact and correct, but four outlets covering one funding round
-- are four genuinely different pages. Run 49 returned 8 items describing 4
-- events: Natural's Series A appeared four times, Enigma's seed twice.
--
-- The grouping key comes from the skill extraction rather than from embeddings
-- or fuzzy title matching: company + round IS the story for funding, and
-- country + instrument is the story for policy. That makes it exact and
-- explainable — no similarity threshold to tune, no false merges.
--
-- Deliberately NOT keyed on amount: the same raise gets reported as $70M and
-- $71M by different outlets, so amount is aggregated (max) rather than matched.
-- Deliberately NOT time-windowed: company+round already separates a later
-- series-b from today's series-a, which a window would not do reliably.
--
-- Items without structured extraction group as themselves — honest, since we
-- have not extracted anything to group them by.

create or replace view feed_stories as
with keyed as (
  select
    f.*,
    coalesce(
      case
        -- round is slugified, not just lowercased: rows written before the
        -- enum landed carry "Series A", which must key the same as "series-a"
        when nullif(trim(f.structured ->> 'company'), '') is not null
          then 'co:' || lower(trim(f.structured ->> 'company'))
               || '/' || coalesce(
                    nullif(regexp_replace(lower(trim(f.structured ->> 'round')), '[^a-z0-9]+', '-', 'g'), ''),
                    '?')
        when nullif(trim(f.structured ->> 'instrument'), '') is not null
          then 'pol:' || coalesce(lower(nullif(trim(f.structured ->> 'country'), '')), '?')
               || '/' || lower(trim(f.structured ->> 'instrument'))
      end,
      'item:' || f.id::text
    ) as story_key,
    -- jsonb_typeof rather than a regex: the schema types this as number|null,
    -- and a type check needs no escaping to survive transport into n8n
    case
      when jsonb_typeof(f.structured -> 'amount_usd') = 'number'
        then (f.structured ->> 'amount_usd')::numeric
    end as amount_num
  from feed_items f
),
-- Aggregate to a representative id, then join back for that row's columns.
-- Taking them straight out of array_agg does not work for tags: array_agg over
-- a text[] column builds a 2-D array, so [1] yields one element, not the list.
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
