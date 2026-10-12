// Spelling fixer for feed search (#14, 2026-10-13). Inlined into WF-31.
//
// Measured on 33 names from his feed, 66 typos (scratchpad eval, 2026-10-13):
// with the right spelling feed search found 33/33, with one typo 9/66 — keyword
// search needs the exact word and meaning search does not rescue a name.
// A fixer with no model cannot tell a typo from a real name the feed lacks:
// nearest-spelling fixed 154/165 typos but "fixed" 10/23 absent names
// (paystack -> haystack, kaggle -> toggle); pg_trgm was worse (pathoa -> path).
// So: a word that is NOT in vocab_words (sql/016: article text, feed titles and
// summaries, his chats) gets its one-edit neighbours that ARE, and the 9B
// (thinking off, ~0.2 s) says which one he meant, or none. Measured: 138/165
// typos fixed, 4 changed to another real name (rahhat -> rahman), 22/23 absent
// names left alone.

const SPELL_MIN_LEN = 4;
const SPELL_MAX_WORDS = 4;
const SPELL_MAX_CANDS = 3;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

// Words in the search topic worth checking.
function spellWords(tag) {
  const out = [];
  for (const w of String(tag || '').toLowerCase().split(/[^a-z0-9-]+/)) {
    if (w.length >= SPELL_MIN_LEN && /^[a-z][a-z-]*$/.test(w) && !out.includes(w)) out.push(w);
  }
  return out.slice(0, SPELL_MAX_WORDS);
}

// Every string one edit away (delete, swap neighbours, replace, insert).
function edits1(word) {
  const w = String(word), out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
    for (const c of LETTERS) {
      if (b) out.add(a + c + b.slice(1));
      out.add(a + c + b);
    }
  }
  out.delete(w);
  return [...out];
}

// One row back: known = the words already in the vocabulary, cands = their
// neighbours that are. Sent base64 (web text and $-runs: CLAUDE.md).
function spellLookupSql(words) {
  const rows = [];
  for (const w of words || []) {
    rows.push({ w, e: w });
    for (const e of edits1(w)) rows.push({ w, e });
  }
  if (!rows.length) return 'select null::text as known, null::text as cands';
  const b64 = Buffer.from(JSON.stringify(rows), 'utf8').toString('base64');
  return "with x as (select * from jsonb_to_recordset(convert_from(decode('" + b64 + "', 'base64'), 'UTF8')::jsonb) as x(w text, e text)) " +
    'select (select json_agg(distinct x.w)::text from x join vocab_words v on v.word = x.e where x.e = x.w) as known, ' +
    "(select json_agg(json_build_object('w', x.w, 'c', v.word, 'n', v.ndoc))::text from x join vocab_words v on v.word = x.e where x.e <> x.w) as cands";
}

const asList = (v) => { if (Array.isArray(v)) return v; try { const p = JSON.parse(String(v || 'null')); return Array.isArray(p) ? p : []; } catch (e) { return []; } };

// Words to ask about: not in the vocabulary, with at least one neighbour that is.
function spellQuestions(words, known, cands) {
  const k = new Set(asList(known)), c = asList(cands), out = [];
  for (const w of words || []) {
    if (k.has(w)) continue;
    const list = c.filter((r) => r.w === w).sort((a, b) => Number(b.n) - Number(a.n)).slice(0, SPELL_MAX_CANDS).map((r) => r.c);
    if (list.length) out.push({ typed: w, cands: list });
  }
  return out;
}

const SPELL_SYSTEM = 'You fix typos in names. The user typed a word that does not appear anywhere in their research feed. Below are words that DO appear in the feed and are spelled similarly. ' +
  'If the typed word is clearly a misspelling of one of them (the same company, person, product or place), answer with that word. ' +
  'If the typed word is a real, different name or word in its own right (even one you do not know), or you are unsure, answer "none". Never pick a word just because it looks similar.';
const SPELL_SCHEMA = { type: 'json_schema', json_schema: { name: 'v', strict: true, schema: {
  type: 'object', properties: { meant: { type: 'string' } }, required: ['meant'], additionalProperties: false } } };

function spellJudgeBody(model, message, typed, cands) {
  return { model, temperature: 0, reasoning_effort: 'none', max_tokens: 60, response_format: SPELL_SCHEMA,
    messages: [{ role: 'system', content: SPELL_SYSTEM },
      { role: 'user', content: 'Message: "' + String(message || '').slice(0, 400) + '"\nTyped word: "' + typed + '"\nSimilar words in the feed: ' +
        cands.map((c) => '"' + c + '"').join(', ') + '\nJSON: {"meant": one of those words, or "none"}' }] };
}

// The chosen word, or null (none, unreadable, or not one of the offered words).
function readSpell(content, cands) {
  try {
    const m = String(JSON.parse(String(content || '').trim()).meant || '').toLowerCase().trim();
    return (cands || []).includes(m) ? m : null;
  } catch (e) { return null; }
}

// fixes = [{ typed, meant }]; whole words, any case.
function applySpelling(tag, fixes) {
  let t = String(tag || '');
  for (const f of fixes || []) {
    if (!f || !f.meant) continue;
    t = t.replace(new RegExp('(^|[^a-z0-9-])' + f.typed.replace(/[-]/g, '\\-') + '(?=$|[^a-z0-9-])', 'gi'), (m, pre) => pre + f.meant);
  }
  return t;
}

module.exports = { spellWords, edits1, spellLookupSql, spellQuestions, spellJudgeBody, readSpell, applySpelling, SPELL_MAX_CANDS };
