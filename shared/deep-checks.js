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

module.exports = { ruledOutLines, overclaims, soften, cutoff, isoDate, periodNote, outOfPeriod, regionOf, outOfRegion, REGIONS };
