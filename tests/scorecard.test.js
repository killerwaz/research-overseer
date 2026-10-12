const test = require('node:test');
const assert = require('node:assert');
const { scorecardSql, scorecard, hostOf, sameSite } = require('../shared/scorecard.js');

const g = (source, host, n, good, scored, score_sum, extra = {}) =>
  ({ source, host, n, good, scored, score_sum, up: 0, down: 0, last_at: '2026-10-01', ...extra });

test('hostOf and sameSite', () => {
  assert.strictEqual(hostOf('https://www.Latent.space/feed'), 'latent.space');
  assert.strictEqual(hostOf('nope'), '');
  assert.ok(sameSite('blog.n8n.io', 'blog.n8n.io'));
  assert.ok(sameSite('news.example.com', 'example.com'));
  assert.ok(!sameSite('notexample.com', 'example.com'));
  assert.ok(!sameSite('', 'example.com'));
});

test('scorecardSql: window only for a positive whole number of days', () => {
  assert.match(scorecardSql(30), /interval '30 days'/);
  for (const d of ['', 0, -5, 'x', '3; drop table runs', 1.5]) assert.doesNotMatch(scorecardSql(d), /interval/, String(d));
});

test('sources fold across websites; rates use scored items only', () => {
  const s = scorecard({ groups: [
    g('exa', 'a.com', 10, 4, 8, 48), g('exa', 'b.com', 2, 0, 0, 0, { last_at: '2026-10-05' }),
    g('brave', 'c.com', 5, 1, 5, 20),
  ], feeds: [] });
  const exa = s.sources.find((r) => r.name === 'exa');
  assert.deepStrictEqual([exa.n, exa.good, exa.unscored, exa.good_rate, exa.avg_score, exa.last_at], [12, 4, 4, '50%', 6, '2026-10-05']);
  assert.strictEqual(s.sources[0].name, 'exa');   // most good items first
});

test('RSS items credit the feed on the same site; active feed wins; others and silent feeds listed', () => {
  const s = scorecard({
    groups: [g('rss', 'simonwillison.net', 6, 2, 6, 29), g('rss', 'anthropic.com', 1, 1, 1, 8), g('rss', 'theverge.com', 3, 0, 0, 0)],
    feeds: [
      { id: 2, url: 'https://www.theverge.com/rss/index.xml', label: 'Verge', active: false },
      { id: 5, url: 'https://simonwillison.net/atom/everything/', label: 'Simon Willison', active: true },
      { id: 9, url: 'https://hamel.dev/index.xml', label: 'Hamel', active: true },
    ] });
  const names = s.rss_feeds.map((r) => r.name);
  assert.deepStrictEqual(names.slice(0, 2), ['Simon Willison', 'RSS (other site)']);
  assert.ok(names.includes('Verge (off)'));
  const hamel = s.rss_feeds.find((r) => r.name === 'Hamel');
  assert.deepStrictEqual([hamel.n, hamel.good_rate, hamel.avg_score], [0, '-', null]);
});

test('empty input is safe', () => {
  assert.deepStrictEqual(scorecard(null).sources, []);
  assert.deepStrictEqual(scorecard({}).rss_feeds, []);
});
