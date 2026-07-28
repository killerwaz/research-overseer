-- Small key/value store for user-toggled runtime switches.
-- drain_enabled: whether the WF-30 poller may re-triage backlog documents.
-- Default OFF — Research Overseer asks before spending GPU time on cleanup.
create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values ('drain_enabled', 'false')
  on conflict (key) do nothing;
