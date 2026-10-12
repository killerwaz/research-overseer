// Source scorecard (build menu #9): where the good items come from.
// Report only — it never switches a source off (Wasim, 2026-10-12).
//
// One query returns per-(discovery source, website) counts plus the RSS feed
// list; scorecard() folds them into one row per discovery source and one row
// per RSS feed. raw items don't record which RSS feed they came from, so an
// RSS item is credited to the feed on the same website; HN-style feeds link to
// other sites, and those items land in "RSS (other site)".

const GOOD = 7;   // score >= 7 counts as a good item (score runs 2-10)

function scorecardSql(days) {
  const d = Number(days);
  const since = Number.isInteger(d) && d > 0 ? `and f.created_at > now() - interval '${d} days'` : '';
  return `select json_build_object(
  'groups', (select coalesce(json_agg(g), '[]'::json) from (
    select coalesce(su.source, 'unknown') as source,
           lower(substring(f.canonical_url from '^https?://(?:www\\.)?([^/:]+)')) as host,
           count(*)::int as n,
           count(*) filter (where f.score >= ${GOOD})::int as good,
           -- score 0 = never scored on the current axes (pre-2026-07 items)
           count(*) filter (where f.score > 0)::int as scored,
           coalesce(sum(f.score) filter (where f.score > 0), 0)::int as score_sum,
           count(*) filter (where fb.vote = 1)::int as up,
           count(*) filter (where fb.vote = -1)::int as down,
           to_char(max(f.created_at), 'YYYY-MM-DD') as last_at
    from feed_items f
    left join seen_urls su on su.canonical_url = f.canonical_url
    left join feedback fb on fb.feed_item_id = f.id
    where f.dup_of is null ${since}
    group by 1, 2) g),
  'feeds', (select coalesce(json_agg(json_build_object('id', id, 'url', url, 'label', label, 'active', active) order by id), '[]'::json)
            from sources where kind = 'rss'))::text as scorecard`;
}

function hostOf(url) {
  const m = String(url || '').toLowerCase().match(/^https?:\/\/(?:www\.)?([^/:?#]+)/);
  return m ? m[1] : '';
}

// A feed on feeds.example.com or example.substack.com still owns example.com items
// only if the item's host equals the feed's host or is a subdomain of it, or vice versa.
function sameSite(a, b) {
  if (!a || !b) return false;
  return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

function blank(name) { return { name, n: 0, scored: 0, good: 0, score_sum: 0, up: 0, down: 0, last_at: '' }; }
function add(row, g) {
  row.n += g.n; row.scored += g.scored || 0; row.good += g.good; row.score_sum += g.score_sum; row.up += g.up; row.down += g.down;
  if (g.last_at && g.last_at > row.last_at) row.last_at = g.last_at;
}
function finish(row) {
  const { score_sum, scored, ...r } = row;
  r.unscored = row.n - scored;
  r.good_rate = scored ? Math.round((100 * row.good) / scored) + '%' : '-';
  r.avg_score = scored ? Math.round((10 * score_sum) / scored) / 10 : null;
  return r;
}

function scorecard(data) {
  const groups = (data && data.groups) || [];
  const feeds = ((data && data.feeds) || []).map((f) => ({ ...f, host: hostOf(f.url) }));
  const bySource = new Map();
  const byFeed = new Map();
  for (const g of groups) {
    if (!bySource.has(g.source)) bySource.set(g.source, blank(g.source));
    add(bySource.get(g.source), g);
    if (g.source !== 'rss') continue;
    // an active feed wins over an inactive one on the same site
    const f = feeds.filter((x) => sameSite(g.host, x.host)).sort((a, b) => Number(b.active) - Number(a.active))[0];
    const key = f ? 'feed:' + f.id : 'other';
    if (!byFeed.has(key)) {
      const name = f ? (f.label || f.url) + (f.active ? '' : ' (off)') : 'RSS (other site)';
      byFeed.set(key, blank(name));
    }
    add(byFeed.get(key), g);
  }
  // active feeds with nothing yet still show up, so a silent feed is visible
  for (const f of feeds) {
    if (f.active && !byFeed.has('feed:' + f.id)) byFeed.set('feed:' + f.id, blank(f.label || f.url));
  }
  const order = (a, b) => b.good - a.good || b.n - a.n;
  return {
    good_means: 'score >= ' + GOOD + ' of 10',
    sources: [...bySource.values()].map(finish).sort(order),
    rss_feeds: [...byFeed.values()].map(finish).sort(order),
    note: 'RSS items are matched to a feed by website; links to other sites count as "RSS (other site)". Merged duplicate stories count once. good_rate and avg_score cover scored items only; unscored = saved before the current scoring.',
  };
}

module.exports = { GOOD, scorecardSql, scorecard, hostOf, sameSite };
