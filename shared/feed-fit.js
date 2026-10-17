// Feed replies that list items: say how many are shown, and check that the
// items are what was asked for (2026-10-17).
// "anything on products using the reverse engineer anything repo?" got "The feed
// has 10 items on products using the repo" and 7 items: the repo, two copies of
// it, articles about it. None was a product built with it, and 3 of the 10 were
// silently dropped. The prompt already said "never present items as being about
// the topic unless they are"; the 9B ignored it. So both checks live in code.

// "7. Title — why" lines: the tool's n, as rule 7 of the prompt asks
const LISTED = /^\s*(\d{1,3})[.)]\s+\S/gm;
// "10 items", "20 results" in the intro (before the first listed line)
const CLAIM = /\b(\d{1,3})\s+(items?|results?|articles?|matches|stories|pieces|entries)\b/i;

function listedNs(reply) {
  const ns = [];
  for (const m of String(reply || '').matchAll(LISTED)) ns.push(Number(m[1]));
  return ns;
}

// "The feed has 10 items on X. Here are the top ones:" + 7 lines
// -> "The feed has 10 matches (7 shown) on X. ..."
function fixCount(reply) {
  const r = String(reply || '');
  const shown = listedNs(r).length;
  if (!shown) return r;
  const first = r.search(/^\s*\d{1,3}[.)]\s+\S/m);
  const intro = first > 0 ? r.slice(0, first) : '';
  const m = CLAIM.exec(intro);
  if (!m) return r;
  const claimed = Number(m[1]);
  if (claimed === shown) return r;
  const fixed = claimed > shown ? claimed + ' matches (' + shown + ' shown)' : shown + ' ' + m[2];
  return intro.slice(0, m.index) + fixed + intro.slice(m.index + m[0].length) + r.slice(first);
}

// WF-31's evidence: a passage {text}, a list of them, or headline fragments.
// Specific answers live here, not in the summary ("ClickHouse acquires Langfuse"
// is in a Reddit post's body): judged on title+summary alone, 12 of 18 real
// answers were called misses.
function evidenceText(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (Array.isArray(e)) return e.map(evidenceText).filter(Boolean).join(' … ');
  if (typeof e === 'object') return evidenceText(e.text != null ? e.text : e.fragments != null ? e.fragments : e.passages);
  return '';
}

// Feed items the tools returned, by n, from any nesting (agent steps, Prefetch)
function itemsByN(sources) {
  const found = new Map();
  const visit = (x, depth) => {
    if (x == null || depth > 8) return;
    if (typeof x === 'string') {
      const s = x.trim();
      if (s[0] === '{' || s[0] === '[') { try { visit(JSON.parse(s), depth + 1); } catch (e) {} }
      return;
    }
    if (Array.isArray(x)) { x.forEach((y) => visit(y, depth + 1)); return; }
    if (typeof x !== 'object') return;
    if (x.n != null && Number(x.id) > 0 && x.title && !found.has(Number(x.n))) {
      found.set(Number(x.n), { n: Number(x.n), title: String(x.title), summary: String(x.summary || ''), evidence: evidenceText(x.evidence) });
    }
    for (const k of Object.keys(x)) if (k !== 'structured' && k !== 'evidence') visit(x[k], depth + 1);
  };
  visit(sources, 0);
  return found;
}

// the items the reply actually shows, in its order
function shownFeedItems(reply, sources) {
  const all = itemsByN(sources);
  return listedNs(reply).map((n) => all.get(n)).filter(Boolean);
}

const FIT_SYSTEM = 'A user asked a question and a search of their news feed returned the items below (title, summary, and a passage from the article). ' +
  'For each item decide whether it gives the user what they asked for. ' +
  'If the question names a topic ("anything on X", "news about X", "what is new with X"), an item mainly about X fits. ' +
  'If it asks for a fact (who, which, how much, when, what did X say), an item fits when its summary or passage states that fact. ' +
  'If it asks for things that stand in a relation to X ("products built with X", "companies using X", "people who left X"), an item fits only if it IS such a thing or names one; an item about X itself, a copy of X, or a general article about X does not. ' +
  'fits: yes = it gives what was asked for; partly = on the topic but not what was asked; no = it only shares words with the question. ' +
  'gap: if no item is a yes, say in at most 15 words what the items are about instead; else empty.';

const FIT_SCHEMA = { type: 'json_schema', json_schema: { name: 'fit', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['items', 'gap'],
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'fits'],
      properties: { n: { type: 'integer' }, fits: { type: 'string', enum: ['yes', 'partly', 'no'] } } } },
    gap: { type: 'string' } } } } };

const EVIDENCE_CHARS = 1000;
function fitBody(model, question, items) {
  const list = items.map((i) => i.n + '. ' + i.title.slice(0, 160) + (i.summary ? '\n   Summary: ' + i.summary.slice(0, 300) : '') +
    (i.evidence ? '\n   Passage: ' + i.evidence.replace(/\s+/g, ' ').slice(0, EVIDENCE_CHARS) : '')).join('\n');
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 60 + 25 * items.length, response_format: FIT_SCHEMA,
    messages: [{ role: 'system', content: FIT_SYSTEM },
      { role: 'user', content: 'Question: ' + String(question || '').slice(0, 500) + '\n\nItems:\n' + list }] };
}

// null = unreadable (the reply stands as it is)
function readFit(content) {
  let j;
  try { j = JSON.parse(String(content || '').replace(/^```(json)?|```$/g, '').trim()); } catch (e) { return null; }
  if (!j || !Array.isArray(j.items) || !j.items.length) return null;
  const yes = j.items.filter((i) => i.fits === 'yes').length;
  return { answers: yes > 0, yes, partly: j.items.filter((i) => i.fits === 'partly').length,
    no: j.items.filter((i) => i.fits === 'no').length, gap: String(j.gap || '').trim().replace(/\.$/, '') };
}

// ---- relation questions: "products built with X", "companies using X" ----
// One call over all items could not hold this rule with thinking off: it took
// the two forks of REA ("Reverse engineer anything with agents" under another
// owner) for products built with REA, 3 runs out of 3, and a stricter wording
// broke two fact questions. Thinking on: 20-80 s and half the calls overran.
// So each item gets its own small call that must NAME the thing and QUOTE the
// sentence, and code checks the quote is in the item and the name is not X.
const RELATION = /\b(products?|apps?|applications?|projects?|tools?|companies|company|startups?|firms?|banks?|brands?|teams?|people|developers?|businesses|services|organi[sz]ations?|governments?|clones?|alternatives?|things)\b[^?.!]{0,50}?\b(built|building|build|made|created|developed|powered|based|using|use|used|uses|adopt(s|ed|ing)?|deploy(s|ed|ing)?)\b/i;
function relationQ(question) { return RELATION.test(String(question || '')); }

const NAMED_SYSTEM = 'The user asked a question about things that stand in a relation to a subject (for example products built with a tool, or companies using it). Below is ONE item from their news feed. ' +
  'Does the item name a specific product, project, company or person, OTHER than the subject itself, and say that it has the relation the question asks about? ' +
  'These do not count: the subject\'s own page, an explainer of what the subject does, a list of tools, or a fork, mirror or copy of the subject (a repo with the subject\'s name or description under another owner). ' +
  'subject = the tool, repo, company or thing the question is about, copied word for word from the question. ' +
  'If it does: names_one true, name = that thing\'s name, quote = the exact sentence from the item that says it. If not: names_one false, name and quote empty.';
const NAMED_SCHEMA = { type: 'json_schema', json_schema: { name: 'named', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['subject', 'names_one', 'name', 'quote'],
  properties: { subject: { type: 'string' }, names_one: { type: 'boolean' }, name: { type: 'string' }, quote: { type: 'string' } } } } };

function itemText(i) { return [i.title, i.summary, i.evidence].filter(Boolean).join('\n'); }

function namedBody(model, question, item) {
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 200, response_format: NAMED_SCHEMA,
    messages: [{ role: 'system', content: NAMED_SYSTEM },
      { role: 'user', content: 'Question: ' + String(question || '').slice(0, 500) + '\n\nItem:\nTitle: ' + item.title.slice(0, 200) +
        (item.summary ? '\nSummary: ' + item.summary.slice(0, 400) : '') +
        (item.evidence ? '\nPassage: ' + item.evidence.replace(/\s+/g, ' ').slice(0, 1500) : '') }] };
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const flat = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Does the item mention the subject at all? The router's search for "products
// using the reverse engineer anything repo" also returned "AI Borked my Keyboard -
// Reversing the Aula F108 Pro", and the 9B named the keyboard: a real quote, not
// the subject's name, but the article never mentions REA. Words like "github
// repo" do not count; an acronym (MCP, REA) matches its spelled-out form.
const GENERIC = new Set(['the', 'a', 'an', 'this', 'that', 'github', 'repo', 'repository', 'tool', 'tools', 'library', 'framework', 'open', 'source', 'project', 'app', 'platform', 'model', 'models', 'ai']);
function mentions(text, subject) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const toks = (String(subject || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => !GENERIC.has(t));
  if (!toks.length) return false;
  const has = (t) => words.some((w) => t.length < 5 ? w === t : w.slice(0, 5) === t.slice(0, 5));
  if (toks.every(has)) return true;
  if (toks.length === 1 && toks[0].length >= 2 && toks[0].length <= 6) {   // acronym: MCP = model context protocol
    const n = toks[0].length;
    for (let k = 0; k + n <= words.length; k++) if (words.slice(k, k + n).map((w) => w[0]).join('') === toks[0]) return true;
  }
  return false;
}
// the name it gave, or null when the claim does not hold up
function readNamed(content, item, question) {
  let j;
  try { j = JSON.parse(String(content || '').replace(/^```(json)?|```$/g, '').trim()); } catch (e) { return null; }
  if (!j || j.names_one !== true) return null;
  const name = String(j.name || '').trim(), quote = flat(j.quote).replace(/^["“]|["”]$/g, '');
  const subject = String(j.subject || '').trim();
  if (squash(name).length < 2 || quote.length < 15) return null;
  if (!flat(itemText(item)).includes(quote)) return null;                 // made-up quote
  if (squash(question).includes(squash(name))) return null;               // it named the subject itself
  if (!squash(subject) || !squash(question).includes(squash(subject))) return null;   // subject not from the question
  if (!mentions(itemText(item), subject)) return null;                    // the item never mentions the subject
  if (!squash(quote).includes(squash(name)) && !squash(itemText(item)).includes(squash(name))) return null;
  return name;
}

// shown when the items miss and no web answer replaces the reply
function missNote(gap) {
  return 'None of these answer your question directly' + (gap ? ': ' + gap : '') + '. The closest items in your feed:\n\n';
}

module.exports = { listedNs, fixCount, evidenceText, itemsByN, shownFeedItems, fitBody, readFit, relationQ, namedBody, readNamed, missNote, FIT_SYSTEM, NAMED_SYSTEM };
