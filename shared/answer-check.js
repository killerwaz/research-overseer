// Fix 1a (on trial 2026-10-12): every figure and name in a reply must appear
// in what the tools returned this turn. Inlined into WF-00's Guard check and
// Final check.
//
// Why: the 9B fills gaps from memory — "Anthropic adds 512 tokens" (the
// article says 50-100), "Harvey raised $15M in a seed round". Figures are the
// most common invention and the easiest to check: a number either appears in
// the evidence or it does not.
// Limit: a real name in the wrong place passes — "Langfuse was acquired by
// Databricks" names a company that IS in the same article (it bought someone
// else). Catching that needs a model judging each claim, not string matching.

const NAME_STOP = new Set(('I The This That These Those It Its If In On At For From To Of And Or But So As By With Without Yes No Not ' +
  'AI Would Do Does Did Is Are Was Were Be Can Could Should Will Also Here There What Which Who When Where Why How ' +
  'Based According Under Over After Before Since During While Both Each Every Some Any All Most Many More Less Other ' +
  'Feed Item Items Article Articles Source Sources Summary Evidence Passage Note Older Latest Recent New Score ' +
  'Telegram Overseer Exa Tavily Brave RSS Want Shall Let Sure OK Okay Please Thanks Here ' +
  // dates get reworded ("January" for "Jan"); they are not names
  'January February March April May June July August September October November December ' +
  'Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Monday Tuesday Wednesday Thursday Friday Saturday Sunday').split(' ').map((w) => w.toLowerCase()));

// Same spelling for "$1.2 billion" / "$1.2B" / "1,200" / "40–60 percent".
// Evidence often arrives as JSON text, where a line break is the two
// characters \n: "$581.7\n\nbillion" in a PDF report did not match "$581.7B"
// in the matrix runs (2026-10-12), so escapes and runs of whitespace go first.
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/\\[nrt]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[‐-―−]/g, '-')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\$\s?/g, '')
    .replace(/(\d)\s?(billion|bn)\b/g, '$1b')
    .replace(/(\d)\s?(million|mn)\b/g, '$1m')
    .replace(/(\d)\s?(thousand)\b/g, '$1k')
    .replace(/(\d)\s?(percent|per cent)\b/g, '$1%')
    .replace(/(\d)\s+(%|b|m|k)\b/g, '$1$2')
    // amounts as full numbers: "$400K" and "$400,000" (a matrix false alarm) both become 400000
    .replace(/(\d+(?:\.\d+)?)(k|m|b)\b/g, (x, n, u) => String(Math.round(Number(n) * { k: 1e3, m: 1e6, b: 1e9 }[u])));
}

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Figures: numbers with an optional unit. Skipped: small bare counts (list
// numbers, item n), years, and anything the question itself contains.
function figures(text, question) {
  const q = norm(question);
  const out = new Set();
  for (const m of norm(text).matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(%|b|m|k|x)?(?![\w])/g)) {
    const num = Number(m[1]), tok = m[1] + (m[2] || '');
    if (!m[2] && num <= 20 && !m[1].includes('.')) continue;
    if (!m[2] && num >= 1990 && num <= 2035 && !m[1].includes('.')) continue;
    if (new RegExp('(?<![\\d.])' + esc(tok) + '(?![\\d])').test(q)) continue;
    out.add(tok);
  }
  return [...out];
}

// Names: capitalised words that do not start a sentence or a list line.
function names(text, question) {
  const q = norm(question);
  const out = new Set();
  const t = String(text || '').replace(/\*\*|__|`/g, '');
  for (const m of t.matchAll(/(?<=[a-z0-9,;:()"'’] )([A-Z][A-Za-z0-9&-]*[A-Za-z0-9](?: [A-Z][A-Za-z0-9&-]*[A-Za-z0-9])*)/g)) {
    const words = m[1].split(' ').filter((w) => !NAME_STOP.has(w.toLowerCase()) && w.length > 1);
    if (!words.length) continue;
    const name = words.join(' ');
    if (q.includes(name.toLowerCase())) continue;
    out.add(name);
  }
  return [...out];
}

// What in the reply is not in the evidence. A figure must appear as written
// (after norm). Names are opt-in: in the matrix runs (2026-10-12) the name
// check raised only false alarms — bullet headings ("Levers", "Thresholds"),
// "Liberation Army" for "People's Liberation Army" — and replaced one good
// answer, while the invention it was meant for ("Databricks") passes anyway.
function unsupportedFacts(reply, evidence, question, opts) {
  const ev = norm(evidence);
  const missing = [];
  for (const f of figures(reply, question)) {
    if (!new RegExp('(?<![\\d.])' + esc(f) + '(?![\\d])').test(ev)) missing.push(f);
  }
  if (opts && opts.names) {
    for (const n of names(reply, question)) {
      if (!n.toLowerCase().split(' ').some((w) => ev.includes(w))) missing.push(n);
    }
  }
  return missing;
}

module.exports = { norm, figures, names, unsupportedFacts };
