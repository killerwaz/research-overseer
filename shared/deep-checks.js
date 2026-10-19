// Deep research: checks in code that the writer prompt alone did not hold
// (2026-10-19, from grading the local prototype on eval/research-eval.json).
// Each one fixes a failure the 9B writer made even though its prompt forbade it.

// 1. A popular item the evidence rules out is said out loud. REA: ArtCraft was
//    ruled out ("not built with REA"), the writer prompt said to say so in the
//    verdict, and the answer never mentioned it, which was the most useful line in
//    the reference answer. Shown: ruled-out items that were credited somewhere
//    (a finding claiming the relation, or several search results naming it).
//    The quote must say how it WAS made ("all built in Rust"): the relation check also
//    ruled out "Neon Rooftops" on "Pi created a game called Neon Rooftops", which
//    says nothing either way.
const HOW_MADE = /\b(built|made|written|developed|coded|created) (in|with|using|by|on)\b|\busing\b|\bwith (claude|gpt|codex|cursor|ida|ghidra|rust|python)\b/i;
function ruledOutLines(ruledOut, subject, max = 2) {
  return (ruledOut || []).filter((r) => r && (r.claims > 0 || r.mentions >= 2) && HOW_MADE.test(r.why || ''))
    .sort((a, b) => (b.claims * 3 + b.mentions) - (a.claims * 3 + a.mentions)).slice(0, max)
    .map((r) => `${r.name} was not built with ${subject}: ${r.why}` + (r.source ? ` [${r.source}]` : ''));
}

// 2. "Confirmed" over a list in which every item is a vendor claim. A2A: "multiple
//    organizations are confirmed to run A2A in production", then five items each
//    captioned "vendor claim". Each sentence was defensible; the whole was wrong.
const STRONG = /\b(confirm(ed|s)?|verified|proven|definitely|clearly (shows|run|use))\b/i;
const SOFT = /\b(vendor|self[- ]reported|own (claim|announcement|blog|page|marketing)|marketing|press release|announcement|partner(ship)?|pilot|not independently)\b/i;
function overclaims(answer) {
  const items = (answer && answer.items) || [];
  if (items.length < 2) return null;
  const head = String(answer.headline || '') + ' ' + String(answer.verdict || '');
  if (!STRONG.test(head)) return null;
  if (!items.every((i) => SOFT.test(String(i.caveat || '') + ' ' + String(i.point || '')))) return null;
  return 'the headline or verdict says "' + head.match(STRONG)[0] + '", but every item is a vendor claim, partner or pilot; ' +
    'say what the vendors report, and that no independent confirmation was found';
}
// When the rewrites still say "confirmed" (A2A: 3 tries, "Confirmed Deployments
// (Vendor-Reported)"), code softens the words rather than send it.
function soften(text) {
  return String(text || '').replace(/\b(C|c)onfirm(s|ed)?\b/g, (m, c, s) => (c === 'C' ? 'R' : 'r') + 'eport' + (s || ''))
    .replace(/\b(V|v)erified\b/g, (m, v) => (v === 'V' ? 'R' : 'r') + 'eported').replace(/\bproven\b/gi, 'reported')
    .replace(/\bReported Deployments \(Vendor-Reported\)/g, 'Vendor-Reported Deployments');
}

// 3. Dates against the period asked. "which bangladeshi ai startups raised money this
//    year" got five raises from 2024-26 as "this year".
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function cutoff(question, since, today) {
  const q = String(question || '').toLowerCase(), y = Number(String(today).slice(0, 4));
  if (/\bthis year\b/.test(q)) return y + '-01-01';
  if (/\b(last|past) (12 months|year)\b/.test(q)) return (y - 1) + String(today).slice(4, 10);
  if (/\bthis month\b/.test(q)) return String(today).slice(0, 7) + '-01';
  const s = String(since || '') + ' ' + q;
  const iso = s.match(/\b(20\d\d)-(\d\d)(?:-(\d\d))?\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3] || '01'}`;
  const my = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d\d)\b/);
  if (my) return `${my[2]}-${String(MONTHS[my[1]]).padStart(2, '0')}-01`;
  if (/\bsince\b/.test(q)) { const yr = q.match(/\bsince\s+(20\d\d)\b/); if (yr) return yr[1] + '-01-01'; }
  return '';
}
// "2025-11-03", "Nov 2025", "2025" -> a sortable YYYY-MM-DD, '' if unreadable
function isoDate(d) {
  const s = String(d || '').toLowerCase();
  let m = s.match(/\b(20\d\d)-(\d\d)(?:-(\d\d))?/); if (m) return `${m[1]}-${m[2]}-${m[3] || '01'}`;
  m = s.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(20\d\d)\b/);
  if (m) return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2},?\s+)?(20\d\d)\b/);
  if (m) return `${m[3]}-${String(MONTHS[m[1]]).padStart(2, '0')}-01`;
  m = s.match(/\b(20\d\d)\b/); if (m) return m[1] + '-06-30';   // a bare year: count it as mid-year
  return '';
}
// the note added to a dated fact in the writer's evidence
function periodNote(date, cut) {
  const d = isoDate(date);
  return cut && d && d < cut ? ` (dated ${String(date).trim()}: BEFORE ${cut}, outside the period asked; do not count it)` : '';
}
// items whose every dated fact is before the cutoff
function outOfPeriod(answer, factsByItem, cut) {
  if (!cut) return [];
  return ((answer && answer.items) || []).filter((it) => {
    const ds = (factsByItem(it) || []).map(isoDate).filter(Boolean);
    return ds.length && ds.every((d) => d < cut);
  }).map((it) => it.name);
}

// 4. The region the question names. South Asia government deals: the UAE was an item.
const REGIONS = {
  'south asia': ['india', 'pakistan', 'bangladesh', 'sri lanka', 'nepal', 'bhutan', 'maldives', 'afghanistan'],
  'southeast asia': ['indonesia', 'malaysia', 'singapore', 'thailand', 'vietnam', 'philippines', 'myanmar', 'cambodia', 'laos', 'brunei', 'timor-leste'],
  'east asia': ['china', 'japan', 'south korea', 'korea', 'taiwan', 'mongolia', 'hong kong'],
  'middle east': ['uae', 'united arab emirates', 'saudi arabia', 'qatar', 'kuwait', 'bahrain', 'oman', 'israel', 'jordan', 'lebanon', 'iraq', 'iran', 'turkey', 'egypt'],
  'africa': ['nigeria', 'kenya', 'south africa', 'egypt', 'ghana', 'ethiopia', 'rwanda', 'morocco', 'tanzania', 'uganda', 'senegal'],
  'europe': ['uk', 'united kingdom', 'france', 'germany', 'italy', 'spain', 'netherlands', 'sweden', 'poland', 'ireland', 'denmark', 'finland', 'norway', 'switzerland', 'belgium', 'austria', 'portugal', 'estonia'],
  'latin america': ['brazil', 'mexico', 'argentina', 'chile', 'colombia', 'peru'],
};
const COUNTRIES = [...new Set(Object.values(REGIONS).flat().concat(['usa', 'united states', 'canada', 'australia', 'new zealand']))];
const ALIASES = { 'bangladeshi': 'bangladesh', 'indian': 'india', 'pakistani': 'pakistan', 'sri lankan': 'sri lanka', 'nepali': 'nepal', 'nepalese': 'nepal' };
// the countries a question limits itself to: a named region, or a named country
function regionOf(question, region) {
  const s = (String(region || '') + ' ' + String(question || '')).toLowerCase();
  for (const [r, cs] of Object.entries(REGIONS)) if (s.includes(r)) return { name: r, countries: cs };
  for (const [a, c] of Object.entries(ALIASES)) if (new RegExp('\\b' + a + '\\b').test(s)) return { name: c, countries: [c] };
  for (const c of COUNTRIES) if (new RegExp('\\b' + c + '\\b').test(s)) return { name: c, countries: [c] };
  return null;
}
// items that name a country outside it (and none inside it)
function outOfRegion(answer, reg) {
  if (!reg) return [];
  const has = (t, c) => new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t);
  return ((answer && answer.items) || []).filter((it) => {
    const t = `${it.name} ${it.point}`;
    const outside = COUNTRIES.filter((c) => !reg.countries.includes(c) && has(t, c));
    return outside.length && !reg.countries.some((c) => has(t, c));
  }).map((it) => it.name);
}

// 5. Thin evidence, firm headline. Held-out grading (2026-10-19): on 5 of 10 answers the
//    writer set evidence_thin=true and still wrote "Verified count: ~400 active", "The
//    government has confirmed two Indian companies ...". 3 of 8 thin-case answers were
//    capped for it. When the writer says the evidence is thin, code makes the headline
//    say so and softens "confirmed/verified" in the headline and verdict. A headline
//    never opens with "Confirmed ..." / "Verified ...", thin or not.
// ("reported" is not a hedge: soften() turns "confirmed" into it)
const HEDGED = /\b(thin|unclear|unknown|not (disclosed|confirmed|verified|found|public)|no (firm|clear|public|verified|confirmed|single|measured)|estimate[sd]?|partly|mixed|limited evidence|can.?t (say|confirm))\b/i;
function hedgeHeadline(answer) {
  if (!answer) return answer;
  let headline = String(answer.headline || '').replace(/^\s*(confirmed|verified)\s*(count|deployments?|users?|products?|list)?\s*[:\-–—]\s*/i, '');
  headline = headline.replace(/^\s*(confirmed|verified)\s+/i, 'Reported ');
  let verdict = answer.verdict;
  if (answer.evidence_thin) {
    headline = soften(headline); verdict = soften(verdict);
    if (!HEDGED.test(headline)) headline = 'Evidence is thin: ' + headline.charAt(0).toLowerCase() + headline.slice(1);
  }
  return { ...answer, headline, verdict };
}

// 6. Recency. Held-out grading: facts were the weakest part (1.1/3) and the main cause
//    was stopping at older evidence ("google code written by AI": both versions stopped
//    at 2025 and missed the April 2026 statement that flips the verdict).
function daysBetween(a, b) { const x = Date.parse(isoDate(a) || ''), y = Date.parse(isoDate(b) || ''); return isNaN(x) || isNaN(y) ? null : Math.round((y - x) / 86400000); }
// a date N days before today, for Exa's startPublishedDate
function daysAgo(today, n) { const t = Date.parse(isoDate(today)); return isNaN(t) ? '' : new Date(t - n * 86400000).toISOString().slice(0, 10); }
// +2 for a page from the last 6 months, +1 for the last year, 0 undated or older
function recencyBoost(date, today) { const d = daysBetween(date, today); return d == null || d < -2 ? 0 : d <= 183 ? 2 : d <= 366 ? 1 : 0; }
// a limits line when the newest source the answer rests on is older than 6 months
function staleLimit(dates, today) {
  const ds = (dates || []).map(isoDate).filter(Boolean).sort();
  if (!ds.length) return 'None of the sources carried a date, so there may be newer information.';
  const newest = ds[ds.length - 1], d = daysBetween(newest, today);
  return d != null && d > 183 ? `The newest source found is from ${newest}; there may be later news.` : '';
}

// countries outside the region named in free text (the headline and verdict): the item
// check alone let "Singapore has signed an MOU with OpenAI" lead a South Asia answer
function outOfRegionText(text, reg) {
  if (!reg) return [];
  const t = String(text || '');
  const has = (c) => new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(t);
  return COUNTRIES.filter((c) => !reg.countries.includes(c) && has(c));
}

// ---- myth guard (2026-10-19, the deploy gate's traps: scripts/deep-traps.json)
// The three myths it caught share one cause: a retelling or a list was taken as the source.
const lowName = (e) => String(e || '').split('/').pop().replace(/\(.*?\)/g, '').trim().toLowerCase();
// a. Part of a ruled-out item. REA v4 live: PhotoCraft and FilmCraft listed as built with REA
//    while ArtCraft was ruled out; they are ArtCraft apps. Returns the excerpt where both
//    names appear within `span` characters (the 9B then says whether one is part of the other).
function nearEachOther(text, a, b, span = 400) {
  const t = String(text || ''), lt = t.toLowerCase(), x = lowName(a), y = lowName(b);
  if (x.length < 3 || y.length < 3 || x === y) return '';
  for (let i = lt.indexOf(x); i >= 0; i = lt.indexOf(x, i + 1)) {
    const j = lt.slice(Math.max(0, i - span), i + x.length + span).indexOf(y);
    if (j >= 0) { const s = Math.max(0, i - span); return t.slice(Math.max(0, s + Math.min(j, i - s) - 300), s + Math.max(j, i - s) + 400); }
  }
  return '';
}
// b. A name in a list is not a deployment. A2A v4: ServiceNow, Salesforce and Atlassian
//    "confirmed" from one sentence on the protocol's own blog naming the platforms that support it.
function listMention(quote, self, names) {
  const q = String(quote || '').toLowerCase(), me = lowName(self);
  return [...new Set((names || []).map(lowName))].filter((n) => n.length >= 3 && n !== me && !me.includes(n) && !n.includes(me) && q.includes(n)).length >= 2;
}
// c. The claim's origin. Klarna v4: "Yes, Klarna fired ~700 staff ... and rehired them", from
//    2025-26 retellings; the 2024 original said the AI did "the equivalent work of 700 agents".
//    The earliest dated pages that carry the claim's figure are read against the claim.
function claimFigures(claim) {
  return [...new Set((String(claim || '').replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) || [])
    .filter((n) => !/^(19|20)\d\d$/.test(n) && !(+n <= 10 && Number.isInteger(+n))))];
}
function originPages(pages, claim, max = 2) {
  const figs = claimFigures(claim);
  if (!figs.length) return [];
  return (pages || []).map((p, i) => ({ i, d: isoDate(p.date), t: String(p.text || '').replace(/(\d),(\d{3})/g, '$1$2') }))
    .filter((x) => x.d && figs.some((f) => new RegExp('(^|[^\\d.])' + f.replace('.', '\\.') + '(?![\\d])').test(x.t)))
    .sort((a, b) => a.d.localeCompare(b.d)).slice(0, max)
    .map((x) => { const f = figs.find((g) => x.t.includes(g)); const k = x.t.indexOf(f); return { page: x.i, date: x.d, excerpt: x.t.slice(Math.max(0, k - 1200), k + 1200) }; });
}
// a headline that answers a claim question with yes
const AFFIRMS = /^\W*(yes|true|correct|accurate|confirmed|that'?s (right|true|what happened)|it'?s true|it is true)\b/i;
function affirms(headline) { return AFFIRMS.test(String(headline || '')); }

// d. The question's own words decide built_with. Gate run 2026-10-19: the 9B parsed "the top 5
//    products that 'reverse engineer anything' repo was used to create" as used_in_production, so
//    nothing was ruled out and PhotoCraft came back as a product. Only overrides the two shapes it confuses.
const BUILT_WORDS = /\b(built|made|created|developed|written|coded)\s+(with|using|on top of|on)\b|\bused to (create|build|make|develop)\b|\b(was|were|been) used to\b.*\b(create|build|make)\b/i;
function shapeFromWords(question, shape) {
  return (shape === 'used_in_production' || shape === 'which_entities') && BUILT_WORDS.test(String(question || '')) ? 'built_with' : shape;
}

module.exports = { shapeFromWords, nearEachOther, listMention, claimFigures, originPages, affirms, outOfRegionText, hedgeHeadline, daysAgo, recencyBoost, staleLimit, daysBetween, ruledOutLines, overclaims, soften, cutoff, isoDate, periodNote, outOfPeriod, regionOf, outOfRegion, REGIONS };
