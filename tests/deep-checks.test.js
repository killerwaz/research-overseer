const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/deep-checks.js');

test('ruledOutLines names a credited item the evidence rules out, skips obscure ones', () => {
  const lines = D.ruledOutLines([
    { name: 'ArtCraft', claims: 2, mentions: 5, why: 'Al Jazeera says it was built with Claude Opus 5.5 and Rust', source: 4 },
    { name: 'Neon Rooftops', claims: 0, mentions: 1, why: 'x' }], 'REA');
  assert.deepStrictEqual(lines, ['ArtCraft was not built with REA: Al Jazeera says it was built with Claude Opus 5.5 and Rust [4]']);
  assert.deepStrictEqual(D.ruledOutLines([], 'REA'), []);
});

test('ruledOutLines needs a quote that says how it was made (Neon Rooftops, 2026-10-19)', () => {
  const lines = D.ruledOutLines([
    { name: 'Neon Rooftops', claims: 2, mentions: 3, why: '"Pi created a game called Neon Rooftops"', source: 4 },
    { name: 'ArtCraft', claims: 1, mentions: 2, why: '"ArtCraft now lists twelve apps, all built in Rust and free to use."', source: 5 }], 'REA');
  assert.deepStrictEqual(lines, ['ArtCraft was not built with REA: "ArtCraft now lists twelve apps, all built in Rust and free to use." [5]']);
});

test('hedgeHeadline: a thin answer never gets a firm headline (held-out C8, C6)', () => {
  const a = D.hedgeHeadline({ headline: 'Verified count: ~400 active; 12,000 ordered but not yet operational', verdict: 'The count is verified by two sources.', evidence_thin: true });
  assert.strictEqual(a.headline, 'Evidence is thin: ~400 active; 12,000 ordered but not yet operational');
  assert.strictEqual(a.verdict, 'The count is reported by two sources.');
  const b = D.hedgeHeadline({ headline: 'The government has confirmed two Indian companies running IndiaAI models', verdict: 'x', evidence_thin: true });
  assert.match(b.headline, /^Evidence is thin: the government has reported two Indian companies/);
  const c = D.hedgeHeadline({ headline: 'No single total for Q3 2026 is disclosed', verdict: 'x', evidence_thin: true });
  assert.strictEqual(c.headline, 'No single total for Q3 2026 is disclosed', 'already hedged');
  const d = D.hedgeHeadline({ headline: 'Confirmed browser-use products: desktop, Cloud', verdict: 'x', evidence_thin: false });
  assert.strictEqual(d.headline, 'Reported browser-use products: desktop, Cloud');
  assert.strictEqual(D.hedgeHeadline({ headline: 'Confirmed deployments: Instacart, Replit', verdict: 'x' }).headline, 'Instacart, Replit');
  const e = D.hedgeHeadline({ headline: 'The $5.6m figure is a calculated estimate', verdict: 'y', evidence_thin: false });
  assert.strictEqual(e.headline, 'The $5.6m figure is a calculated estimate', 'firm answers are left alone');
});

test('outOfRegionText catches a headline that leads with another region (Singapore, tuning v4)', () => {
  const reg = D.regionOf('which south asian governments have signed deals with openai or anthropic', '');
  assert.deepStrictEqual(D.outOfRegionText('Singapore has signed an MOU with OpenAI; India and Pakistan have procurement records.', reg), ['singapore']);
  assert.deepStrictEqual(D.outOfRegionText('India and Pakistan have procurement records with OpenAI.', reg), []);
  assert.deepStrictEqual(D.outOfRegionText('anything', null), []);
});

test('recency helpers', () => {
  assert.strictEqual(D.daysAgo('2026-10-19', 183), '2026-04-19');
  assert.strictEqual(D.recencyBoost('2026-08-01', '2026-10-19'), 2);
  assert.strictEqual(D.recencyBoost('2026-01-05', '2026-10-19'), 1);
  assert.strictEqual(D.recencyBoost('2024-05-01', '2026-10-19'), 0);
  assert.strictEqual(D.recencyBoost('', '2026-10-19'), 0);
  assert.strictEqual(D.staleLimit(['2025-03-01', '2025-11-02'], '2026-10-19'), 'The newest source found is from 2025-11-02; there may be later news.');
  assert.strictEqual(D.staleLimit(['2025-03-01', '2026-09-30'], '2026-10-19'), '');
  assert.match(D.staleLimit([], '2026-10-19'), /None of the sources carried a date/);
});

test('soften turns "confirmed" into "reported" when the rewrites did not', () => {
  assert.strictEqual(D.soften("Google's A2A Protocol in Production: Confirmed Deployments (Vendor-Reported)"), "Google's A2A Protocol in Production: Vendor-Reported Deployments");
  assert.strictEqual(D.soften('The evidence confirms usage by Microsoft. Verified by nobody.'), 'The evidence reports usage by Microsoft. Reported by nobody.');
});

test('overclaims: "confirmed" over vendor claims only', () => {
  const a2a = { headline: 'Confirmed production deployments of A2A', verdict: 'Yes, multiple organizations are confirmed to run A2A.',
    items: [{ name: 'Google Cloud', point: 'runs A2A', caveat: 'Vendor claim from official announcement.' },
      { name: 'ServiceNow', point: 'uses A2A', caveat: 'Vendor claim; listed as a technology partner earlier.' }] };
  assert.match(D.overclaims(a2a), /every item is a vendor claim/);
  const mixed = { ...a2a, items: [a2a.items[0], { name: 'Tyson', point: 'uses A2A', caveat: 'Reported by Reuters.' }] };
  assert.strictEqual(D.overclaims(mixed), null);
  assert.strictEqual(D.overclaims({ ...a2a, headline: 'Vendors report A2A in production', verdict: 'Two vendors say so.' }), null);
});

test('cutoff reads the period the question asks about', () => {
  assert.strictEqual(D.cutoff('which bangladeshi ai startups actually raised money this year', '', '2026-10-19'), '2026-01-01');
  assert.strictEqual(D.cutoff('what changed in the eu ai act since aug 2025?', '', '2026-10-19'), '2025-08-01');
  assert.strictEqual(D.cutoff('what changed in mcp since the june 2025 spec?', '2025-06-18', '2026-10-19'), '2025-06-18');
  assert.strictEqual(D.cutoff('who uses langgraph in production', '', '2026-10-19'), '');
});

test('isoDate and periodNote mark facts from before the period', () => {
  assert.strictEqual(D.isoDate('Nov 2025'), '2025-11-01');
  assert.strictEqual(D.isoDate('3 March 2026'), '2026-03-03');
  assert.strictEqual(D.isoDate('2024'), '2024-06-30');
  assert.strictEqual(D.isoDate('soon'), '');
  assert.match(D.periodNote('Nov 2025', '2026-01-01'), /BEFORE 2026-01-01/);
  assert.strictEqual(D.periodNote('Feb 2026', '2026-01-01'), '');
  assert.strictEqual(D.periodNote('', '2026-01-01'), '');
});

test('outOfPeriod flags items whose every dated fact is too old', () => {
  const ans = { items: [{ name: 'Hishab' }, { name: 'Shikho' }, { name: 'Undated' }] };
  const dates = { Hishab: ['2024-05-01'], Shikho: ['2024-01-01', '2026-03-01'], Undated: [] };
  assert.deepStrictEqual(D.outOfPeriod(ans, (it) => dates[it.name], '2026-01-01'), ['Hishab']);
  assert.deepStrictEqual(D.outOfPeriod(ans, (it) => dates[it.name], ''), []);
});

test('region: the UAE is not South Asia', () => {
  const reg = D.regionOf('which south asian governments have signed deals with openai or anthropic', '');
  assert.strictEqual(reg.name, 'south asia');
  const ans = { items: [{ name: 'India', point: 'IndiaAI mission MoU with OpenAI' },
    { name: 'UAE', point: 'Stargate UAE with OpenAI' }, { name: 'G42', point: 'Abu Dhabi firm; the United Arab Emirates deal' }] };
  assert.deepStrictEqual(D.outOfRegion(ans, reg), ['UAE', 'G42']);
  assert.strictEqual(D.regionOf('which bangladeshi ai startups raised money', '').name, 'bangladesh');
  assert.strictEqual(D.regionOf('lm studio vs ollama for parallel requests', ''), null);
});

// ---- myth guard
test('nearEachOther: both names close together -> excerpt; far apart or absent -> empty', () => {
  const { nearEachOther } = require('../shared/deep-checks.js');
  assert.ok(nearEachOther('ArtCraft now lists twelve apps, including PhotoCraft.', 'PhotoCraft', 'ArtCraft').includes('PhotoCraft'));
  assert.equal(nearEachOther('PhotoCraft.' + ' x'.repeat(600) + ' ArtCraft', 'PhotoCraft', 'ArtCraft'), '');
  assert.equal(nearEachOther('only PhotoCraft here', 'PhotoCraft', 'ArtCraft'), '');
});

test('listMention: a quote naming 2+ other candidates is a list, a lone deployment is not', () => {
  const { listMention } = require('../shared/deep-checks.js');
  const names = ['ServiceNow', 'Salesforce', 'Atlassian', 'Yahoo'];
  assert.equal(listMention('platforms like ServiceNow, Salesforce and Atlassian connect workflows with A2A', 'ServiceNow', names), true);
  assert.equal(listMention("Yahoo's Seller Agent coordinates campaigns over A2A in production", 'Yahoo', names), false);
});

test('originPages: earliest dated page carrying the claim figure first; years and small numbers ignored', () => {
  const { originPages, claimFigures } = require('../shared/deep-checks.js');
  assert.deepEqual(claimFigures('Klarna fired 700 people in 2024, 3 times'), ['700']);
  const pages = [{ date: '2025-06-09', text: 'sacked 700 workers' }, { date: '2024-02-27', text: 'the equivalent work of 700 full-time agents' }, { date: '', text: '700' }, { date: '2023-01-01', text: '7000 users' }];
  assert.deepEqual(originPages(pages, 'fired 700 people').map((o) => o.page), [1, 0]);
  assert.deepEqual(originPages(pages, 'no figure here'), []);
});

test('affirms: a yes headline, not a partly/no one', () => {
  const { affirms } = require('../shared/deep-checks.js');
  assert.equal(affirms('Yes, Klarna fired ~700 staff'), true);
  assert.equal(affirms('Partly: the 700 was an estimate'), false);
  assert.equal(affirms('No: Klarna never fired 700 people'), false);
});

test('shapeFromWords: build wording turns used_in_production into built_with; other questions untouched', () => {
  const { shapeFromWords } = require('../shared/deep-checks.js');
  assert.equal(shapeFromWords("top 5 products that 'reverse engineer anything' repo on github was used to create", 'used_in_production'), 'built_with');
  assert.equal(shapeFromWords('what real products are built on browser-use?', 'which_entities'), 'built_with');
  assert.equal(shapeFromWords("who's actually using google's a2a protocol in production?", 'used_in_production'), 'used_in_production');
  assert.equal(shapeFromWords('klarna fired 700 people for ai and rehired them', 'is_claim_true'), 'is_claim_true');
});

test('checkThese: own fact first, a quote that does not fit is skipped, no fit -> no line', async () => {
  const { checkThese } = require('../shared/deep-checks.js');
  const facts = [
    { entity: 'Other', quote: 'Bangladesh startups raised 6 million dollars in total this half.', n: 1, url: 'u1' },
    { entity: 'DX-Ball', quote: 'DX-Ball sound-pan calculation recovered with REA.', n: 1, url: 'u1' },
    { entity: 'TH04', quote: 'TH04 bullet ring recovered from 16-bit DOS code.', n: 2, url: 'u2' }];
  const items = [{ name: 'DX-Ball', sources: [1] }, { name: 'TH04', sources: [2] }, { name: 'Nothing', sources: [9] }];
  const all = await checkThese(items, facts);
  assert.deepEqual(all.map((c) => [c.name, c.n]), [['DX-Ball', 1], ['TH04', 2]]);
  assert.ok(all[0].quote.startsWith('DX-Ball'));
  // the fit check rejects DX-Ball's own quote: the next candidate (the total) is tried and rejected too
  const seen = [];
  const strict = await checkThese(items, facts, async (it, q) => { seen.push(it.name + ': ' + q.slice(0, 10)); return it.name === 'TH04'; });
  assert.deepEqual(strict.map((c) => c.name), ['TH04']);
  assert.equal(seen.filter((x) => x.startsWith('DX-Ball')).length, 2);
});
