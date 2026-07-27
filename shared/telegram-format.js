// Telegram message preparation. Inlined into WF-00's Prep reply node by
// scripts/build-wf00.js, so tests/telegram-format.test.js covers what ships.
//
// Messages are sent with parse_mode HTML because the node's legacy Markdown
// default breaks on a single stray asterisk. That means two obligations:
// escape HTML-significant characters, and strip the markdown the model emits
// anyway despite being told not to (it would otherwise show as literal * and _).

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripMarkdown(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(?!\s)(.+?)(?<!\s)\*(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)_(?!\s)(.+?)(?<!\s)_(?=\s|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '');
}

// What actually goes on the wire.
function forTelegram(s, maxLen = 4000) {
  return escapeHtml(stripMarkdown(String(s == null ? '' : s).slice(0, maxLen)));
}

module.exports = { escapeHtml, stripMarkdown, forTelegram };
