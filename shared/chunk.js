// Cleaning and chunking for passage search (#12).
//
// Saved pages are scraper markdown with the site around the article still in
// it: menus, cookie banners, share buttons, "related articles" teasers,
// Cloudflare challenge text. Measured 2026-10-11: firecrawl pages average 158
// links, crawl4ai 57. Passages cut from raw pages would match menus, so every
// line is classified first (classifyLines — the workbench shows the reasons),
// then the kept text is cut at line boundaries into ~2,500-char passages.
//
// Video/podcast docs (scraper 'media:*') are transcripts with "[m:ss] text"
// lines; their passages keep the start time of their first line (start_s) so
// an answer can link to the moment.

const CHUNK_SIZE = 2500;
const CHUNK_MAX = 40;        // 100k chars; longer pages are cut short
const MIN_DOC_CHARS = 400;   // less than this after cleaning = not an article

const JUNK = new RegExp([
  'cookie', 'consent', 'privacy (policy|statement|choice)', 'subscribe', 'newsletter', 'sign (in|up)', 'log ?in',
  'share (on|this|via)', '^share$', 'skip to', 'checking your browser', 'verif(y|ying|ication)', 'troubleshoot',
  'read more', 'view all', 'show all', 'no result', 'advertis', 'promoted', 'all rights reserved', '©', 'copyright',
  'loading\\.\\.\\.', 'javascript', 'download (pdf|file)', 'save article', 'cite this', 'follow us', 'back to top',
  'accept all', 'reject optional', 'manage preferences', 'oops, something went wrong', 'try again later',
  'by submitting your email', 'loading the next article', 'error loading', 'recaptcha', 'leave a reply', 'required fields are marked',
  'save my name', 'email address will not be published', 'your privacy', 'similar content', 'link copied', 'your cart', 'continue shopping', 'image credits?', 'photo by', 'getty images', '^success!$'
].join('|'), 'i');

// A heading like these, once past FOOTER_AFTER of the page's text, starts the
// footer: everything from it on is dropped (related links, comments, about).
const FOOTER = /^(related|more (from|on|in)|you (may|might) also|read (next|more)|recommended|popular|trending|editor'?s (choice|picks)|latest (news|articles|stories)|leave a (reply|comment)|comments?( section)?$|about( us| the author)?$|topics$|contact( us)?$|channels$|follow us|newsletter|some important)/i;
const FOOTER_AFTER = 0.4;

const IMG = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g;

// The words a reader sees on the line: images gone, links reduced to their text.
function visible(line) {
  return line.replace(IMG, '').replace(LINK, '$1').replace(/\\+/g, '').replace(/\*\*|__/g, '').trim();
}

function linkTextShare(line) {
  const noImg = line.replace(IMG, '');
  let linked = 0;
  noImg.replace(LINK, (m, t) => { linked += t.trim().length; return m; });
  const vis = visible(line).replace(/^[#>*\-\s]+/, '').length;
  return vis ? linked / vis : 0;
}

function classifyLines(md) {
  const seen = new Set();
  const lines = String(md == null ? '' : md).split('\n');
  const total = lines.reduce((a, l) => a + visible(l).length, 0);
  let sofar = 0, footer = false;
  const out = lines.map((line) => {
    const t = line.trim();
    const v = visible(t);
    const body = v.replace(/^(#{1,6}|[*\-+>]|\d+[.)])\s*/, '').trim();
    const words = body ? body.split(/\s+/).length : 0;
    const heading = /^#{1,6}\s/.test(t);
    const table = /^\|/.test(t);
    const drop = (reason) => ({ line, keep: false, reason });
    sofar += v.length;

    if (footer) return drop('footer');
    if (heading && FOOTER.test(body) && sofar > total * FOOTER_AFTER) { footer = true; return drop('footer'); }

    if (!t) return { line, keep: true, reason: '' };
    if (!body) return drop(t.match(IMG) ? 'image' : 'no text');
    if (table) return /^\|[\s|:-]*\|?$/.test(t) || body.replace(/[|\s]/g, '') ? { line, keep: true, reason: '' } : drop('empty table row');
    if (body.length < 300 && JUNK.test(body)) return drop('site chrome');
    const share = linkTextShare(t);
    if (share > 0.8 || (share > 0.6 && body.length < 300)) return drop('link line');
    if (/(\.\.\.|…)$/.test(body) && body.length < 200) return drop('teaser');
    if (!heading && words <= 3 && !/[.!?:%$\d]/.test(body)) return drop('short label');
    const key = body.toLowerCase();
    if (seen.has(key)) return drop('repeat');
    seen.add(key);
    return { line, keep: true, reason: '' };
  });
  // A short heading followed by a heading of the same or higher level (or by
  // nothing) heads an empty section: menu titles like "### Finance" or
  // "## Navigation". A heading over a sub-heading ("## FAQ" -> "### Q") stays.
  let next = 1; // level of what follows: 0 = prose; the end of the page counts as a top heading
  for (let i = out.length - 1; i >= 0; i--) {
    const t = out[i].line.trim();
    if (!out[i].keep || !t) continue;
    const m = t.match(/^(#{1,6})\s/);
    const level = m ? m[1].length : 0;
    const short = t.replace(/^#+\s*/, '').split(/\s+/).length <= 4;
    if (level && short && next && next <= level) {
      out[i] = { line: out[i].line, keep: false, reason: 'empty section' };
      continue;
    }
    next = level;
  }
  return out;
}

// Kept lines with links reduced to their text and blank runs collapsed.
function cleanMarkdown(md) {
  const out = [];
  for (const l of classifyLines(md)) {
    if (!l.keep) continue;
    const t = /^\s*\|/.test(l.line) ? l.line.trim() : visible(l.line);
    if (!t && (!out.length || out[out.length - 1] === '')) continue;
    out.push(t);
  }
  return out.join('\n').trim();
}

// Long units are split at sentence ends, then hard-cut as a last resort.
function splitLong(unit, size) {
  if (unit.length <= size) return [unit];
  const parts = [];
  let cur = '';
  for (const s of unit.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + 1 + s.length > size) { parts.push(cur); cur = ''; }
    cur = cur ? cur + ' ' + s : s;
    while (cur.length > size) { parts.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) parts.push(cur);
  return parts;
}

// Packs lines into passages of up to `size` chars. A heading starts a new
// passage once the current one is at least half full, so sections stay whole.
function chunkText(text, opts) {
  const size = (opts && opts.size) || CHUNK_SIZE, max = (opts && opts.max) || CHUNK_MAX;
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const line of String(text || '').split('\n')) {
    for (const unit of splitLong(line, size)) {
      if (/^#{1,6}\s/.test(unit) && cur.length >= size / 2) flush();
      if (cur && cur.length + 1 + unit.length > size) flush();
      cur = cur ? cur + '\n' + unit : unit;
    }
  }
  flush();
  return chunks.slice(0, max).map((t, i) => ({ n: i + 1, text: t, start_s: null }));
}

function parseTs(s) {
  const p = s.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

// "[m:ss] text" lines under "## Transcript"; anything before that heading is
// the header block (title, Channel:, Screen:) and is dropped.
// A media doc is a header (title, Channel:, Screen:) and "## " sections:
// Chapters, On screen (the 9B's reading of slides and code), Transcript.
// Every section becomes passages of its own; the header does not. Fixed
// 2026-10-12: the first version kept only the Transcript, which dropped every
// chapter list and every screen reading — "/usage" lived only in a chapter
// title, so "which command shows my usage?" failed 3 runs out of 3.
// Transcript lines lose their [m:ss] (it becomes start_s); chapter and
// on-screen lines keep it inline, so the answer can cite the time.
function chunkTranscript(md, opts) {
  const size = (opts && opts.size) || CHUNK_SIZE, max = (opts && opts.max) || CHUNK_MAX;
  const src = String(md || '');
  const sectioned = /^## /m.test(src);
  const chunks = [];
  let section = sectioned ? null : 'Transcript';   // null = the header, skipped
  let cur = '', start = null;
  const flush = () => { if (cur.trim() && cur.trim() !== section + ':') chunks.push({ text: cur.trim(), start_s: start }); cur = ''; start = null; };
  for (const raw of src.split('\n')) {
    const h = raw.match(/^##\s+(.+?)\s*$/);
    if (h) {
      flush();
      section = /^transcript/i.test(h[1]) ? 'Transcript' : h[1].replace(/\s*\(.*\)\s*$/, '');
      if (section !== 'Transcript') cur = section + ':';
      continue;
    }
    if (section === null) continue;
    const m = raw.match(/^\s*\[(\d+(?::\d{2}){1,2})\]\s*(.*)$/);
    const keepTs = section !== 'Transcript';
    const text = (m && !keepTs ? m[2] : raw).trim();
    if (!text) continue;
    if (cur && cur.length + 1 + text.length > size) {
      flush();
      if (keepTs) cur = section + ':';
    }
    if (start === null && m) start = parseTs(m[1]);
    cur = cur ? cur + (keepTs ? '\n' : ' ') + text : text;
  }
  flush();
  return chunks.slice(0, max).map((c, i) => ({ n: i + 1, text: c.text, start_s: c.start_s }));
}

function chunkDoc(doc) {
  const d = doc || {};
  if (/^media:/.test(d.scraper || '')) {
    const chunks = chunkTranscript(d.markdown);
    return { cleaned_chars: chunks.reduce((a, c) => a + c.text.length, 0), chunks };
  }
  const text = cleanMarkdown(d.markdown);
  if (text.length < MIN_DOC_CHARS) return { cleaned_chars: text.length, chunks: [] };
  return { cleaned_chars: text.length, chunks: chunkText(text) };
}

// What gets embedded: the passage with its article title in front, so "the
// company raised $2B" still knows which company. Mostly non-Latin text
// (Bengali items) costs several times more tokens per char; the embedding
// model runs at context 2048, so those passages are embedded from their first
// 1,500 chars. The stored text is always the whole passage.
function passageText(title, text) {
  const t = String(text || '');
  const nonAscii = (t.match(/[^\x00-\x7F]/g) || []).length;
  const body = nonAscii > t.length * 0.3 ? t.slice(0, 1500) : t;
  return (title ? String(title).trim().slice(0, 200) + '\n' : '') + body;
}

// One statement pair that replaces a doc's passages: delete, then insert
// from a single JSON payload. Passage text is web content, so it travels
// base64-encoded: no quote, '$' or backslash of it ever reaches the SQL
// text. Measured 2026-10-12: a plain literal containing "$785606.5" fails
// inside n8n's Postgres node ("$142.75" and "$785606" pass) — n8n reads
// some $-digit runs as parameters even inside a string. Same fix as WF-00's
// 'Fix memory'. toVector validates each embedding.
function chunkStoreSql(rawDocId, chunks, vectors, toVector) {
  const id = Number(rawDocId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('bad raw_doc_id: ' + rawDocId);
  if (!Array.isArray(chunks) || !Array.isArray(vectors) || chunks.length !== vectors.length) {
    throw new Error('chunks and vectors differ in length');
  }
  const del = 'delete from doc_chunks where raw_doc_id = ' + id + ';';
  if (!chunks.length) return del;
  const rows = chunks.map((c, i) => ({ n: Number(c.n), text: String(c.text).replace(/\u0000/g, ''),
    start_s: c.start_s == null ? null : Math.round(Number(c.start_s)), e: toVector(vectors[i]) }));
  const b64 = Buffer.from(JSON.stringify(rows), 'utf8').toString('base64');
  return del + ' insert into doc_chunks (raw_doc_id, n, text, start_s, embedding) select ' + id +
    ", r.n, r.text, r.start_s, r.e::vector from jsonb_to_recordset(convert_from(decode('" + b64 +
    "', 'base64'), 'UTF8')::jsonb) as r(n int, text text, start_s int, e text);";
}

module.exports = { passageText, chunkStoreSql, CHUNK_SIZE, CHUNK_MAX, MIN_DOC_CHARS, classifyLines, cleanMarkdown, chunkText, chunkTranscript, chunkDoc };
