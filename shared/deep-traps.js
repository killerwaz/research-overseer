// Deploy gate for WF-46 deep research: known myths a reply must not repeat.
// A trap is {id, question, mustNot: [rule], must: [rule]}; a rule is {in, re, why}.
// `in` picks the part of the reply the regex runs on:
//   headline  - the first bold line
//   items     - the numbered findings (what the answer presents as true)
//   body      - everything before "Sources:" (the default)
// scripts/deep-gate.js runs each trap's question through the pipeline and calls checkTrap.

function replyParts(reply) {
  const text = String(reply || '');
  const body = text.split(/\n\s*Sources:\s*\n/)[0];
  const head = (body.match(/^\s*\*\*(.+?)\*\*/) || [])[1] || body.split('\n')[0];
  const items = body.split('\n').filter((l) => /^\s*\d+\.\s/.test(l)).join('\n');
  return { headline: head, items, body };
}

function checkTrap(reply, trap) {
  const parts = replyParts(reply);
  const fails = [];
  for (const r of trap.mustNot || []) {
    const m = (parts[r.in || 'body'] || '').match(new RegExp(r.re, 'im'));
    if (m) fails.push(`repeats myth (${r.in || 'body'}: "${m[0]}"): ${r.why}`);
  }
  for (const r of trap.must || []) {
    if (!new RegExp(r.re, 'im').test(parts[r.in || 'body'] || '')) fails.push(`missing (${r.in || 'body'}): ${r.why}`);
  }
  return fails;
}

module.exports = { replyParts, checkTrap };
