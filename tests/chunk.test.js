const test = require('node:test');
const assert = require('node:assert');
const { classifyLines, cleanMarkdown, chunkText, chunkTranscript, chunkDoc, MIN_DOC_CHARS } = require('../shared/chunk.js');

const PROSE = 'Moonshot AI released a new version of its Kimi model this week, leading to a wave of discourse about Chinese open models.';
const reasons = (md) => classifyLines(md).filter((l) => !l.keep).map((l) => l.reason);

test('menus, images, share buttons and cookie banners are dropped', () => {
  const md = ['[ Skip to content ](https://x.com/#main)', '![](https://x.com/logo.png)',
    '[Share on Facebook](https://facebook.com/sharer?u=x)', '[Home](/) [News](/news) [About](/about)',
    'Accept all cookies Reject optional cookies', 'Read more', PROSE].join('\n');
  assert.strictEqual(cleanMarkdown(md), PROSE);
});

test('prose with inline links is kept and de-linked', () => {
  const md = '[Moonshot said](https://kimi.com/blog) that although Kimi K3 still trails the most powerful proprietary models, it closes much of the gap on agentic coding tasks.';
  assert.strictEqual(cleanMarkdown(md), 'Moonshot said that although Kimi K3 still trails the most powerful proprietary models, it closes much of the gap on agentic coding tasks.');
});

test('headings, tables and numeric list items survive', () => {
  const md = ['# Kimi: Threat or menace?', PROSE, '| Model | Input |', '| --- | --- |', '| o3 | $2.00 |',
    '* Mar 9: OpenAI acquires Promptfoo (350K+ devs)'].join('\n');
  assert.deepStrictEqual(reasons(md), []);
});

test('repeated lines and teasers are dropped', () => {
  const md = [PROSE, 'No Result', 'No Result', 'Informal workers in agriculture and construction face rising heat-related...', PROSE].join('\n');
  assert.deepStrictEqual(reasons(md), ['site chrome', 'site chrome', 'teaser', 'repeat']);
});

test('a related-articles heading late in the page cuts the footer', () => {
  const body = Array(6).fill(PROSE).map((p, i) => p + ' ' + i).join('\n');
  const md = body + '\n## Related Articles\nSome other story about something else entirely, with a full sentence.';
  const out = cleanMarkdown(md);
  assert.ok(!/Related|other story/.test(out));
  // ...but not near the top, where it is more likely a sidebar label
  assert.ok(/Related|other story/.test(cleanMarkdown('## Related Articles\nSome other story about something else entirely, with a full sentence.\n' + body)) ||
    reasons('## Related Articles\n' + body).every((r) => r !== 'footer'));
});

test('empty menu headings go, a heading over a sub-heading stays', () => {
  const answer = 'It is a pipeline that reads, scores and stores what it finds.';
  const md = ['### Finance', '### Politics', '# Real title', PROSE, '## FAQ', '### What is it?', answer].join('\n');
  const kept = classifyLines(md).filter((l) => l.keep && l.line).map((l) => l.line);
  assert.deepStrictEqual(kept, ['# Real title', PROSE, '## FAQ', '### What is it?', answer]);
});

test('chunkText packs lines up to the size and respects max', () => {
  const text = Array(20).fill(PROSE).join('\n');
  const chunks = chunkText(text, { size: 300 });
  assert.ok(chunks.every((c) => c.text.length <= 300));
  assert.deepStrictEqual(chunks.map((c) => c.n), chunks.map((_, i) => i + 1));
  assert.strictEqual(chunkText(text, { size: 300, max: 3 }).length, 3);
});

test('a paragraph longer than the size is split at a sentence end', () => {
  const para = 'First sentence is here. ' + 'Second sentence runs a while longer than the first. '.repeat(3) + 'Last one.';
  const chunks = chunkText(para, { size: 80 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.text.length <= 80));
  assert.ok(chunks[0].text.endsWith('.'));
});

test('a heading starts a new passage once the current one is half full', () => {
  const chunks = chunkText([PROSE, PROSE, '## Next section', PROSE].join('\n'), { size: 400 });
  assert.ok(chunks[1].text.startsWith('## Next section'));
});

test('transcript passages carry the start time of their first line', () => {
  const md = '# A video\nChannel: X | Length: 3:39\nScreen: screen not read: music video\n\n## Transcript\n' +
    '[0:04] first line of speech here\n[0:48] second line\n[1:02:03] much later line';
  const chunks = chunkTranscript(md, { size: 20 });
  assert.deepStrictEqual(chunks.map((c) => c.start_s), [4, 48, 3723]);
  assert.ok(!chunks.some((c) => /Channel|Screen/.test(c.text)));
});

test('chunkDoc: media goes through the transcript path, junk pages give no passages', () => {
  const media = chunkDoc({ scraper: 'media:captions-auto', markdown: '## Transcript\n[0:10] hello there' });
  assert.strictEqual(media.chunks[0].start_s, 10);
  const challenge = chunkDoc({ scraper: 'firecrawl', markdown: 'Checking your Browser…\nVerifying...\n[Troubleshoot](https://challenges.cloudflare.com/x)' });
  assert.deepStrictEqual(challenge.chunks, []);
  assert.deepStrictEqual(chunkDoc({ scraper: 'crawl4ai', markdown: PROSE }).chunks, []); // under MIN_DOC_CHARS
  assert.ok(PROSE.length < MIN_DOC_CHARS);
  assert.deepStrictEqual(chunkDoc({ scraper: 'crawl4ai', markdown: null }).chunks, []);
});
