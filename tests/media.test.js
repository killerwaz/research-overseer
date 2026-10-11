const test = require('node:test');
const assert = require('node:assert');
const { isMediaUrl, BARE_MEDIA_REPLY, mmss, parseTs, mediaMarkdown, timeLink, mediaMessage } = require('../shared/media.js');

test('isMediaUrl: videos, podcasts and audio files yes; pages and channels no', () => {
  for (const u of ['https://www.youtube.com/watch?v=sjzHT_QUATM', 'https://youtu.be/sjzHT_QUATM', 'https://vimeo.com/123',
    'https://podcasts.apple.com/us/podcast/x/id1?i=2', 'https://cdn.example.com/ep12.mp3', 'https://x.com/a.m4a?token=1'])
    assert.strictEqual(isMediaUrl(u), true, u);
  for (const u of ['https://www.youtube.com/@IBMTechnology', 'https://www.youtube.com/playlist?list=PL1', 'https://example.com/article',
    'https://notyoutube.com/watch?v=1', 'ftp://youtube.com/x', ''])
    assert.strictEqual(isMediaUrl(u), false, u);
});

test('mmss and parseTs round-trip', () => {
  assert.strictEqual(mmss(65), '1:05');
  assert.strictEqual(mmss(3725), '1:02:05');
  assert.strictEqual(parseTs('1:05'), 65);
  assert.strictEqual(parseTs('[12:30]'), 750);
  assert.strictEqual(parseTs('1:02:05'), 3725);
  assert.strictEqual(parseTs('45'), 45);
  assert.strictEqual(parseTs('soon'), null);
});

test('mediaMarkdown has header, chapters and timestamped transcript', () => {
  const md = mediaMarkdown({ title: 'T', channel: 'C', duration: 125, published_at: '2026-10-10', source: 'parakeet',
    chapters: [{ start: 0, title: 'Intro' }], paragraphs: [{ start: 0, text: 'hello' }, { start: 61.5, text: 'world' }] });
  assert.match(md, /^# T\nChannel: C \| Length: 2:05 \| Published: 2026-10-10 \| Transcript: speech-to-text/);
  assert.match(md, /## Chapters\n\[0:00\] Intro/);
  assert.match(md, /\[1:01\] world$/);
});

test('timeLink only for YouTube', () => {
  assert.strictEqual(timeLink('https://www.youtube.com/watch?v=sjzHT_QUATM', 75.9), 'https://youtu.be/sjzHT_QUATM?t=75');
  assert.strictEqual(timeLink('https://vimeo.com/1', 10), null);
});

test('the screen verdict rides in the markdown and ends the message', () => {
  assert.match(mediaMarkdown({ title: 'T', source: 'captions-auto', screen_note: 'screen read: software tutorial', paragraphs: [] }),
    /\nScreen: screen read: software tutorial\n/);
  assert.doesNotMatch(mediaMarkdown({ title: 'T', source: 'captions-auto', paragraphs: [] }), /Screen:/);
  const m = mediaMessage({ title: 'T', canonical_url: 'https://youtu.be/x', transcript_source: 'captions-auto', screen: 'screen not read: interview' });
  assert.match(m, /<i>from YouTube auto-captions · screen not read: interview<\/i>$/);
});

test('mediaMessage escapes HTML and links timestamps', () => {
  const m = mediaMessage({ title: 'A <b> & C', score: 8, summary: 's', canonical_url: 'https://www.youtube.com/watch?v=sjzHT_QUATM',
    key_points: [{ t: '1:05', point: 'x < y' }, { t: '??', point: 'no time' }], transcript_source: 'captions-auto' });
  assert.match(m, /A &lt;b&gt; &amp; C<\/b>  \(score 8\/10\)/);
  assert.match(m, /<a href="https:\/\/youtu.be\/sjzHT_QUATM\?t=65">1:05<\/a> x &lt; y/);
  assert.match(m, /• no time/);
  assert.match(m, /from YouTube auto-captions/);
});

const { snapKeyPoints } = require('../shared/media.js');
const MD = '# T\n\n## Transcript\n[0:00] trillion parameter models need two terabytes of memory\n' +
  '[1:18] serving in production means three constraints memory footprint kv cache throughput\n' +
  '[7:11] standard tcp over ethernet is usually not fast enough\n[8:25] production deployments layer techniques with an orchestration layer';

test('snapKeyPoints keeps a right timestamp right', () => {
  const out = snapKeyPoints([{ t: '[0:00]', point: 'Trillion parameter models need about two terabytes of memory' }], MD);
  assert.strictEqual(out[0].t, '0:00');
});

test('snapKeyPoints moves invented timestamps to the matching line', () => {
  const out = snapKeyPoints([
    { t: '1:58', point: 'Serving in production means solving three constraints: memory footprint, KV cache, throughput.' },
    { t: '7:49', point: 'Standard TCP over Ethernet is usually not fast enough.' }], MD);
  assert.deepStrictEqual(out.map((p) => p.t), ['1:18', '7:11']);
});

test('snapKeyPoints leaves points alone when nothing matches', () => {
  const out = snapKeyPoints([{ t: '[3:00]', point: 'Completely unrelated sentence about gardening' }], MD);
  assert.strictEqual(out[0].t, '3:00');
  assert.deepStrictEqual(snapKeyPoints([{ t: '1:00', point: 'x' }], 'no transcript'), [{ t: '1:00', point: 'x' }]);
});

const { parseMediaRequest } = require('../shared/media.js');

test('parseMediaRequest: every link, in order, deduped, punctuation trimmed', () => {
  const r = parseMediaRequest('check https://youtu.be/aaaaaaaaaaa, and https://www.youtube.com/watch?v=bbbbbbbbbbb\nhttps://youtu.be/aaaaaaaaaaa');
  assert.deepStrictEqual(r.urls, ['https://youtu.be/aaaaaaaaaaa', 'https://www.youtube.com/watch?v=bbbbbbbbbbb']);
  assert.strictEqual(r.slides, false);
  assert.strictEqual(r.transcribe, false);
});

test('parseMediaRequest: watch inside a URL is not a trigger, the word is', () => {
  assert.strictEqual(parseMediaRequest('https://www.youtube.com/watch?v=bbbbbbbbbbb').slides, false);
  for (const t of ['slides', 'the deck please', 'presentation', 'watch it', 'look at the screen'])
    assert.strictEqual(parseMediaRequest(t + ' https://youtu.be/aaaaaaaaaaa').slides, true, t);
  for (const t of ['transcribe', 'listen to it', 'can you hear this'])
    assert.strictEqual(parseMediaRequest(t + ' https://youtu.be/aaaaaaaaaaa').transcribe, true, t);
});

test('parseMediaRequest: the tool url is merged in, text without links is fine', () => {
  assert.deepStrictEqual(parseMediaRequest('transcribe', 'https://youtu.be/aaaaaaaaaaa').urls, ['https://youtu.be/aaaaaaaaaaa']);
  assert.deepStrictEqual(parseMediaRequest('transcribe').urls, []);
});

test('BARE_MEDIA_REPLY: a short "transcribe" reply yes; questions and chat no', () => {
  for (const t of ['transcribe', 'Transcribe', ' transcribe. ', 'yes transcribe', 'Yes, transcribe it', 'ok transcribe it please',
    'please transcribe', 'listen', 'listen to it', 'hear it', 'go ahead and transcribe', 'transcription', 'transcribe slides', 'slides and transcribe', 'yes transcribe the slides', 'transcribe it with slides', 'Transcribe + deck'])
    assert.strictEqual(BARE_MEDIA_REPLY.test(t), true, t);
  for (const t of ['do you transcribe podcasts?', 'can you transcribe what the CEO said?', 'I listen to podcasts', 'listen, what is new in fintech',
    'transcribe https://youtu.be/x', 'what did you hear about Bkash', 'hearing aids startups', 'slides', 'transcribe slides https://youtu.be/x', 'transcribe the slides from the fintech deck', ''])
    assert.strictEqual(BARE_MEDIA_REPLY.test(t), false, t);
});
