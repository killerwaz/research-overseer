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
function chunkTranscript(md, opts) {
  const size = (opts && opts.size) || CHUNK_SIZE, max = (opts && opts.max) || CHUNK_MAX;
  const src = String(md || '');
  const at = src.indexOf('## Transcript');
  const lines = (at >= 0 ? src.slice(at + '## Transcript'.length) : src).split('\n');
  const chunks = [];
  let cur = '', start = null;
  const flush = () => { if (cur.trim()) chunks.push({ text: cur.trim(), start_s: start }); cur = ''; start = null; };
  for (const raw of lines) {
    const m = raw.match(/^\s*\[(\d+(?::\d{2}){1,2})\]\s*(.*)$/);
    const text = (m ? m[2] : raw).trim();
    if (!text) continue;
    if (cur && cur.length + 1 + text.length > size) flush();
    if (start === null && m) start = parseTs(m[1]);
    cur = cur ? cur + ' ' + text : text;
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

module.exports = { CHUNK_SIZE, CHUNK_MAX, MIN_DOC_CHARS, classifyLines, cleanMarkdown, chunkText, chunkTranscript, chunkDoc };
