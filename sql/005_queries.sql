-- Standing search queries for scheduled/default sweeps. Replaces the
-- SCOUT_DEFAULT_QUERIES env var from spec §5.1: a table is agent-manageable
-- and editable without restarting the n8n container.
create table if not exists queries (
  id         bigint generated always as identity primary key,
  text       text not null unique,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into queries (text) values
  ('AI infrastructure costs'),
  ('frontier market AI adoption'),
  ('agentic startup funding')
on conflict (text) do nothing;
