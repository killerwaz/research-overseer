// A bare short reply ("yes", "ok", "no") is never redone by the answer guard
// (2026-10-17). The redo's Prefetch searched the feed for "yes", got 10
// unrelated items, and the 9B presented them as an answer. A bare reply has no
// topic to look up, so when the guard would redo it the bot asks instead.
// (A "yes" to the sweep question never gets here: shared/sweep-confirm.js.)

const BARE = /^(yes|y|yeah|yep|yup|yea|sure|ok|okay|k|no|n|nope|nah|maybe|go ahead|do it|please|thanks|thank you|thx|cool|great|nice|right|fine|alright|got it)$/i;

function bareReply(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[\s!.?,👍🙏]+$/u, '').replace(/^[\s!.?,]+/, '');
  return t.length <= 20 && BARE.test(t);
}

function bareReplyText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(no|n|nope|nah)\b/.test(t)) return 'OK. What would you like instead? Tell me a topic, a link or a question.';
  if (/^(thanks|thank you|thx|cool|great|nice|got it)\b/.test(t)) return 'Anytime.';
  return 'Yes to what? I have nothing pending for you. Tell me a topic, a link or a question.';
}

module.exports = { bareReply, bareReplyText };
