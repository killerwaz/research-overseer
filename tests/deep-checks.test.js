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
