const test = require('node:test');
const assert = require('node:assert');
const { replyParts, checkTrap } = require('../shared/deep-traps.js');
const { cases } = require('../scripts/deep-traps.json');
const trap = (id) => cases.find((c) => c.id === id);

const reply = (head, items, extra = '') =>
  `**${head}**\n\nSummary.\n\n${items.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n${extra}\n\nSources:\n[1] PhotoCraft review - https://x`;

test('replyParts splits headline, items, body (sources excluded)', () => {
  const p = replyParts(reply('Head', ['**A**: one', '**B**: two'], '**Not built with it:** ArtCraft'));
  assert.equal(p.headline, 'Head');
  assert.equal(p.items.split('\n').length, 2);
  assert.ok(p.body.includes('ArtCraft') && !p.body.includes('PhotoCraft'));
});

test('REA: PhotoCraft as a finding fails, ArtCraft only in the ruled-out line passes', () => {
  assert.equal(checkTrap(reply('Five', ['**PhotoCraft**: built with REA']), trap('rea-top5-built-with')).length, 1);
  assert.deepEqual(checkTrap(reply('Five', ['**DX-Ball**: x'], '**Not built with it:** ArtCraft, PhotoCraft'), trap('rea-top5-built-with')), []);
});

test('Klarna: "Yes" headline and "rehired ~700" fail; the workload reading passes', () => {
  const bad = reply('Yes, Klarna fired ~700 staff and rehired them.', ['**Klarna rehired ~700 staff**: x']);
  assert.equal(checkTrap(bad, trap('klarna-ai-700-agents-claim')).length, 3);
  const good = reply('No: 700 was the equivalent work of 700 agents, not a layoff.', ['**New human pool**: x']);
  assert.deepEqual(checkTrap(good, trap('klarna-ai-700-agents-claim')), []);
});

test('A2A: a partner listed as a finding fails; mentioned in prose passes', () => {
  assert.equal(checkTrap(reply('Few', ['**ServiceNow**: runs A2A']), trap('a2a-production-users')).length, 1);
  assert.deepEqual(checkTrap(reply('Few, Salesforce is a partner', ['**Yahoo**: x']), trap('a2a-production-users')), []);
});

test('failure rate: a labelled-unverified 95% passes, a stated one fails; headline must hedge', () => {
  const t = trap('agent-production-failure-rate');
  assert.deepEqual(checkTrap(reply('There is no single rate', ['**70-95% (unverified claim)**: 95% of AI agents fail']), t), []);
  assert.equal(checkTrap(reply('There is no single rate', ['**95%**: 95% of AI agents fail']), t).length, 1);
  assert.equal(checkTrap(reply('43% of agents fail', ['**x**: y']), t).length, 1);
});
