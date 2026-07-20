// Minimal 5-field cron matcher for the WF-30 poller Code node.
// No external deps (n8n task-runner sandbox has no require).
// Timezone: Asia/Dhaka = fixed UTC+6, no DST — epoch shift, then UTC getters.

function parseField(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step < 1) return null;
    let lo = min, hi = max;
    if (m[1] !== '*') {
      const r = m[1].split('-');
      lo = parseInt(r[0], 10);
      hi = r.length > 1 ? parseInt(r[1], 10) : (m[2] ? max : lo);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function compileCron(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const mon = parseField(f[3], 1, 12);
  const dowRaw = parseField(f[4], 0, 7);
  if (!minute || !hour || !dom || !mon || !dowRaw) return null;
  const dow = new Set([...dowRaw].map(v => v === 7 ? 0 : v));
  return { minute, hour, dom, mon, dow,
    domStar: f[2] === '*', dowStar: f[4] === '*' };
}

// epochSec: UTC epoch seconds. Returns true if cron matches that minute in Dhaka.
function cronMatchesAt(c, epochSec) {
  const d = new Date((epochSec + 6 * 3600) * 1000);
  if (!c.minute.has(d.getUTCMinutes())) return false;
  if (!c.hour.has(d.getUTCHours())) return false;
  if (!c.mon.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // standard cron: if both dom and dow are restricted, either may match
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

// Did expr have a fire tick in (fromEpoch, toEpoch]? Lookback capped by caller.
function cronFiredInWindow(expr, fromEpoch, toEpoch) {
  const c = compileCron(expr);
  if (!c) return false;
  let t = Math.floor(fromEpoch / 60) * 60 + 60; // first whole minute AFTER fromEpoch
  for (; t <= toEpoch; t += 60) {
    if (cronMatchesAt(c, t)) return true;
  }
  return false;
}

if (typeof module !== 'undefined') module.exports = { compileCron, cronMatchesAt, cronFiredInWindow };
