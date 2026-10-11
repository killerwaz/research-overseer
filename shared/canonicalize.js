// Canonical URL form used for dedupe (spec §5.2).
//
// This file is the single source of truth: scripts/build-wf20.js inlines the
// function body into WF-20's Canonicalize node, so the tests in
// tests/canonicalize.test.js exercise exactly what runs in production.
//
// No URL/URLSearchParams — the n8n task-runner sandbox has neither.

// `src` joins the list for the same reason as `source`: it is overwhelmingly a
// referrer tag (?src=twitter), and leaving it in split one page into two feed
// items during testing.
const STRIP = /^(utm_.*|fbclid|gclid|ref|source|src|mc_cid|mc_eid|igshid)$/i;

// Every YouTube URL shape for one video (watch?v=, youtu.be/, shorts/, embed/,
// live/, m. and music. hosts) collapses to one key, with pp/si/t/list dropped:
// otherwise the same video pasted twice became two feed items.
const YT_ID = /^(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i;
function youtubeId(rawUrl) {
  const m = String(rawUrl || '').trim().match(YT_ID);
  return m ? m[1] : null;
}

function canon(rawUrl) {
  try {
    const yt = youtubeId(rawUrl);
    if (yt) return 'https://www.youtube.com/watch?v=' + yt;
    const s = String(rawUrl).trim();
    const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    let hostport = m[2];
    let path = m[3] || '/';
    const query = m[4] ? m[4].slice(1) : '';
    let userinfo = '';
    const at = hostport.lastIndexOf('@');
    if (at !== -1) { userinfo = hostport.slice(0, at + 1); hostport = hostport.slice(at + 1); }
    let host = hostport;
    let port = '';
    const ci = hostport.lastIndexOf(':');
    if (ci !== -1 && /^\d+$/.test(hostport.slice(ci + 1))) { host = hostport.slice(0, ci); port = hostport.slice(ci); }
    host = host.toLowerCase();
    if (host.startsWith('amp.')) host = host.slice(4);
    if ((scheme === 'http' && port === ':80') || (scheme === 'https' && port === ':443')) port = '';
    path = path.replace(/\/amp(\/|$)/, '$1');
    path = path.replace(/\/{2,}/g, '/');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (!path) path = '/';
    const params = query ? query.split('&').filter(p => p !== '' && !STRIP.test(p.split('=')[0])) : [];
    const qs = params.length ? '?' + params.join('&') : '';
    return scheme + '://' + userinfo + host + port + path + qs;
  } catch (e) { return null; }
}

module.exports = { canon, STRIP, youtubeId };
