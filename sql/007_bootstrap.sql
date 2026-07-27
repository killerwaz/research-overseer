-- Silent bootstrap: a newly added feed records whatever is currently on it as
-- already-seen, so subscribing never dumps a page of pre-existing items into
-- the feed as though the Scout discovered them.
alter table sources add column if not exists bootstrapped_at timestamptz;

-- Feeds that predate this column have already had their backlog ingested,
-- so mark them done rather than re-bootstrapping them.
update sources set bootstrapped_at = created_at where bootstrapped_at is null;
