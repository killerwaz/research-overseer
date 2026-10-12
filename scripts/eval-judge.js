// "Did the feed answer?" — the wording rule (needsWeb) vs the 9B judge, on
// recorded end-to-end answers (workbench/data/answers-*.json) plus the real
// misses from Telegram, 2026-10-13. Labels: feed questions that passed =
// answered; absent topics answered "nothing" (not from the web) = not answered.
//   node scripts/eval-judge.js          (N=60 answered sampled, all not-answered)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const W = require('../shared/web-fallback.js');
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const N = Number(process.env.N || 60);

// the Telegram replies that started this (verbatim from the executions)
const REAL = [
  { q: "what's your advice during this weather?", answered: false, reply: "The feed has one item on your topic:\n\n1. National Strategy for Artificial Intelligence Bangladesh - Information and Communication Technology Division Government of the People's Republic ... — This document mentions AI applications like checking weather reports as examples of narrow AI, but it doesn't give specific advice for current weather conditions in Dhaka.\n\nWould you like me to search for recent news about weather advisories or health tips for Dhaka?" },
  { q: "how's the weather in dhaka right now?", answered: false, reply: "I don't have access to live weather data or tools to fetch current weather conditions. My capabilities are limited to searching news feeds and discovery sources for articles and information.\n\nWould you like me to search for any recent news about Dhaka instead?" },
  { q: 'why are these the best?', answered: false, reply: "The feed doesn't have any articles explaining why specific AI Engineering certifications are considered the \"best.\" It only contains general funding and startup news. Would you like me to run a paid search (exa or tavily) to find current rankings, reviews, and expert opinions on top certifications?" },
  { q: 'i was referring to the ai engineering certification - why are the ones you gave me from the web considered the best?', answered: false, reply: "I don't have access to the specific list of certifications you're referring to from your previous web search. My current feed doesn't contain articles ranking or reviewing AI Engineering certifications.\n\nTo answer why certain ones are considered \"best,\" I'd need to see that list or run a new search for expert reviews and rankings. Would you like me to do that?" },
];

function load() {
  const seen = new Set();
  const yes = [], no = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'workbench', 'data')).filter((x) => /^answers-.*\.json$/.test(x)).sort()) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'workbench', 'data', f), 'utf8'));
    for (const r of d.results || []) {
      const reply = String(r.reply || '').trim();
      if (!reply || seen.has(reply) || /^(From the web|Not in your feed)/.test(reply)) continue;
      seen.add(reply);
      if (r.expect === '(nothing found)' && r.pass) no.push({ q: r.q, reply, answered: false });
      else if (r.expect !== '(nothing found)' && r.id < 200 && r.pass) yes.push({ q: r.q, reply, answered: true });
    }
  }
  // a fixed, spread sample of the answered ones
  const step = Math.max(1, Math.floor(yes.length / N));
  return { yes: yes.filter((_, i) => i % step === 0).slice(0, N), no };
}

async function judge(q, reply) {
  const r = await fetch('http://localhost:1234/v1/chat/completions', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LMSTUDIO_API_KEY },
    body: JSON.stringify(W.judgeBody('qwen/qwen3.5-9b', q, reply)), signal: AbortSignal.timeout(120000) });
  const j = await r.json();
  return W.readJudge((((j.choices || [])[0] || {}).message || {}).content);
}

(async () => {
  const { yes, no } = load();
  const cases = [...yes, ...no, ...REAL];
  const score = { rule: { ok: 0, wrong: [] }, judge: { ok: 0, wrong: [], unread: 0 } };
  let secs = 0;
  for (const c of cases) {
    const ruleWeb = W.needsWeb({ question: c.q, reply: c.reply }).web;
    if (ruleWeb === !c.answered) score.rule.ok++; else score.rule.wrong.push(c);
    const t0 = Date.now();
    const v = await judge(c.q, c.reply);
    secs += (Date.now() - t0) / 1000;
    if (v === null) score.judge.unread++;
    if (v === c.answered) score.judge.ok++; else score.judge.wrong.push({ ...c, said: v });
  }
  const show = (w) => w.map((c) => '   [' + (c.answered ? 'answered' : 'NOT answered') + (c.said !== undefined ? ', judge said ' + c.said : '') + '] ' + c.q + '\n      ' + c.reply.replace(/\s+/g, ' ').slice(0, 200)).join('\n');
  console.log('cases: ' + yes.length + ' answered, ' + no.length + ' not answered (recorded), ' + REAL.length + ' real Telegram misses');
  console.log('\nwording rule: ' + score.rule.ok + '/' + cases.length + ' right\n' + show(score.rule.wrong));
  console.log('\n9B judge: ' + score.judge.ok + '/' + cases.length + ' right, unreadable ' + score.judge.unread + ', ' + (secs / cases.length).toFixed(2) + ' s each\n' + show(score.judge.wrong));
})();
