// Media links (YouTube, podcasts, audio) in WF-20: detection, the transcript
// markdown that triage reads, the key-points skill, and the Telegram message.
// Inlined into WF-20 Code nodes; tests/media.test.js covers it.
//
// The transcript itself comes from media/server.py (native on Windows):
// human captions -> auto-captions -> Parakeet speech-to-text.

// Hosts yt-dlp handles that carry talk worth summarising. Direct audio files
// count too (a podcast episode's enclosure URL).
const MEDIA_HOST = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|vimeo\.com|soundcloud\.com|podcasts\.apple\.com|twitch\.tv|ted\.com\/talks|rumble\.com)(?:[\/?#]|$)/i;
const AUDIO_FILE = /\.(mp3|m4a|aac|wav|ogg|opus|flac|mp4|webm)(\?|#|$)/i;
// YouTube pages that are not one video (channels, playlists, search) are not media items
const YT_NOT_VIDEO = /youtube\.com\/(?:@|c\/|channel\/|user\/|playlist|results|feed)/i;

function isMediaUrl(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u) || YT_NOT_VIDEO.test(u)) return false;
  return MEDIA_HOST.test(u) || AUDIO_FILE.test(u.split('?')[0] + (u.includes('?') ? '?' : ''));
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? h + ':' + p(m) + ':' + p(sec) : m + ':' + p(sec);
}

// "1:02:05" / "12:30" / "45" -> seconds, or null
function parseTs(t) {
  const m = String(t == null ? '' : t).trim().replace(/^\[|\]$/g, '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$|^(\d+)$/);
  if (!m) return null;
  if (m[4] != null) return Number(m[4]);
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const SOURCE_LABEL = { 'captions-manual': 'creator captions', 'captions-auto': 'YouTube auto-captions', parakeet: 'speech-to-text (Parakeet)' };

// What triage reads: a header the model can cite, then [m:ss] paragraphs.
function mediaMarkdown(t) {
  const lines = [];
  lines.push('# ' + (t.title || 'Untitled'));
  const meta = [t.channel && 'Channel: ' + t.channel, t.duration && 'Length: ' + mmss(t.duration),
    t.published_at && 'Published: ' + t.published_at, 'Transcript: ' + (SOURCE_LABEL[t.source] || t.source)].filter(Boolean);
  lines.push(meta.join(' | '));
  if (t.chapters && t.chapters.length) {
    lines.push('', '## Chapters');
    for (const c of t.chapters) lines.push('[' + mmss(c.start) + '] ' + c.title);
  }
  if (t.slides && t.slides.length) {
    lines.push('', '## On screen (slides, charts, code; machine-read from video frames, may contain misreads)');
    for (const s of t.slides) lines.push('[' + mmss(s.start) + '] ' + s.text);
  }
  lines.push('', '## Transcript');
  for (const p of t.paragraphs || []) lines.push('[' + mmss(p.start) + '] ' + p.text);
  return lines.join('\n');
}

// Merged into the triage call for media documents (same mechanism as query skills).
const MEDIA_SKILL_PROMPT =
  'This CONTENT is a timestamped transcript of a video or podcast. Lines start with [m:ss]. ' +
  'In addition to the standard fields, return key_points: 6 to 12 of the most important, concrete points ' +
  '(claims, numbers, names, decisions, how-tos), in the order they are made. For each, t is the [m:ss] timestamp ' +
  'of the transcript line where it is made, copied exactly from the transcript (never invented), and point is one ' +
  'self-contained sentence. Prefer specifics over generalities; skip intros, sponsor reads and calls to subscribe. ' +
  'The On screen section is machine-read from video frames: use it for figures and names shown on slides, but when it ' +
  'disagrees with what is said in the transcript, trust the transcript.';
const MEDIA_SKILL_SCHEMA = {
  key_points: { type: 'array', items: { type: 'object', additionalProperties: false,
    properties: { t: { type: 'string' }, point: { type: 'string' } }, required: ['t', 'point'] } }
};

// Link that opens the video at a moment. YouTube only; other hosts get none.
function timeLink(canonicalUrl, seconds) {
  const m = String(canonicalUrl || '').match(/youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/);
  return m ? 'https://youtu.be/' + m[1] + '?t=' + Math.floor(seconds) : null;
}

// The 9B gets the facts right but approximates timestamps (measured on the IBM
// video: 2 of 4 checked points pointed at the wrong moment, one at a time that
// is not in the transcript). Snap each point to the transcript line that shares
// the most words with it, preferring lines near the model's guess; keep the
// model's time when nothing matches well.
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'are', 'was', 'from', 'they', 'you', 'have', 'has',
  'its', 'into', 'than', 'then', 'their', 'there', 'which', 'what', 'when', 'will', 'can', 'not', 'but', 'more', 'about', 'each']);
const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
  .filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w)));

function transcriptLines(markdown) {
  const out = [];
  const body = String(markdown || '').split('## Transcript')[1] || '';
  for (const line of body.split('\n')) {
    const m = line.match(/^\[(\d+(?::\d{2}){1,2})\]\s*(.*)$/);
    if (m) out.push({ start: parseTs(m[1]), words: words(m[2]) });
  }
  return out;
}

function snapKeyPoints(points, markdown) {
  const lines = transcriptLines(markdown);
  if (!lines.length || !Array.isArray(points)) return points || [];
  // Measured on the IBM video's 10 points: the model's own times 4/10 right;
  // best-overlap snapping 8/10 right + 1 off by one 30s paragraph. (Trusting
  // the model's time whenever it names a real line scored worse: 1:58 and
  // 7:49 are real lines that share generic words with the wrong points.)
  return points.map((p) => {
    const pw = words(p.point);
    const guess = parseTs(p.t);
    let best = null, bestScore = 0;
    for (const l of lines) {
      let overlap = 0;
      for (const w of pw) if (l.words.has(w)) overlap++;
      const near = guess == null ? 0 : Math.max(0, 1 - Math.abs(l.start - guess) / 120) * 0.5;
      const score = overlap + near;
      if (score > bestScore) { bestScore = score; best = l; }
    }
    // need real lexical evidence (>= 3 shared words) to override the model
    if (best && bestScore >= 3) return { t: mmss(best.start), point: p.point };
    return { t: guess == null ? p.t : mmss(guess), point: p.point };
  });
}

// Telegram (HTML parse mode) message for one summarised media item.
function mediaMessage(item) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const head = '\u{1F3AC} <b>' + esc(item.title) + '</b>' + (item.score != null ? '  (score ' + item.score + '/10)' : '');
  const out = [head];
  if (item.summary) out.push('', esc(item.summary));
  const pts = Array.isArray(item.key_points) ? item.key_points : [];
  if (pts.length) {
    out.push('', '<b>Key points</b>');
    for (const p of pts) {
      const sec = parseTs(p.t);
      const link = sec == null ? null : timeLink(item.canonical_url, sec);
      const stamp = sec == null ? '' : (link ? '<a href="' + link + '">' + mmss(sec) + '</a> ' : mmss(sec) + ' ');
      out.push('• ' + stamp + esc(p.point));
    }
  }
  if (item.transcript_source) out.push('', '<i>from ' + esc(SOURCE_LABEL[item.transcript_source] || item.transcript_source) + '</i>');
  return out.join('\n').slice(0, 4000);   // Telegram's limit is 4096
}

module.exports = { isMediaUrl, mmss, parseTs, mediaMarkdown, MEDIA_SKILL_PROMPT, MEDIA_SKILL_SCHEMA, timeLink, mediaMessage, snapKeyPoints };
