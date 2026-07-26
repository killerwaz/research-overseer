-- Debounce state for background Telegram notices, so a condition that persists
-- across many 5-minute poller ticks produces one message, not 288 a day.
create table if not exists notices (
  kind      text primary key,
  last_sent timestamptz not null default now()
);
