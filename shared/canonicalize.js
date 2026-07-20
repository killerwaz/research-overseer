// Canonicalize URLs (spec §5.2) — body of the Code node in WF-20.
// Input items: [{ url, title?, source?, published_at? }]
// Output items: same + { canonical_url }

const STRIP_PARAMS = /^(utm_.*|fbclid|gclid|ref|source|mc_cid|mc_eid|igshid)$/i;

function canonicalize(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch (e) {
    return null; // caller drops unparseable URLs and logs them
  }

  // lowercase scheme + host; keep host otherwise as-is (no www-stripping)
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  // AMP rewrites, best-effort
  if (u.hostname.startsWith('amp.')) {
    u.hostname = u.hostname.slice(4);
  }
  u.pathname = u.pathname.replace(/\/amp(\/|$)/, '$1');

  // remove fragment
  u.hash = '';

  // remove tracking params
  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!STRIP_PARAMS.test(k)) keep.push([k, v]);
  }
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);

  // collapse duplicate slashes in path
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');

  // strip single trailing slash on non-root paths
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

const out = [];
for (const item of $input.all()) {
  const url = item.json.url;
  const canonical_url = url ? canonicalize(url) : null;
  if (!canonical_url) continue; // unparseable — skip, counted upstream via urls_found vs urls_new
  out.push({ json: { ...item.json, canonical_url } });
}
return out;
