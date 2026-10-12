// Shared by the workbench pages: fetch a data file only when it changed.
// Polls the server's tiny /stamp (file mtime) instead of the file itself, and
// does nothing while the tab is hidden. Returns the Response, or null when
// there is nothing new.
const _stamps = {};
async function fetchIfChanged(name) {
  if (document.hidden && _stamps[name]) return null;   // always load once, then pause while hidden
  const s = await fetch('stamp?f=' + encodeURIComponent(name), { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!s || !s.m || _stamps[name] === s.m) return null;
  const r = await fetch('data/' + name + '?m=' + s.m, { cache: 'no-store' });
  if (r.ok) _stamps[name] = s.m;
  return r;
}
