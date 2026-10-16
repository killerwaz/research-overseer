// A "yes" / "no" to the bot's full-sweep question is handled in code, not by
// the 9B (2026-10-16). Given "yes", the 9B called no tool and said "the full
// sweep returned 10 items"; the guard's redo then searched the feed for "yes"
// and the 9B presented those 10 unrelated items as sweep results. Nothing ran.
// Given "no", the reply fell through to a web search he had just declined.

// WF-40's own wording ("Needs confirmation"), echoed by the agent
const OFFER = /Run a full sweep on (.+?)\? It hits exa/i;
// same list as WF-40's Gate input, so the gate agrees with this routing
const YES = /^(yes|y|yeah|yep|yup|sure|ok|okay|go ahead|go for it|do it|run it|confirm(ed)?|please( do)?)\b/i;
const NO = /^(no|n|nope|nah|don'?t|do not|cancel|skip( it)?|not now|never ?mind|stop)\b/i;

// the query the bot's last message offered to sweep, '' for the default beat,
// null when the last message was not a sweep offer
function sweepOffer(lastBot) {
  const m = OFFER.exec(String(lastBot || ''));
  if (!m) return null;
  const q = m[1].trim();
  return /^the default beat$/i.test(q) ? '' : q;
}

// 'go' | 'no' | '' for this message, given the bot's previous one
function sweepDecision(text, lastBot) {
  const offered = sweepOffer(lastBot);
  if (offered === null) return { sweep: '', sweep_query: '' };
  const msg = String(text || '').trim();
  if (msg.length < 60 && YES.test(msg)) return { sweep: 'go', sweep_query: offered };
  if (msg.length < 40 && NO.test(msg)) return { sweep: 'no', sweep_query: offered };
  return { sweep: '', sweep_query: '' };
}

const SOURCE_NAMES = { 'Run Exa': 'exa', 'Run Tavily': 'tavily', 'Run Brave': 'brave', 'Run RSS': 'rss' };

// The reply, from what WF-40 actually returned. Never claims items it did not get.
function sweepReply(decision, result) {
  const topic = decision.sweep_query ? ' on ' + decision.sweep_query : '';
  if (decision.sweep === 'no') return 'OK, no sweep' + topic + '. Nothing was run.';
  const r = result || {};
  if (r.status === 'not_run') return "The sweep didn't run: it was not confirmed. Ask for it again and reply yes.";
  const parts = Array.isArray(r.sweep) ? r.sweep : [];
  if (!parts.length) return "The sweep" + topic + " failed before any source ran. Nothing was added.";
  let total = 0;
  const per = [], failed = [];
  for (const p of parts) {
    const name = SOURCE_NAMES[p.source] || p.source;
    if (p.error || p.status === 'failed') { failed.push(name); continue; }
    const n = Number(p.items_created) || 0;
    total += n;
    per.push(name + ' ' + n);
  }
  const lines = ['Full sweep' + topic + ' finished: ' + (total ? total + ' new item' + (total === 1 ? '' : 's') : 'nothing new') + ' added' + (per.length ? ' (' + per.join(', ') + ')' : '') + '.'];
  if (failed.length) lines.push(failed.join(', ') + ' failed.');
  if (total) lines.push('Ask "anything on ' + (decision.sweep_query || 'today') + '" to see them.');
  return lines.join('\n');
}

module.exports = { sweepOffer, sweepDecision, sweepReply };
