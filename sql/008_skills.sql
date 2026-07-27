-- Skills: per-query structured extraction.
--
-- Until now every document got the same four outputs regardless of what was
-- being asked. A funding announcement and a policy PDF came back in identical
-- shape, so "show me every raise above $10M" was unanswerable — the amount
-- existed only as English inside `summary`.
--
-- A skill adds fields on top of the standard triage output, in the SAME model
-- call: the extra prompt is appended to the system message and the extra
-- properties are merged into the response schema. Standard fields are always
-- present, so the feed stays uniform and nothing downstream needs to care.

create table if not exists skills (
  name         text primary key,
  description  text,
  extra_prompt text  not null,
  extra_schema jsonb not null,   -- JSON-schema properties merged into triage
  created_at   timestamptz not null default now()
);

-- extracted fields land here; null for documents triaged without a skill
alter table feed_items add column if not exists structured jsonb;

-- which skill (if any) a standing query invokes
alter table queries add column if not exists skill text references skills(name);

-- runs did not record what was actually searched for, so nothing downstream
-- could tell which skill applied
alter table runs add column if not exists query text;

create index if not exists feed_items_structured_idx
  on feed_items using gin (structured);

insert into skills (name, description, extra_prompt, extra_schema) values (
  'funding',
  'Deal terms from startup funding announcements',
  'This article may describe a startup funding event. In addition to the standard fields, extract: company (the company raising the money, or null if the article is not about a specific raise); round (lowercase, one of the allowed values — map "Series A" to series-a, "Seed round" to seed, and so on); amount_usd (the raise size as a plain number in US dollars, converting from other currencies where the article states a rate, or null if not stated); investors (array of named investors or lead firms, empty array if none are named). Never guess a number that is not in the text.',
  -- round is an enum, not free text: the model otherwise echoes the article''s
  -- casing ("Series A" vs "series-a") and breaks equality filters
  '{
     "company":    {"type": ["string","null"]},
     "round":      {"type": ["string","null"],
                    "enum": ["pre-seed","seed","series-a","series-b","series-c","series-d","series-e","growth","debt","grant","acquisition",null]},
     "amount_usd": {"type": ["number","null"]},
     "investors":  {"type": "array", "items": {"type": "string"}}
   }'::jsonb
) on conflict (name) do update
  set extra_prompt = excluded.extra_prompt,
      extra_schema = excluded.extra_schema,
      description  = excluded.description;

insert into skills (name, description, extra_prompt, extra_schema) values (
  'policy',
  'Country and policy-stage signals from government / regulatory coverage',
  'This article may describe a government or regulatory development. In addition to the standard fields, extract: country (the country or jurisdiction it concerns, or null); body (the ministry, regulator or institution named, or null); stage (one of proposed, consultation, enacted, enforced, or null); instrument (the name of the law, strategy or programme, or null). Never infer a jurisdiction that is not stated.',
  '{
     "country":    {"type": ["string","null"]},
     "body":       {"type": ["string","null"]},
     "stage":      {"type": ["string","null"]},
     "instrument": {"type": ["string","null"]}
   }'::jsonb
) on conflict (name) do update
  set extra_prompt = excluded.extra_prompt,
      extra_schema = excluded.extra_schema,
      description  = excluded.description;

update queries set skill = 'funding' where text = 'agentic startup funding';
update queries set skill = 'policy'  where text = 'frontier market AI adoption';
