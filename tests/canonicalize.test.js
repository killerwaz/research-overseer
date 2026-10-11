const test = require('node:test');
const assert = require('node:assert');
const { canon } = require('../shared/canonicalize.js');

test('strips tracking params and trailing slash', () => {
  assert.equal(
    canon('https://www.anthropic.com/news/claude-fable-5-mythos-5/?utm_source=x'),
    'https://www.anthropic.com/news/claude-fable-5-mythos-5');
});

test('lowercases scheme and host, collapses duplicate slashes, keeps real params', () => {
  assert.equal(canon('HTTPS://Example.COM//a//b/?fbclid=1&keep=2'),
    'https://example.com/a/b?keep=2');
});

test('rewrites amp subdomain and amp path segment', () => {
  assert.equal(canon('https://amp.theverge.com/article/'), 'https://theverge.com/article');
  assert.equal(canon('https://site.com/story/amp/'), 'https://site.com/story');
});

test('drops default ports but keeps non-default ones', () => {
  assert.equal(canon('https://host.com:443/x/'), 'https://host.com/x');
  assert.equal(canon('http://host.com:80/x'), 'http://host.com/x');
  assert.equal(canon('https://host.com:8443/x'), 'https://host.com:8443/x');
});

test('root path is preserved', () => {
  assert.equal(canon('https://host.com/'), 'https://host.com/');
});

test('strips every known tracker but nothing else', () => {
  assert.equal(canon('https://h.com/a?utm_source=1&utm_medium=2&gclid=3'), 'https://h.com/a');
  assert.equal(canon('https://h.com/a?id=7&page=2'), 'https://h.com/a?id=7&page=2');
});

test('referrer tags do not split one page into two items', () => {
  // ?src=twitter vs ?src=rss is the same article
  assert.equal(canon('https://h.com/a?src=twitter'), canon('https://h.com/a?src=rss'));
  assert.equal(canon('https://h.com/a?src=x'), 'https://h.com/a');
});

test('unparseable input returns null rather than throwing', () => {
  for (const bad of ['notaurl', '', null, undefined, 'javascript:alert(1)']) {
    assert.equal(canon(bad), null, JSON.stringify(bad));
  }
});

test('two spellings of the same page collapse to one key', () => {
  // the dedupe guarantee the whole pipeline rests on
  assert.equal(
    canon('https://Example.com/post/?utm_campaign=news'),
    canon('https://example.com/post'));
});

test('every YouTube URL shape for one video collapses to one key', () => {
  const want = 'https://www.youtube.com/watch?v=wIe3eDfGKUo';
  for (const u of ['https://www.youtube.com/watch?v=wIe3eDfGKUo&pp=0gcJCTcMAYcqIYzv', 'https://youtu.be/wIe3eDfGKUo?si=abc',
    'https://m.youtube.com/watch?v=wIe3eDfGKUo&t=30s', 'https://www.youtube.com/watch?feature=share&v=wIe3eDfGKUo',
    'https://www.youtube.com/shorts/wIe3eDfGKUo', 'https://www.youtube.com/embed/wIe3eDfGKUo', 'youtube.com/live/wIe3eDfGKUo?x=1']) {
    assert.strictEqual(canon(u), want, u);
  }
});

test('non-video YouTube pages keep the normal rules', () => {
  assert.strictEqual(canon('https://www.youtube.com/@IBMTechnology/videos'), 'https://www.youtube.com/@IBMTechnology/videos');
  assert.strictEqual(canon('https://www.youtube.com/watch?v=short'), 'https://www.youtube.com/watch?v=short');
});
