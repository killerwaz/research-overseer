const test = require('node:test');
const assert = require('node:assert');
const { escapeHtml, stripMarkdown, forTelegram } = require('../shared/telegram-format.js');

// Regression: the model kept emitting **bold** despite instructions, and under
// parse_mode HTML it rendered as literal asterisks on the phone.
test('strips bold, italics and headings', () => {
  assert.equal(stripMarkdown('**Bangladesh Bank** — green finance'), 'Bangladesh Bank — green finance');
  assert.equal(stripMarkdown('a *strong* point'), 'a strong point');
  assert.equal(stripMarkdown('use _this_ now'), 'use this now');
  assert.equal(stripMarkdown('## Heading'), 'Heading');
});

test('leaves arithmetic and snake_case alone', () => {
  assert.equal(stripMarkdown('5 * 3 = 15'), '5 * 3 = 15');
  assert.equal(stripMarkdown('file_name_here stays'), 'file_name_here stays');
});

test('escapes HTML so a stray angle bracket cannot break the send', () => {
  assert.equal(escapeHtml('<b>x</b> & y'), '&lt;b&gt;x&lt;/b&gt; &amp; y');
});

// Regression: run summaries carried scraped page titles, and a title
// containing < or & made the Telegram API reject the whole message.
test('titles with markup survive as text', () => {
  assert.equal(forTelegram('Claude 3.7 <Sonnet> & Code'), 'Claude 3.7 &lt;Sonnet&gt; &amp; Code');
});

test('truncates to the length limit', () => {
  assert.equal(forTelegram('x'.repeat(5000)).length, 4000);
});

test('null and undefined do not throw', () => {
  assert.equal(forTelegram(null), '');
  assert.equal(forTelegram(undefined), '');
});
