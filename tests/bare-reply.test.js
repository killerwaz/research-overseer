const test = require('node:test');
const assert = require('node:assert');
const { bareReply, bareReplyText } = require('../shared/bare-reply.js');

test('bare short replies are recognised', () => {
  for (const t of ['yes', 'Yes!', ' ok ', 'okay.', 'no', 'Nope', 'sure', 'thanks 👍', 'go ahead']) assert.ok(bareReply(t), t);
});

test('anything with a topic is not bare', () => {
  for (const t of ['yes, MCP funding', 'ok what about anthropic', 'no I meant openai', 'mcp', '#3', '', 'yes please search the web for weather in dhaka'])
    assert.ok(!bareReply(t), t);
});

test('the reply asks what it refers to, and never lists feed items', () => {
  assert.match(bareReplyText('yes'), /^Yes to what\?/);
  assert.match(bareReplyText('no'), /^OK\./);
  assert.strictEqual(bareReplyText('thanks'), 'Anytime.');
});
