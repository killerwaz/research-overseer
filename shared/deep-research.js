// Deep research on the local 9B (thinking OFF everywhere). Ported 2026-10-19 from
// the prototype in eval/deep-pipeline (v3; scored on eval/research-eval.json and
// the held-out set). Runs unchanged in two places:
//   - WF-46 'Deep run', ONE n8n Code node (inlined at build time, with deep-checks.js)
//   - scripts/deep-research.js, from a terminal, for tests and evals
// so nothing here may use require, fetch, URL, crypto or process: everything
// outside the pipeline comes in through `io` (see research()).
//
//   plan    - the 9B only PARSES the question (shape, subject, claim...); the
//             queries come from code templates (it cannot plan searches for a
//             subject newer than itself: eval/9b-steps)
//   search  - Exa (text included) + Brave for site: second hops; anchor on the
//             subject's GitHub repo, its topic page and its show-and-tell posts
//   read    - Exa text, Firecrawl when Exa had none; 12k-char chunks, 2 per page
//   extract - findings with verbatim quotes; code drops quotes not on the page
//   round 2 - search the names round 1 found
//   relation- built with / used in production: multiple choice per entity
//   verify  - each kept finding against a window of its page
//   write   - verdict + items + limits from verified findings only; code checks
//             numbers, source ids, every sentence, "confirmed", dates, region

const DEEP_MODEL = 'qwen/qwen3.5-9b';
const DEEP_CHUNK = 12000, DEEP_MAX_CHUNKS = 2;

// ---------------------------------------------------------------- small helpers
const deepSchema = (name, s) => ({ type: 'json_schema', json_schema: { name, strict: true, schema: s } });
// a slice can cut a character in half; LM Studio rejects lone surrogates with a 400
const fixText = (x) => String(x).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
const deepSleep = (ms) => new Promise((r) => setTimeout(r, ms));
// normalise for quote-in-page checks: markdown links, punctuation, case, space
function dnorm(s) {
  return String(s || '').replace(/\]\([^)]*\)/g, ']').replace(/[*_`#>\[\]|]/g, ' ')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function quoteFound(quote, text) {
  const q = dnorm(quote).replace(/^\.+|\.+$/g, '').replace(/\.\.\.|…/g, '\u0000');
  if (q.length < 8) return false;
  const T = dnorm(text);
  return q.split('\u0000').map((x) => x.trim()).filter((x) => x.length >= 6).every((part) => T.includes(part));
}
// JSON from content, or from reasoning_content when thinking overran (as shared/triage-validate.js)
function recoverJson(msg) {
  let c = String((msg && msg.content) || '').trim();
  if (!c && msg && msg.reasoning_content) { const m = String(msg.reasoning_content).match(/\{[\s\S]*\}/); if (m) c = m[0]; }
  if (!c) return null;
  try { return JSON.parse(c.replace(/^```(json)?/i, '').replace(/```$/, '').trim()); } catch (e) { return null; }
}
// no URL in n8n Code nodes
const hostOf = (u) => { const m = String(u || '').match(/^https?:\/\/([^/?#:]+)/i); return m ? m[1].toLowerCase().replace(/^www\./, '') : ''; };
const SOCIAL = /(^|\.)(youtube\.com|youtu\.be|instagram\.com|facebook\.com|linkedin\.com|tiktok\.com|x\.com|twitter\.com|reddit\.com|threads\.net|pinterest\.com|quora\.com)$/i;
const compact = (s) => dnorm(s).replace(/[^a-z0-9]/g, '');
// what the 9B reads: links reduced to their text, GitHub chrome and blank runs dropped
function cleanPage(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
    .split(/\n/).filter((l) => !/^(Skip to content|You signed in with another tab|You signed out|You switched accounts|Dismiss alert|Reload|Uh oh!|There was an error while loading|You must be logged in|Sign up for free|Copy link|More actions|Navigation Menu|Toggle navigation)/i.test(l.trim()))
    .join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function chunksOf(text) {
  const out = []; let cur = '';
  for (const para of text.split(/\n/)) {
    if (cur.length + para.length + 1 > DEEP_CHUNK && cur.length) { out.push(cur); cur = ''; if (out.length >= DEEP_MAX_CHUNKS) break; }
    cur += (cur ? '\n' : '') + para.slice(0, DEEP_CHUNK);
  }
  if (cur.trim() && out.length < DEEP_MAX_CHUNKS) out.push(cur);
  return out;
}
const numsIn = (s) => (String(s).replace(/(\d),(\d{3})/g, '$1$2').match(/\d+(?:\.\d+)?/g) || []);
function windowAt(text, quote, span = 3500) {
  const q = String(quote).slice(0, 60);
  let i = text.indexOf(q);
  if (i < 0) { const nt = dnorm(text), nq = dnorm(q).slice(0, 40); const j = nt.indexOf(nq); i = j < 0 ? 0 : Math.floor(j * text.length / Math.max(nt.length, 1)); }
  return text.slice(Math.max(0, i - span), i + span);
}
const sentencesOf = (t) => String(t).split(/(?<=[.!?])\s+(?=[A-Z0-9*])/).map((s) => s.trim()).filter(Boolean);
const citesIn = (s) => [...String(s).matchAll(/\[(\d+)\]/g)].map((m) => +m[1]);
// one key for name variants: "N0zoM1z0 / dx-ball", "DX-Ball", "DX-Ball reconstruction"
const entKey = (e) => compact(String(e).split('/').pop().replace(/\(.*?\)/g, '')
  .replace(/\b(reconstruction|reconstructions|project|repository|repo|case study|showcase|study|app|clone|the)\b/gi, '')) || compact(e);
// true when an entity is just the subject itself ("REA", "morluto/rea"), not something
// else that contains its name ("ReaCut", "rea-capcut")
const FILLER = /\b(github|repo|repository|the|mcp|tool|toolkit|project|page|readme|official|website|site|docs|agents|agent|cli|package|npm|help|framework|server|plugin|skill|v?\d+(\.\d+)*)\b/g;
function subjectOnly(e, names, repoName, owner = '') {
  const n = dnorm(e).replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n || n.length < 3) return true;
  let rest = ' ' + n + ' ';
  for (const nm of names) {
    const k = dnorm(nm).replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (k) rest = rest.split(' ' + k + ' ').join(' ');
  }
  if (repoName) rest = rest.split(/\s+/).filter((w) => w !== repoName && w !== owner && !w.endsWith('/' + repoName)).join(' ');
  return rest.replace(FILLER, ' ').replace(/[\s/]+/g, '').length < 3;
}
// the subject's canonical GitHub repo: the one results link to most, named like the subject
function canonicalRepo(results, names) {
  const tokens = names.map(compact).filter((t) => t.length >= 3);
  const count = {};
  for (const r of results) for (const m of (r.url + ' ' + (r.text || '')).matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
    const owner = m[1].toLowerCase(), name = m[2].toLowerCase().replace(/\.git$/, '').replace(/[.]+$/, '');
    if (/^(topics|orgs|features|sponsors|settings|marketplace|login|apps)$/.test(owner)) continue;
    if (!tokens.some((t) => compact(name) === t || compact(name) === t.replace(/s$/, ''))) continue;
    count[owner + '/' + name] = (count[owner + '/' + name] || 0) + 1;
  }
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : null;
}
// a host or repo carrying the subject's name that is not the canonical one (REA has a dozen SEO mirrors)
function lookalike(url, names, repo, official) {
  if (!repo) return false;
  const h = hostOf(url), tokens = names.map(compact).filter((t) => t.length >= 3);
  const short = (lab, allowAwesome) => tokens.some((t) => t.length >= 6 ? lab.includes(t)
    : new RegExp('^' + (allowAwesome ? '(awesome)?' : '') + t + '(mcp|tool|tools|run|hub|app|ai|dev|s|cases|agents)?$').test(lab));
  if (h === 'github.com') {
    const m = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
    if (!m || (m[1] + '/' + m[2]).toLowerCase() === repo) return false;
    return compact(m[2]).length >= 6 && tokens.some((t) => t.length >= 6 && compact(m[2]).includes(t));
  }
  if (official.has(h)) return false;
  return short(compact(h.split('.').slice(0, -1).join('')), true) || short(compact(h.split('.')[0]), true);
}
function pickPages(results, already, max, subjectRe, penalty = () => 0, today = '') {
  const by = new Map();
  for (const r of results) {
    const h = hostOf(r.url);
    if (!h || SOCIAL.test(h) || already.has(r.url)) continue;
    const x = by.get(r.url) || { ...r, hits: 0, qs: new Set() };
    x.hits++; x.qs.add(r.q); if (!x.text && r.text) x.text = r.text; by.set(r.url, x);
  }
  const score = (x) => x.qs.size * 2 + (subjectRe.test(x.title + ' ' + x.text.slice(0, 3000)) ? 2 : 0) +
    (/github\.com|\.gov|\.gov\.\w+|europa\.eu|\.org$/.test(hostOf(x.url)) ? 1 : 0) + (x.text.length > 2000 ? 1 : 0) - penalty(x.url) +
    (today ? recencyBoost(x.date, today) : 0);   // newer pages get read first (shared/deep-checks.js)
  const ranked = [...by.values()].sort((a, b) => score(b) - score(a));
  const per = {}, out = [];   // at most 2 pages per host so one site cannot fill the read list
  for (const x of ranked) { const h = hostOf(x.url); if ((per[h] = (per[h] || 0) + 1) > 2) continue; out.push(x); if (out.length >= max) break; }
  return out;
}

// ---------------------------------------------------------------- prompts
const SHAPES = ['built_with', 'used_in_production', 'changed_since', 'is_claim_true', 'compare', 'number', 'which_entities'];
const planSystem = (today) => `You parse a research question for a search pipeline. Today is ${today}. Do not answer it; you may not know the subject (it can be newer than you).
shape: built_with = products/projects made with a tool or repo; used_in_production = which organisations really run X; changed_since = what changed in X since a date;
is_claim_true = is a popular claim/story/number true; compare = A vs B on some axis; number = a figure (users, rate, amount); which_entities = which companies/governments/countries did something
(e.g. "which bangladeshi startups raised money this year", "which governments signed deals with X" are which_entities, not used_in_production).
search_name: ONLY the name of the subject, 1-4 words, as people write it (e.g. "the 'reverse engineer anything' repo on github" -> "Reverse Engineer Anything"; "google's a2a protocol" -> "A2A protocol";
"lm studio vs ollama" -> "LM Studio"). Never a whole phrase like "top projects built with X". also_called: other names/abbreviations of the subject (e.g. "REA", "Agent2Agent").
claim: for is_claim_true, the claim in one neutral sentence; else "". a, b, axis: for compare; else "". region, since: if the question names them; else "".
answer_is: one sentence on what counts as a real answer. not_answer: things that look like answers but are not (e.g. articles about X, partners instead of users, policies instead of laws).
extra_queries: 2 search queries a careful researcher would add that the obvious ones would miss.`;
const PLAN_FORMAT = deepSchema('plan', { type: 'object', additionalProperties: false,
  required: ['shape', 'search_name', 'also_called', 'claim', 'a', 'b', 'axis', 'region', 'since', 'answer_is', 'not_answer', 'extra_queries'],
  properties: { shape: { type: 'string', enum: SHAPES }, search_name: { type: 'string' }, also_called: { type: 'array', items: { type: 'string' } },
    claim: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' }, axis: { type: 'string' }, region: { type: 'string' }, since: { type: 'string' },
    answer_is: { type: 'string' }, not_answer: { type: 'array', items: { type: 'string' } }, extra_queries: { type: 'array', items: { type: 'string' } } } });

function deepTemplates(p, today) {
  const s = p.search_name, y = String(today).slice(0, 4), r = p.region ? ' ' + p.region : '';
  const E = (q) => ({ engine: 'exa', q }), B = (q) => ({ engine: 'brave', q });
  const t = {
    built_with: [E(`projects built with ${s}`), E(`"built with ${s}" OR "made with ${s}" OR "using ${s}"`), E(`${s} showcase case study`),
      E(`awesome ${s} list`), E(`${s} news ${y}`), B(`site:github.com "${s}" built with show and tell`)],
    used_in_production: [E(`${s} in production engineering blog`), E(`companies using ${s} in production case study`), E(`${s} customer story deployment`),
      E(`${s} adoption ${y}`), E(`${s} production criticism limitations`), B(`"${s}" "in production" engineering blog`)],
    changed_since: [E(`${s} changes since ${p.since}`), E(`${s} amendment ${y}`), E(`${s} official update ${y}`), E(`${s} changelog release notes ${y}`),
      E(`${s} news ${y}`), B(`${s} ${y} change`)],
    is_claim_true: [E(p.claim || s), E(`${p.claim || s} fact check`), E(`${s} original source study`), E(`${s} misleading OR debunked OR criticism`),
      E(`${s} what actually happened ${y}`), B(`${p.claim || s}`)],
    compare: [E(`${p.a} ${p.axis || s}`), E(`${p.b} ${p.axis || s}`), E(`${p.a} vs ${p.b} ${p.axis} benchmark`), E(`${p.a} pricing ${y}`), E(`${p.b} pricing ${y}`),
      B(`${p.a} vs ${p.b} ${p.axis}`)],
    number: [E(`${s}${r} ${y}`), E(`${s}${r} statistics report`), E(`${s}${r} survey data`), E(`${s}${r} estimate`), E(`${s}${r} news ${y}`), B(`${s}${r} number`)],
    which_entities: [E(`${s}${r} ${y}`), E(`${s}${r} announced`), E(`${s}${r} news`), E(`${s}${r} list`), E(`${s}${r} official`), B(`${s}${r}`)],
  }[p.shape] || [];
  // a claim built on a number ("700 people", "95%", "3 Wh"): find where the number first came from
  if (p.shape === 'is_claim_true') {
    const num = (String(p.claim).match(/\d[\d,.]*\s*%?/) || [])[0];
    if (num) t.push(E(`${s} ${num.trim()} original announcement press release report`));
    t.push(E(`${s} primary source company statement`));
  }
  if (p.shape === 'used_in_production') t.push(E(`site:engineering OR "engineering blog" ${s} how we built`));
  if (p.shape === 'compare' && p.a && p.b) t.push(E(`${p.a} official documentation ${p.axis}`), E(`${p.b} official documentation ${p.axis}`));
  // the last 6 months only (Exa startPublishedDate): held-out grading found answers that
  // stopped at 2025 evidence and missed the 2026 statement that flipped the verdict
  const since = daysAgo(today, 183);
  // A claim's own wording, date-limited, finds this year's RETELLINGS of the story (Klarna
  // v4: a 2026 blog post retelling "fired 700, then rehired" became source [1] and flipped
  // a right "no" to "yes"). For a claim, look for what the subject itself said lately.
  const core = { is_claim_true: `${s} official statement`, compare: `${p.a} vs ${p.b} ${p.axis}`, built_with: `built with ${s}`, used_in_production: `${s} in production`,
    changed_since: `${s} update`, number: `${s}${r}`, which_entities: `${s}${r}` }[p.shape] || s;
  if (since) t.push({ engine: 'exa', q: core, since }, { engine: 'exa', q: p.shape === 'is_claim_true' ? `${s} company says ${y}` : `${core} latest news`, since });
  return t.concat((p.extra_queries || []).slice(0, 2).map(E));
}

const EXTRACT_SYSTEM = `You pull evidence for a research question out of ONE web page (or part of one). Use only the page.
List the facts on the page that help answer the question: names, numbers, dates, what happened, who said it. Each finding:
entity = the specific thing it is about (a product, company, law, model, study...); finding = one self-contained sentence a reader can use without the page,
naming the entity and, if the page attributes it, who says so; quote = the exact sentence or line from the page that supports it (copy, do not paraphrase);
date = the date the page gives for it, else "";
candidate = true if the finding is about a specific item the answer could list, confirm or rule out (a product made with the subject, an organisation using it, a concrete change,
a figure that answers the question, evidence for or against the claim), false for background about the subject itself (what it is, its features, its popularity).
Rules: state a relationship (built with, uses, caused, replaced, signed) ONLY if the page states that relationship for that entity. Something mentioned near the subject
is not related to it. A page reporting a claim is not proof of the claim: write "X says ..." or "it was reported that ...". Skip navigation, ads, generic background.
At most 25 findings; return an empty list if nothing on the page helps.`;
const EXTRACT_FORMAT = deepSchema('findings', { type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['entity', 'finding', 'quote', 'date', 'candidate'],
    properties: { entity: { type: 'string' }, finding: { type: 'string' }, quote: { type: 'string' }, date: { type: 'string' }, candidate: { type: 'boolean' } } } } } });

const VERIFY_SYSTEM = `You check one claim against an excerpt of a web page. Use ONLY the excerpt.
"supported" - the excerpt states it (wording may differ; names, numbers, dates and relationships must match);
"contradicted" - the excerpt states something incompatible; "not_mentioned" - it does not say it either way.
Being mentioned near something is not being related to it. A page saying someone claims X supports "someone claims X", not X itself.`;
const VERIFY_FORMAT = deepSchema('verdict', { type: 'object', additionalProperties: false, required: ['verdict', 'why'],
  properties: { verdict: { type: 'string', enum: ['supported', 'contradicted', 'not_mentioned'] }, why: { type: 'string' } } });

const writeSystem = (today) => `You write the final answer of a research assistant for a Telegram chat, from checked evidence only. Today is ${today}.
Use ONLY the evidence given; every number you write must appear in it; cite with source ids like [3]. Never cite an id that is not listed.
verdict: 1-3 sentences that directly answer the question first (yes/no/partly, the number, or the short list). If the evidence does not contain a direct answer
(no measured number, no named deployment, nothing confirmed), say plainly that the evidence is thin, give the best proxy and label it as a proxy or estimate.
If a popular claim is contradicted or unsupported by the evidence, say so in the verdict.
items: up to 5 (6 for "what changed") key points or ranked picks, each with a one-line reason and an honest caveat; for lists of products/companies only include ones the
evidence says actually did the thing (not articles about it, not partners, not tools it uses). When you rank, rank by: how directly the evidence shows it (the maker says so) first,
then how complete or checked it is (tests, releases, measured results), then how significant it is; popularity alone is not a reason. ranked_by: the ranking rule if you rank, else "".
limits: 1-3 short things you could not check. Keep it under 300 words in total. Plain, specific, no hype.
Never conclude more than the evidence states: revenue or valuation is not profit, support or partnership is not production use, a vendor's own claim is not a measurement,
a draft is not adopted, "no evidence found" is not "it does not exist". If the question asks for something the evidence does not state, say it is not disclosed or not found.
When sources give different numbers, prefer the official listing or an independent measurement over vendor marketing and name which one you used.
For "is it true" questions: judge the claim against the ORIGINAL source (the company's own release, the study itself, the official record) when the evidence has it;
news pieces that repeat the viral version are not confirmation. If the original says something narrower than the viral claim, the answer is "no" or "partly", and say what it actually said.
For "who uses X in production": the vendor's own case-study pages are vendor claims; say so, and put company-authored sources first.
For "A vs B": answer A vs B on the axis asked (from their own docs or a measurement); a third option may be one item at most, never the headline.
caveat: a real limitation from the evidence (small, unverified, a preview, self-reported, dated, a pilot); never filler like "it is a full application".
Only include items that answer the question; no padding to reach five.
The evidence is listed newest first, each source with its date. When sources from different dates disagree about what is true NOW (a status, a rule,
a price, a count, who uses what), the newest dated statement is the current answer: lead with it, and say what it replaced and when.
Whether a story or claim is true is different: the original source decides (the company's own statement, the study, the record), and a newer article
retelling the story is not new evidence. If evidence_thin is true, the headline must say that the evidence is thin.`;
const WRITE_FORMAT = deepSchema('answer', { type: 'object', additionalProperties: false, required: ['headline', 'verdict', 'ranked_by', 'items', 'limits', 'evidence_thin'],
  properties: { headline: { type: 'string' }, verdict: { type: 'string' }, ranked_by: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'point', 'caveat', 'sources'],
      properties: { name: { type: 'string' }, point: { type: 'string' }, caveat: { type: 'string' }, sources: { type: 'array', items: { type: 'integer' } } } } },
    limits: { type: 'array', items: { type: 'string' } }, evidence_thin: { type: 'boolean' } } });
const WRITE_TRIES = 3;
const CHECK_SYSTEM = `You check one statement from an answer against the evidence notes it was written from. Use ONLY the notes.
"supported" - the notes state it (wording may differ; names, numbers, dates and the relationship must match);
"contradicted" - the notes say something incompatible; "not_mentioned" - the notes do not say it.
A conclusion the notes do not state is not supported (revenue is not profit, support is not production use, a vendor claim is not a measurement).`;

// relationship classifier: multiple choice, because a yes/no check let "REA works
// with Claude Code" pass as "Claude Code was built with REA"
const REL_KINDS = {
  built_with: ['made_with', 'works_with', 'studied_with', 'only_mentioned', 'made_without'],
  used_in_production: ['production_user', 'partner_or_member', 'demo_or_pilot', 'vendor_claim', 'only_mentioned'],
};
const REL_GOOD = { built_with: 'made_with', used_in_production: 'production_user' };
function relSystem(shape, subject) {
  if (shape === 'built_with') return `You read an excerpt and say how it relates ENTITY to ${subject}. Use only the excerpt. Pick one:
made_with - the excerpt says ENTITY itself was built, rebuilt, reconstructed or created using ${subject} (ENTITY is the result);
works_with - ${subject} runs inside, integrates with, supports or uses ENTITY (an agent, editor, engine or tool it works alongside);
studied_with - ${subject} was used to inspect, analyse or trace ENTITY, and nothing new was built from it in the excerpt;
only_mentioned - ENTITY appears near ${subject} (same list, same article, same tag) but the excerpt states no such relationship;
made_without - the excerpt says ENTITY was made with something else or without ${subject}.
Only the named tool counts: ordinary words that happen to match its name (e.g. "reverse engineer" as a verb) are not the tool, and a different project
with a similar name is not it either. Quote the words that decide it.`;
  return `You read an excerpt and say how it relates ENTITY to ${subject}. Use only the excerpt. Pick one:
production_user - the excerpt says ENTITY runs ${subject} in a real production system (its own engineering blog, a case study with a deployment);
partner_or_member - ENTITY supports, joined, endorsed or partners on ${subject}, with no production use stated;
demo_or_pilot - a demo, sample, pilot, hackathon or tutorial; vendor_claim - the vendor of ${subject} says so without detail from ENTITY;
only_mentioned - named near ${subject} with no relationship stated. Quote the words that decide it.`;
}
// myth guard (shared/deep-checks.js nearEachOther / originPages)
const PARTOF_SYSTEM = `You read an excerpt and say whether PART is a part of WHOLE: one of its apps, products, editions, modules or tools,
made by the same people as part of WHOLE. Use only the excerpt. "part_of" - the excerpt says or clearly shows it (e.g. "WHOLE now lists apps
including PART", "PART, one of the WHOLE apps"); "separate" - the excerpt treats them as different things; "unclear" - it does not say. Quote the deciding words.`;
const PARTOF_FORMAT = deepSchema('partof', { type: 'object', additionalProperties: false, required: ['quote', 'verdict'],
  properties: { quote: { type: 'string' }, verdict: { type: 'string', enum: ['part_of', 'separate', 'unclear'] } } });
const ORIGIN_SYSTEM = `You read the EARLIEST source found that carries a viral claim's figure, and say whether it states the claim as worded.
Use only the excerpt. "states_claim" - it says the same thing (same figure, same event, same meaning);
"says_different" - it uses the figure for something else or something narrower (an estimate instead of a count, a forecast instead of a result,
equivalent work instead of people fired, a share of users instead of a share of people); "not_about" - the excerpt is not about the claim.
quote = the exact sentence with the figure, copied from the excerpt.`;
const ORIGIN_FORMAT = deepSchema('origin', { type: 'object', additionalProperties: false, required: ['quote', 'verdict', 'actually_says'],
  properties: { quote: { type: 'string' }, verdict: { type: 'string', enum: ['states_claim', 'says_different', 'not_about'] }, actually_says: { type: 'string' } } });
const relFormat = (shape) => deepSchema('relation', { type: 'object', additionalProperties: false, required: ['quote', 'relation'],
  properties: { quote: { type: 'string' }, relation: { type: 'string', enum: REL_KINDS[shape] } } });
function relExcerpt(text, quote, span = 700) {
  const q = String(quote || '').slice(0, 60);
  let i = q ? text.indexOf(q) : -1;
  if (i < 0) { const nt = dnorm(text), nq = dnorm(q).slice(0, 40); const j = nq ? nt.indexOf(nq) : -1; i = j < 0 ? 0 : Math.floor(j * text.length / Math.max(nt.length, 1)); }
  return text.slice(Math.max(0, i - span), i + span);
}

// ---------------------------------------------------------------- render
// "**Headline**", items, "Not built with it", limits, numbered sources
function renderDeep({ ans, outLines, sourceLine, cited, checks = [] }) {
  if (!ans) return 'Sorry, I could not put an answer together from what I found.';
  const lines = [`**${ans.headline}**`, '', ans.verdict];
  if (ans.ranked_by) lines.push('', `Ranked by: ${ans.ranked_by}`);
  if (ans.items.length) { lines.push(''); ans.items.forEach((it, i) => lines.push(`${i + 1}. **${it.name}**: ${it.point}${it.caveat ? ' Caveat: ' + it.caveat : ''}${it.sources.length ? ' [' + it.sources.join('][') + ']' : ''}`)); }
  if (outLines.length) lines.push('', '**Not built with it:** ' + outLines.join(' '));
  if (checks.length) lines.push('', '**Check these (2 min):**', ...checks.map((c) => `- ${c.name}: "${c.quote}" [${c.n}] ${c.url}`));
  if (ans.limits.length) lines.push('', '**Limits:** ' + ans.limits.join(' '));
  if (cited.length) lines.push('', 'Sources:', ...cited.map(sourceLine));
  return lines.join('\n');
}

// ---------------------------------------------------------------- main
// io: {
//   http({ method, url, headers, body, timeout }) -> { status, body }   (body parsed when JSON)
//   keys: { exa, brave, firecrawl, lmstudio },  lmUrl: '.../v1/chat/completions',
//   today: 'YYYY-MM-DD',  deadline: epoch ms after which verifying stops (optional),
//   cache: { get(kind, req), set(kind, req, value) } (optional; the terminal reuses eval/deep-pipeline/cache),
//   progress(text) (optional), log(text) (optional) }
// -> { reply, answer, sources: [{ n, title, url, date }], trace }
async function deepResearch(question, io) {
  const log = io.log || (() => {}), progress = io.progress || (async () => {});
  const today = io.today, model = io.model || DEEP_MODEL;
  const t0 = Date.now(), trace = { question, stages: {}, calls: { plan: 0, extract: 0, verify: 0, write: 0, check: 0, relation: 0 }, empty: 0, spend: { exa: 0, brave: 0, firecrawl: 0, cached: 0 } };
  const lap = (k, t) => { trace.stages[k] = +((Date.now() - t) / 1000).toFixed(1); };
  const late = () => io.deadline && Date.now() > io.deadline;

  // -- the 9B: one call at a time, one retry after 30 s on a dropped connection
  async function llm(step, system, user, format, maxTokens) {
    const body = { model, temperature: 0, reasoning_effort: 'none', max_tokens: maxTokens, response_format: format,
      messages: [{ role: 'system', content: fixText(system) }, { role: 'user', content: fixText(user) }] };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await io.http({ method: 'POST', url: io.lmUrl, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + io.keys.lmstudio }, body, timeout: 300000 });
        if (r.status !== 200 || !r.body || r.body.error) throw new Error('lm ' + r.status + ' ' + JSON.stringify(r.body && r.body.error || '').slice(0, 200));
        const obj = recoverJson(((r.body.choices || [])[0] || {}).message);
        if (!obj) trace.empty++;
        return obj;
      } catch (e) { if (attempt) { trace.empty++; log('  9B call failed: ' + e.message); return null; } await deepSleep(30000); }
    }
  }
  // -- search and read, cached when io.cache is given; a dropped connection gets one retry
  async function cached(kind, req, fn) {
    if (io.cache) { const hit = await io.cache.get(kind, req); if (hit) { trace.spend.cached++; return hit; } }
    let out;
    try { out = await fn(); } catch (e) { await deepSleep(5000); try { out = await fn(); } catch (e2) { return { error: 'network: ' + e2.message }; } }
    if (io.cache && out && !out.error) await io.cache.set(kind, req, out);
    return out;
  }
  async function exa(q, n = 8, since = '') {
    // `since` only enters the cache key when set, so undated queries keep their old cache entries
    const out = await cached('exa', since ? { q, n, since } : { q, n }, async () => {
      const r = await io.http({ method: 'POST', url: 'https://api.exa.ai/search', headers: { 'Content-Type': 'application/json', 'x-api-key': io.keys.exa },
        body: { query: q, numResults: n, type: 'auto', contents: { text: { maxCharacters: 20000 } }, ...(since ? { startPublishedDate: since + 'T00:00:00.000Z' } : {}) }, timeout: 60000 });
      if (r.status !== 200) return { error: r.status + ' ' + JSON.stringify(r.body).slice(0, 200) };
      trace.spend.exa += (r.body.costDollars && r.body.costDollars.total) || 0.007;
      return { results: (r.body.results || []).map((x) => ({ url: x.url, title: x.title || '', date: (x.publishedDate || '').slice(0, 10), text: x.text || '' })) };
    });
    if (out.error) { log('  exa error ' + out.error); return []; }
    return out.results.map((x) => ({ ...x, engine: 'exa', q }));
  }
  async function brave(q, n = 10) {
    const out = await cached('brave', { q, n }, async () => {
      const r = await io.http({ method: 'GET', url: 'https://api.search.brave.com/res/v1/web/search?count=' + n + '&q=' + encodeURIComponent(q),
        headers: { 'x-subscription-token': io.keys.brave, accept: 'application/json' }, timeout: 30000 });
      if (r.status !== 200) return { error: r.status };
      trace.spend.brave++;
      return { results: (((r.body || {}).web || {}).results || []).map((x) => ({ url: x.url, title: x.title || '', date: (x.page_age || '').slice(0, 10), text: '' })) };
    });
    if (out.error) { log('  brave error ' + out.error); return []; }
    return out.results.map((x) => ({ ...x, engine: 'brave', q }));
  }
  async function scrape(url) {
    if (/\.pdf($|\?)/i.test(url)) return { error: 'pdf skipped' };   // Firecrawl bills a PDF per page
    return cached('fc', { url }, async () => {
      const r = await io.http({ method: 'POST', url: 'https://api.firecrawl.dev/v2/scrape', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + io.keys.firecrawl },
        body: { url, formats: ['markdown'], onlyMainContent: true }, timeout: 90000 });
      const data = (r.body && r.body.data) || {};
      trace.spend.firecrawl += (data.metadata && data.metadata.creditsUsed) || 1;
      if (r.status !== 200 || !data.markdown) return { error: 'scrape ' + r.status };
      const m = data.metadata || {};
      return { markdown: data.markdown, title: m.title || m.ogTitle || '', date: (m.publishedTime || m['article:published_time'] || '').slice(0, 10) };
    });
  }
  async function readPage(x) {
    let text = x.text || '', title = x.title, date = x.date, via = 'exa';
    if (text.length < 1500) {
      const s = await scrape(x.url);
      if (s.markdown) { text = s.markdown; title = title || s.title; date = date || s.date; via = 'firecrawl'; } else via = 'failed:' + (s.error || '');
    }
    return { url: x.url, title, date, text: cleanPage(text), via };
  }

  // ---------------- plan
  let t = Date.now();
  await progress('working out what counts as an answer');
  const planned = await llm('plan', planSystem(today), 'Question: ' + question, PLAN_FORMAT, 800);
  trace.calls.plan++;
  const plan = planned || { shape: 'which_entities', search_name: question, also_called: [], claim: '', a: '', b: '', axis: '', region: '', since: '', answer_is: question, not_answer: [], extra_queries: [] };
  if (plan.search_name.split(/\s+/).length > 5) {
    const quoted = question.match(/['"‘“]([^'"’”]{3,40})['"’”]/);
    plan.search_name = quoted ? quoted[1] : plan.search_name.split(/\s+/).slice(-4).join(' ');
  }
  const wordShape = shapeFromWords(question, plan.shape);
  if (wordShape !== plan.shape) { trace.shapeFrom = plan.shape; plan.shape = wordShape; }
  trace.plan = plan; lap('plan', t);
  log(`  plan: ${plan.shape} "${plan.search_name}" ${plan.claim ? '| claim: ' + plan.claim : ''}`);
  const names = [plan.search_name, ...(plan.also_called || [])].filter((n) => n && n.length >= 3);
  const subjectRe = new RegExp('\\b(' + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');

  // ---------------- round 1: search, anchor, read
  t = Date.now();
  const q1 = deepTemplates(plan, today);
  await progress(`searching (${q1.length} queries)`);
  const res1 = [];
  for (const q of q1) res1.push(...(q.engine === 'exa' ? await exa(q.q, 8, q.since || '') : await brave(q.q)));
  const readSet = new Set(), pages = [];
  const repo = canonicalRepo(res1, names);
  const official = new Set(['github.com']);
  const repoish = /built_with|used_in_production/.test(plan.shape);
  if (repo) {
    const s = await scrape('https://github.com/' + repo);
    if (s.markdown) {
      for (const m of s.markdown.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) { const h = hostOf(m[1]); if (h && !/shields\.io|githubusercontent|github\.com|badge|npmjs|img\./.test(h)) official.add(h); }
      readSet.add('https://github.com/' + repo);
      pages.push({ url: 'https://github.com/' + repo, title: repo, date: s.date, text: cleanPage(s.markdown), via: 'firecrawl-anchor' });
    }
    if (repoish) {
      const topic = 'https://github.com/topics/' + repo.split('/')[1];
      const tp = await scrape(topic);
      if (tp.markdown && tp.markdown.length > 1500) { readSet.add(topic); pages.push({ url: topic, title: 'GitHub topic ' + repo.split('/')[1], date: '', text: cleanPage(tp.markdown), via: 'firecrawl-anchor' }); }
      const dq = { engine: 'brave', q: `site:github.com/${repo}/discussions "show and tell"` };
      const disc = await brave(dq.q);
      q1.push(dq); res1.push(...disc);
      for (const d of disc.filter((d) => d.url.toLowerCase().startsWith(`https://github.com/${repo}/discussions/`) && /\/discussions\/\d+/.test(d.url)).slice(0, 3)) {
        readSet.add(d.url); const pg = await readPage(d); pg.via += '-anchor'; pages.push(pg);
      }
    }
  }
  trace.repo = repo; trace.queries = q1.map((q) => q.engine + ': ' + q.q);
  const penalty = (u) => lookalike(u, names, repo, official) ? 6 : 0;
  for (const x of pickPages(res1, readSet, Math.max(6, 11 - pages.length), subjectRe, penalty, today)) { readSet.add(x.url); pages.push(await readPage(x)); }
  lap('search1', t);

  // ---------------- extract
  const context = `Question: ${question}\nWhat counts as an answer: ${plan.answer_is}\nNot an answer: ${(plan.not_answer || []).join('; ')}`;
  const findings = [];
  async function extractFrom(pg, idx) {
    if (!pg.text || pg.text.length < 300) return;
    for (const ch of chunksOf(pg.text)) {
      const user = `${context}\n\nPage: ${pg.title} (${pg.url}${pg.date ? ', ' + pg.date : ''})\n<page>\n${ch}\n</page>`;
      let obj = io.cache ? (((await io.cache.get('x9b', EXTRACT_SYSTEM + user)) || {}).obj || null) : null;
      if (!obj) {
        obj = await llm('extract', EXTRACT_SYSTEM, user, EXTRACT_FORMAT, 6000);
        trace.calls.extract++;
        if (obj && io.cache) await io.cache.set('x9b', EXTRACT_SYSTEM + user, { obj });
      }
      for (const f of ((obj && obj.findings) || [])) {
        if (!quoteFound(f.quote, pg.text)) { trace.droppedQuotes = (trace.droppedQuotes || 0) + 1; continue; }
        findings.push({ ...f, page: idx });
      }
    }
  }
  t = Date.now();
  await progress(`reading ${pages.length} pages`);
  for (let i = 0; i < pages.length; i++) await extractFrom(pages[i], i);
  lap('extract1', t);
  log(`  round 1: ${q1.length} queries, ${pages.length} pages, ${findings.length} findings`);

  // ---------------- round 2: the names round 1 found
  t = Date.now();
  const repoName = repo ? dnorm(repo.split('/')[1]) : '';
  const isSubject = (e) => subjectOnly(e, names, repoName, repo ? repo.split('/')[0] : '');
  const freq = {};
  for (const f of findings) { const e = f.entity.trim(); if (!f.candidate || isSubject(e)) continue; freq[e] = (freq[e] || 0) + 1; }
  const BUILD = /\b(built|build|made|rebuilt|rebuild|reconstruct\w*|recreat\w*|clones?|cloned|alternatives?|ported|reimplement\w*|replica\w*|copied)\b/i;
  const buildy = (e) => !repoish || findings.some((f) => entKey(f.entity) === entKey(e) && BUILD.test(f.finding + ' ' + f.quote));
  let res2 = [];
  const allRes = () => res1.concat(res2);
  const web = (e) => { const nm = String(e).split('/').pop().replace(/\(.*?\)/g, '').trim().toLowerCase(); if (nm.length < 3) return 0;
    return new Set(allRes().filter((r) => (r.title + ' ' + (r.text || '')).toLowerCase().includes(nm)).map((r) => r.url)).size; };
  const anchorIdx = new Set(pages.map((p, i) => (/anchor/.test(p.via) ? i : -1)).filter((i) => i >= 0));
  const fromAnchor = {};
  for (const f of findings) if (f.candidate && anchorIdx.has(f.page) && !isSubject(f.entity)) fromAnchor[f.entity.trim()] = (fromAnchor[f.entity.trim()] || 0) + 1;
  const weight = (e, n) => (n + web(e)) * (buildy(e) ? 1 : 0.3);
  const top = [...new Set([...Object.entries(fromAnchor).sort((a, b) => weight(b[0], b[1]) - weight(a[0], a[1])).slice(0, 2).map(([e]) => e),
    ...Object.entries(freq).sort((a, b) => weight(b[0], b[1]) - weight(a[0], a[1])).map(([e]) => e)])]
    .filter((e, i, arr) => arr.findIndex((x) => entKey(x) === entKey(e)) === i)
    .filter((e) => { const m = e.match(/^([\w.-]+)\s*\/\s*([\w.-]+)$/); return !(m && repoName && dnorm(m[2]) === repoName); }).slice(0, 4);
  const q2 = top.map((e) => ({ engine: 'exa', q: `"${e}" ${plan.search_name}` }));
  if (repo && repoish) q2.push({ engine: 'brave', q: `site:github.com/${repo}/discussions "built" OR "made" project` });
  if (plan.shape === 'is_claim_true' && plan.claim) q2.push({ engine: 'exa', q: `${plan.claim} correction what really happened` });
  await progress(`following up ${top.length ? top.slice(0, 3).join(', ') : 'leads'}`);
  for (const q of q2) res2.push(...(q.engine === 'exa' ? await exa(q.q, 6) : await brave(q.q)));
  trace.queries2 = q2.map((q) => q.engine + ': ' + q.q);
  const before = pages.length;
  for (const x of pickPages(res2, readSet, 5, subjectRe, penalty, today)) { readSet.add(x.url); pages.push(await readPage(x)); }
  for (let i = before; i < pages.length; i++) await extractFrom(pages[i], i);
  lap('round2', t);
  log(`  round 2: ${q2.length} queries (${top.join(', ')}), ${pages.length - before} pages, ${findings.length} findings`);

  // ---------------- relationship check (built with / used in production)
  t = Date.now();
  const verified = [];
  const rel = { built_with: (e) => `${e} was made using ${plan.search_name}.`, used_in_production: (e) => `${e} runs ${plan.search_name} in production.` }[plan.shape];
  const anchorNow = new Set(pages.map((p, i) => (/anchor/.test(p.via) || /github\.com\/[^/]+\/[^/]+\/discussions\//.test(p.url) ? i : -1)).filter((i) => i >= 0));
  const rulings = { confirmed: [], ruledOut: [], unconfirmed: [], ruledOutInfo: [] };
  let factPool = findings;
  if (rel) {
    await progress('checking what was really built with it');
    const ents = {};
    for (const f of findings) {
      if (!f.candidate || isSubject(f.entity)) continue;
      const k = entKey(f.entity); const e = ents[k] || (ents[k] = { name: f.entity.trim(), pages: new Map(), n: 0 });
      e.n++; if (!e.pages.has(f.page)) e.pages.set(f.page, f.quote);
    }
    const ranked = Object.values(ents).map((e) => ({ ...e, score: e.pages.size + [...e.pages.keys()].filter((p) => anchorNow.has(p)).length * 3 + Math.min(e.n, 3) * 0.3 +
        (buildy(e.name) ? 3 : 0) + Math.min(web(e.name), 6) * 0.5 })).sort((a, b) => b.score - a.score).slice(0, 32);
    const subjLabel = plan.search_name + ((plan.also_called || []).length ? ` (${plan.also_called.join(', ')})` : '');
    const owner = repo ? repo.split('/')[0] : '';
    for (const e of ranked) {
      if (late()) { rulings.unconfirmed.push(e.name + ' (not checked: out of time)'); continue; }
      // a different repo with the subject's name ("mytechnotalent / rea") is a lookalike, not a product
      const m = e.name.match(/^([\w.-]+)\s*\/\s*([\w.-]+)$/);
      if (m && repoName && dnorm(m[2]) === repoName && m[1].toLowerCase() !== owner) { rulings.unconfirmed.push(e.name + ' (lookalike repo)'); continue; }
      const pgs = [...e.pages.entries()].sort((a, b) => anchorNow.has(b[0]) - anchorNow.has(a[0])).slice(0, 3);
      const vs = [];
      for (const [p, quote] of pgs) {
        const r = await llm('relation', relSystem(plan.shape, subjLabel), `ENTITY: ${e.name}\n\n<excerpt>\n${relExcerpt(pages[p].text, quote)}\n</excerpt>`, relFormat(plan.shape), 300);
        trace.calls.relation++;
        vs.push({ p, v: (r && r.relation) || 'invalid', quote: (r && r.quote) || '' });
      }
      let good = vs.find((x) => x.v === REL_GOOD[plan.shape]);
      const against = vs.find((x) => x.v === 'made_without');
      // a name in a list of supporters is not a deployment (myth guard b)
      if (good && plan.shape === 'used_in_production' && vs.filter((x) => x.v === 'production_user').every((x) => listMention(x.quote, e.name, ranked.map((r) => r.name)))) {
        rulings.unconfirmed.push(`${e.name} (named in a list, no deployment described)`); trace.listOnly = (trace.listOnly || []).concat(e.name); continue;
      }
      if (good && !against) { rulings.confirmed.push(e.name); verified.push({ entity: e.name, finding: `${rel(e.name)} The page says: "${good.quote.slice(0, 200)}"`, page: good.p, ruling: true }); }
      else if (against) {
        rulings.ruledOut.push(e.name); verified.push({ entity: e.name, finding: `${e.name} was NOT made with ${plan.search_name}; the page says: "${against.quote.slice(0, 200)}"`, page: against.p, ruling: true });
        // how widely it was credited: findings that claim the relation, and search results naming it
        const claims = findings.filter((f) => entKey(f.entity) === entKey(e.name) && BUILD.test(f.finding) && subjectRe.test(f.finding)).length;
        rulings.ruledOutInfo.push({ name: e.name, claims, mentions: web(e.name), why: `"${against.quote.slice(0, 160)}"`, page: against.p });
      } else rulings.unconfirmed.push(`${e.name} (${[...new Set(vs.map((x) => x.v.replace(/_/g, ' ')))].join(', ')})`);
    }
    // a confirmed item the pages place inside a ruled-out one is not confirmed (myth guard a)
    for (const c of [...rulings.confirmed]) {
      for (const r of rulings.ruledOut) {
        if (late()) break;
        const p = pages.findIndex((pg) => nearEachOther(pg.text, c, r));
        if (p < 0) continue;
        const v = await llm('partof', PARTOF_SYSTEM, `PART: ${c}\nWHOLE: ${r}\n\n<excerpt>\n${nearEachOther(pages[p].text, c, r)}\n</excerpt>`, PARTOF_FORMAT, 300);
        trace.calls.partof = (trace.calls.partof || 0) + 1;
        if (!v || v.verdict !== 'part_of') continue;
        rulings.confirmed = rulings.confirmed.filter((x) => x !== c);
        rulings.ruledOut.push(`${c} (part of ${r})`);
        for (let i = verified.length - 1; i >= 0; i--) if (verified[i].ruling && entKey(verified[i].entity) === entKey(c)) verified.splice(i, 1);
        verified.push({ entity: c, finding: `${c} is part of ${r}, which was NOT made with ${plan.search_name}; the page says: "${String(v.quote).slice(0, 200)}"`, page: p, ruling: true });
        trace.partOf = (trace.partOf || []).concat(`${c} in ${r}`);
        break;
      }
    }
    const ok = new Set(rulings.confirmed.map(entKey));
    factPool = findings.filter((f) => ok.has(entKey(f.entity)));
    log(`  relationship: ${rulings.confirmed.length} confirmed, ${rulings.ruledOut.length} ruled out (${rulings.ruledOut.join(', ')})`);
  }
  trace.rulings = rulings;

  // ---------------- verify facts
  const efreq = {};
  for (const f of findings) if (f.candidate && !isSubject(f.entity)) efreq[dnorm(f.entity)] = (efreq[dnorm(f.entity)] || 0) + 1;
  const seen = new Set();
  let cand;
  if (rel) {
    const perEnt = {};
    cand = factPool.filter((f) => f.candidate && !isSubject(f.entity))
      .filter((f) => { const k = dnorm(f.finding); if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => (efreq[dnorm(b.entity)] - efreq[dnorm(a.entity)]) || (numsIn(b.finding).length - numsIn(a.finding).length))
      .filter((f) => { const k = entKey(f.entity); perEnt[k] = (perEnt[k] || 0) + 1; return perEnt[k] <= 2; }).slice(0, 24);
  } else {
    // on compare / claim / number / changes / which questions the subject IS the answer: its own facts stay.
    // Official pages (the subject's / A's / B's site, government and EU sites) first; at most 4 per page.
    const own = [plan.search_name, plan.a, plan.b, ...(plan.also_called || [])].map(compact).filter((k) => k.length >= 4);
    const isOfficial = (p) => { const h = compact(hostOf(pages[p].url)); return own.some((k) => h.includes(k) || (k.length >= 6 && k.includes(h.replace(/(com|org|io|ai|net|dev)$/, '')) && h.length >= 5)) ||
      /\.gov|europa\.eu|\.int$|eur-lex/.test(hostOf(pages[p].url)); };
    const perPage = {};
    cand = factPool.filter((f) => { const k = dnorm(f.finding); if (seen.has(k)) return false; seen.add(k); return true; })
      .map((f) => ({ f, s: (isOfficial(f.page) ? 4 : 0) + (f.candidate ? 2 : 0) + Math.min(numsIn(f.finding).length, 2) + Math.log2(1 + (efreq[dnorm(f.entity)] || 0)) +
        recencyBoost(f.date || pages[f.page].date, today) }))
      .sort((a, b) => b.s - a.s).map((x) => x.f)
      .filter((f) => { perPage[f.page] = (perPage[f.page] || 0) + 1; return perPage[f.page] <= 4; }).slice(0, 30);
  }
  await progress(`checking ${cand.length} facts against their pages`);
  let unchecked = 0;
  for (const f of cand) {
    if (late()) { unchecked++; continue; }
    const pg = pages[f.page];
    const r = await llm('verify', VERIFY_SYSTEM, `Claim: ${f.finding}\n\nExcerpt from ${pg.title} (${pg.url}):\n<excerpt>\n${windowAt(pg.text, f.quote)}\n</excerpt>`, VERIFY_FORMAT, 400);
    trace.calls.verify++;
    f.verdict = (r && r.verdict) || 'invalid';
    if (f.verdict === 'supported') verified.push(f);
  }
  trace.unchecked = unchecked;
  // the claim's origin: the earliest dated page carrying its figure, read against the claim (myth guard c)
  let origin = null;
  if (plan.shape === 'is_claim_true' && plan.claim) {
    for (const o of originPages(pages, plan.claim)) {
      if (late()) break;
      const v = await llm('origin', ORIGIN_SYSTEM, `Claim: ${plan.claim}\n\nEarliest source: ${pages[o.page].title} (${pages[o.page].url}, ${o.date})\n<excerpt>\n${o.excerpt}\n</excerpt>`, ORIGIN_FORMAT, 400);
      trace.calls.origin = (trace.calls.origin || 0) + 1;
      if (!v || v.verdict === 'not_about' || !quoteFound(v.quote, pages[o.page].text)) continue;
      if (v.verdict === 'says_different') {
        origin = { page: o.page, date: o.date, quote: String(v.quote).slice(0, 240), says: v.actually_says };
        verified.push({ entity: 'origin', finding: `The earliest source found (${o.date}) says: "${origin.quote}" -- not the claim as worded (${v.actually_says})`, page: o.page, date: o.date });
      }
      break;
    }
    trace.origin = origin;
  }
  lap('verify', t);
  log(`  verify: ${cand.length - unchecked} checked, ${verified.length} supported`);

  // ---------------- write
  t = Date.now();
  await progress('writing the answer');
  // newest first, undated last: source [1] is the most recent dated page
  const pageDate = (p) => isoDate(pages[p].date) || isoDate((verified.find((f) => f.page === p && f.date) || {}).date) || '';
  const used = [...new Set(verified.map((f) => f.page))].sort((a, b) => (pageDate(b) || '0').localeCompare(pageDate(a) || '0'));
  const sid = Object.fromEntries(used.map((p, i) => [p, i + 1]));
  const cut = cutoff(question, plan.since, today);
  const reg = regionOf(question, plan.region);
  trace.cutoff = cut; trace.region = reg && reg.name;
  const evidence = used.map((p) => { const pg = pages[p];
    return `[${sid[p]}] ${pg.title || hostOf(pg.url)} (${hostOf(pg.url)}${pg.date ? ', ' + pg.date : ''})\n` +
      verified.filter((f) => f.page === p).map((f) => `- ${f.finding}${f.date ? ' (' + f.date + ')' : ''}${periodNote(f.date || pg.date, cut)}`).join('\n'); }).join('\n\n');
  // the dates behind an item: its own facts, else the pages it cites
  const datesOf = (it) => { const k = entKey(it.name); const own = verified.filter((f) => entKey(f.entity) === k).map((f) => f.date || pages[f.page].date);
    return own.filter(Boolean).length ? own : (it.sources || []).map((n) => { const p = used.find((q) => sid[q] === n); return p == null ? '' : pages[p].date; }); };
  const unread = pages.filter((p) => !p.text || p.text.length < 300).map((p) => hostOf(p.url));
  const writeUser = `${context}\n\nVerified evidence (${verified.length} facts from ${used.length} sources; ${findings.length - verified.length} other findings were not confirmed and are left out` +
    `${unread.length ? '; pages that could not be read: ' + unread.join(', ') : ''}${unchecked ? '; ' + unchecked + ' findings were not checked in time' : ''}):\n\n${evidence || '(none)'}` +
    (rel ? `\n\nRelationship check (did the page say it was made with / uses ${plan.search_name}?):\nCONFIRMED: ${rulings.confirmed.join(', ') || 'none'}\n` +
      `RULED OUT (a page says otherwise; if any is widely credited, say in the verdict that it was NOT built with it): ${rulings.ruledOut.join(', ') || 'none'}\n` +
      `NOT CONFIRMED (mentioned, relationship not stated): ${rulings.unconfirmed.join(', ') || 'none'}\n` +
      `Only CONFIRMED entities may be items.` : '') +
    (origin ? `\n\nORIGIN CHECK: the earliest source found [${sid[origin.page]}] (${origin.date}) says: "${origin.quote}". That is not the claim as worded: ${origin.says}. ` +
      `Later articles that repeat the viral version are retellings, not confirmation. The headline must not answer yes; say what the original actually said.` : '');
  let ans = null, problems = [];
  const writeSys = writeSystem(today);
  for (let attempt = 0; attempt < WRITE_TRIES; attempt++) {
    const last = attempt === WRITE_TRIES - 1;
    const obj = await llm('write', writeSys, writeUser + (problems.length ? `\n\nYour previous draft had problems, fix them: ${problems.join('; ')}` : ''), WRITE_FORMAT, 2500);
    trace.calls.write++;
    if (!obj) { problems = ['the reply was not valid JSON or was too long; keep it short']; continue; }
    ans = obj;
    const evNums = new Set(numsIn(evidence));
    const textAll = [ans.headline, ans.verdict, ...ans.items.map((i) => i.name + ' ' + i.point + ' ' + i.caveat)].join(' ');
    const bad = [...new Set(numsIn(textAll))].filter((n) => !evNums.has(n) && !/^(19|20)\d\d$/.test(n) && !(+n <= 10 && Number.isInteger(+n)));
    const badSrc = ans.items.flatMap((i) => i.sources).filter((n) => !used.some((p) => sid[p] === n));
    const cites = citesIn(ans.verdict).filter((n) => !used.some((p) => sid[p] === n));
    problems = [];
    if (bad.length) problems.push('these numbers are not in the evidence: ' + bad.join(', '));
    if (badSrc.length || cites.length) problems.push('these source ids do not exist: ' + [...badSrc, ...cites].join(', '));
    // "confirmed" over vendor claims; dates outside the period; items outside the region (shared/deep-checks.js)
    const oc = overclaims(ans);
    if (oc && last) { ans.headline = soften(ans.headline); ans.verdict = soften(ans.verdict); trace.softened = true; }
    else if (oc) problems.push(oc);
    const old = outOfPeriod(ans, datesOf, cut), away = outOfRegion(ans, reg);
    if (last && (old.length || away.length)) {
      const out = new Set([...old, ...away]);
      ans.items = ans.items.filter((it) => !out.has(it.name)); trace.droppedOutOfScope = [...out];
    } else {
      if (old.length) problems.push(`these items are dated before ${cut}, outside the period the question asks about: ${old.join(', ')}; remove them from the items (you may mention them once in the limits)`);
      if (away.length) problems.push(`these items are outside ${reg.name}, the region the question asks about: ${away.join(', ')}; remove them`);
    }
    if (origin && affirms(ans.headline)) {
      if (last) { ans.headline = `Not as claimed: the earliest source (${origin.date}) says "${origin.quote}" [${sid[origin.page]}]`; trace.originOverride = true; }
      else problems.push(`the headline says yes, but the earliest source [${sid[origin.page]}] says something different ("${origin.quote}"); say what the original said`);
    }
    const awayText = outOfRegionText(ans.headline + ' ' + ans.verdict, reg);
    if (awayText.length && !last) problems.push(`the headline or verdict leads with places outside ${reg.name}: ${awayText.join(', ')}; answer for ${reg.name} only (you may mention them once in the limits)`);
    // every verdict sentence and every item against the evidence it cites (the figure
    // check passed "n8n is profitable": the numbers were real, the claim was not)
    if (!problems.length && !late()) {
      const ev = (ids) => (ids.length ? ids : used.map((p) => sid[p])).map((n) => evidence.split('\n\n').find((b) => b.startsWith(`[${n}]`)) || '').join('\n\n') +
        (rel ? `\n\nCONFIRMED: ${rulings.confirmed.join(', ') || 'none'}\nRULED OUT: ${rulings.ruledOut.join(', ') || 'none'}` : '');
      const claims = [...sentencesOf(ans.verdict).map((s) => ({ s, ids: citesIn(s), where: 'verdict' })),
        ...ans.items.map((it, i) => ({ s: `${it.name}: ${it.point}`, ids: it.sources, where: 'item ' + (i + 1) }))];
      const unsupported = [];
      for (const c of claims) {
        if (c.s.replace(/\[\d+\]/g, '').trim().length < 25 || /\b(evidence|could not|couldn't|not (found|confirmed|disclosed|verified)|unclear|unknown|no (named|verified|confirmed))\b/i.test(c.s)) continue;
        const r = await llm('check', CHECK_SYSTEM, `Statement: ${c.s.replace(/\[\d+\]/g, '')}\n\nEvidence notes:\n${ev(c.ids)}`, VERIFY_FORMAT, 300);
        trace.calls.check++;
        if (r && r.verdict !== 'supported') unsupported.push({ ...c, why: r.why });
      }
      trace.unsupported = (trace.unsupported || []).concat(unsupported.map((u) => `${u.where}: ${u.s} -- ${u.why}`));
      if (unsupported.length) {
        problems.push('these statements go beyond the evidence; remove them or say only what the evidence says: ' + unsupported.map((u) => `"${u.s}" (${u.why})`).join('; '));
        if (last) { const drop = new Set(unsupported.filter((u) => u.where.startsWith('item')).map((u) => +u.where.split(' ')[1] - 1));
          ans.items = ans.items.filter((_, i) => !drop.has(i)); trace.droppedItems = drop.size; }
      }
    }
    if (!problems.length) break;
  }
  trace.writeProblems = problems;
  // a thin answer never gets a firm headline; say so when the newest source is old (shared/deep-checks.js)
  if (ans) {
    const before = ans.headline;
    ans = hedgeHeadline(ans);
    if (ans.headline !== before) trace.hedged = before;
    const cites = new Set([...ans.items.flatMap((i) => i.sources), ...citesIn(ans.verdict)]);
    const stale = staleLimit(used.filter((p) => cites.has(sid[p])).map(pageDate), today);
    if (stale && !ans.limits.some((l) => /newest source|carried a date/i.test(l))) ans.limits = [...ans.limits, stale];
  }
  lap('write', t);

  // ---------------- render
  const outLines = rel && ans ? ruledOutLines(rulings.ruledOutInfo.map((r) => ({ ...r, source: sid[r.page] })), plan.search_name) : [];
  trace.ruledOutShown = outLines;
  const outSrc = outLines.flatMap((l) => citesIn(l));
  const cited = ans ? [...new Set([...ans.items.flatMap((i) => i.sources), ...citesIn(ans.verdict), ...outSrc])].filter((n) => used.some((p) => sid[p] === n)).sort((a, b) => a - b) : [];
  const sources = cited.map((n) => { const pg = pages[used.find((q) => sid[q] === n)]; return { n, title: pg.title || hostOf(pg.url), url: pg.url, date: pg.date || '' }; });
  const sourceLine = (n) => { const s = sources.find((x) => x.n === n); return `[${n}] ${s.title ? s.title.slice(0, 80) + ' - ' : ''}${s.url}${s.date ? ' (' + s.date + ')' : ''}`; };
  const checks = ans ? checkThese(ans.items, verified.filter((f) => f.quote && sid[f.page]).map((f) => ({ entity: f.entity, quote: f.quote, n: sid[f.page], url: pages[f.page].url }))) : [];
  trace.checks = checks;
  const reply = renderDeep({ ans, outLines, sourceLine, cited, checks });
  trace.answer = ans;
  trace.pages = pages.map((p) => ({ url: p.url, via: p.via, chars: p.text.length }));
  trace.findings = findings.length;
  trace.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  return { reply, answer: ans, sources, trace };
}

module.exports = { deepResearch, deepTemplates, subjectOnly, canonicalRepo, lookalike, entKey, quoteFound, recoverJson, hostOf, cleanPage, chunksOf, renderDeep, REL_GOOD };
