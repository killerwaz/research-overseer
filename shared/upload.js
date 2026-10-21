// #18 PDFs sent as files in Telegram (2026-10-21). Inlined into WF-00 ('Extract
// messages', 'PDF prep', 'PDF reply') and read by WF-20 (pre-read documents).
//
// Pasted PDF LINKS already worked (WF-20 'Is PDF?' -> Firecrawl). A FILE is
// different: its download URL carries the bot token, so it must never reach a
// third party or the database. WF-00 downloads it inside n8n, n8n's own PDF
// extraction reads the text, and WF-20 takes the text as a pre-read document
// (no scraper), then the usual saved page -> triage -> passages -> summary.

const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;   // Telegram bots can download up to 20 MB
const UPLOAD_MIN_CHARS = 300;                 // less = a scanned PDF with no text layer
const UPLOAD_MAX_CHARS = 400000;              // a ~150-page report; triage reads the opening anyway

// The document in a Telegram message, or null.
function uploadInfo(message) {
  const d = (message || {}).document;
  if (!d || !d.file_id) return null;
  const name = String(d.file_name || 'document').slice(0, 200);
  const pdf = /pdf/i.test(String(d.mime_type || '')) || /\.pdf$/i.test(name);
  return { kind: pdf ? 'pdf' : 'other', file_id: String(d.file_id), unique_id: String(d.file_unique_id || d.file_id),
    name, size: Number(d.file_size) || 0, caption: String((message || {}).caption || '').slice(0, 1000) };
}

// What the message "says" for dedupe, the allowlist and memory: the file is visible
// in the chat history as "[file] name — caption".
function uploadText(info) {
  return '[file] ' + info.name + (info.caption ? ' — ' + info.caption : '');
}

// A stable identity for dedupe (same file sent twice = same page). Not a link.
function uploadCanonical(info) {
  const slug = String(info.name).toLowerCase().replace(/\.pdf$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
  return 'upload://telegram/' + String(info.unique_id).replace(/[^A-Za-z0-9_-]/g, '') + '/' + slug + '.pdf';
}

// Refuse before downloading: not a PDF, or too big for a bot.
function uploadGate(info) {
  if (!info) return { ok: false, reply: '' };
  if (info.kind !== 'pdf') return { ok: false, reply: 'I can only read PDFs for now — "' + info.name + '" is not one. Send it as a PDF, or paste a link to it.' };
  if (info.size > UPLOAD_MAX_BYTES) return { ok: false, reply: '"' + info.name + '" is ' + Math.round(info.size / 1048576) + ' MB; Telegram lets bots download files up to 20 MB. Paste a link to it instead and I will read it from there.' };
  return { ok: true };
}

// Collapses the PDF text extraction's line-per-line output into paragraphs.
function cleanPdfText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/-\n(?=[a-z])/g, '')            // words hyphenated across lines
    .replace(/([^\n.!?:;])\n(?=[a-z(])/g, '$1 ')  // a sentence broken across lines
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, UPLOAD_MAX_CHARS);
}

// The PDF's title: its metadata title when it looks like one; else a title-like
// line near the top when the file name is thin ("attention.pdf" is "Attention Is
// All You Need" on its first page, after a licence line); else the file name.
function uploadTitle(info, meta) {
  const t = String(((meta || {}).info || {}).Title || (meta || {}).title || '').trim();
  if (t.length >= 6 && !/^(untitled|microsoft word|document\d*|slide \d+)/i.test(t) && !/\.(docx?|pptx?|indd)$/i.test(t)) return t.slice(0, 200);
  const fromName = String(info.name).replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
  if (fromName.split(/\s+/).length <= 2) {
    const lines = String((meta || {}).text || '').slice(0, 1500).split(/\n+/).map((l) => l.trim());
    const line = lines.find((l) => {
      const w = l.split(/\s+/).length;
      return w >= 3 && w <= 16 && l.length <= 140 && !/[.;,]$/.test(l) && /^[A-Z0-9]/.test(l) &&
        !/(copyright|©|permission|licen[cs]e|arxiv|https?:|doi|preprint|draft|confidential|page \d|\d{4}-\d{2}-\d{2}|@)/i.test(l);
    });
    if (line) return line;
  }
  return fromName;
}

// After extraction: the WF-20 input, or why not. pages from the extractor.
function uploadPrep(info, extracted) {
  const e = extracted || {};
  const text = cleanPdfText(e.text);
  const pages = Number(e.numpages || e.numPages || 0);
  if (text.length < UPLOAD_MIN_CHARS) {
    return { ok: false, reply: '"' + info.name + '" has no readable text' + (pages ? ' (' + pages + ' page' + (pages === 1 ? '' : 's') + ')' : '') +
      ' — it looks like a scan. I cannot read scanned PDFs yet; a link to a text version would work.' };
  }
  const title = uploadTitle(info, e);
  const markdown = '# ' + title + '\n\n' + (info.caption ? 'Sent with the note: ' + info.caption + '\n\n' : '') + text;
  return { ok: true, pages, title,
    urls: [{ url: uploadCanonical(info), title, markdown, scraper: 'upload:pdf', source: 'upload' }],
    reply: '\u{1F4C4} Reading "' + title + '"' + (pages ? ' (' + pages + ' page' + (pages === 1 ? '' : 's') + ')' : '') +
      '. The summary arrives in about a minute.' };
}

module.exports = { UPLOAD_MAX_BYTES, UPLOAD_MIN_CHARS, uploadInfo, uploadText, uploadCanonical, uploadGate, cleanPdfText, uploadTitle, uploadPrep };
