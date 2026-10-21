const test = require('node:test');
const assert = require('node:assert');
const U = require('../shared/upload.js');
const { canon } = require('../shared/canonicalize.js');

const msg = (doc, caption) => ({ document: doc, caption });

test('a document in a message: pdf, other, none', () => {
  const p = U.uploadInfo(msg({ file_id: 'F1', file_unique_id: 'U1', file_name: 'BB AI Policy 2026.pdf', mime_type: 'application/pdf', file_size: 1234 }, 'for the piece'));
  assert.deepEqual(p, { kind: 'pdf', file_id: 'F1', unique_id: 'U1', name: 'BB AI Policy 2026.pdf', size: 1234, caption: 'for the piece' });
  assert.equal(U.uploadInfo(msg({ file_id: 'F2', file_name: 'x.docx', mime_type: 'application/vnd.openxmlformats' })).kind, 'other');
  assert.equal(U.uploadInfo({ text: 'hi' }), null);
  assert.equal(U.uploadText(p), '[file] BB AI Policy 2026.pdf — for the piece');
});

test('the gate refuses non-PDFs and files over 20 MB, before downloading', () => {
  assert.ok(U.uploadGate({ kind: 'other', name: 'x.docx', size: 1 }).reply.startsWith('I can only read PDFs'));
  assert.ok(U.uploadGate({ kind: 'pdf', name: 'big.pdf', size: 30 * 1048576 }).reply.includes('30 MB'));
  assert.equal(U.uploadGate({ kind: 'pdf', name: 'ok.pdf', size: 5 }).ok, true);
});

test('identity: stable, survives canonicalisation, carries no file id or token', () => {
  const c = U.uploadCanonical({ unique_id: 'AgADx-1_2', name: 'Bangladesh Bank — AI Guidelines (Final).PDF' });
  assert.equal(c, 'upload://telegram/AgADx-1_2/bangladesh-bank-ai-guidelines-final.pdf');
  assert.equal(canon(c), c);
});

test('PDF text is joined back into paragraphs', () => {
  assert.equal(U.cleanPdfText('The bank will intro-\nduce rules\nfor AI use.\n\n\n\nNext section'), 'The bank will introduce rules for AI use.\n\nNext section');
});

test('title: metadata when it looks like one, else the file name', () => {
  const info = { name: 'bb_ai_policy.pdf' };
  assert.equal(U.uploadTitle(info, { info: { Title: 'Guidelines on AI in Banking' } }), 'Guidelines on AI in Banking');
  assert.equal(U.uploadTitle(info, { info: { Title: 'Microsoft Word - draft3.docx' } }), 'bb ai policy');
  assert.equal(U.uploadTitle(info, {}), 'bb ai policy');
});

test('prep: a scan is refused; text becomes one pre-read WF-20 document', () => {
  const info = { unique_id: 'U1', name: 'scan.pdf', caption: '' };
  assert.ok(U.uploadPrep(info, { text: '  \n ', numpages: 4 }).reply.includes('looks like a scan'));
  const p = U.uploadPrep({ ...info, name: 'report.pdf', caption: 'read section 3' }, { text: 'Body text. '.repeat(60), numpages: 12, info: { Title: 'Annual AI Report' } });
  assert.equal(p.ok, true);
  assert.equal(p.urls[0].scraper, 'upload:pdf');
  assert.ok(p.urls[0].markdown.startsWith('# Annual AI Report\n\nSent with the note: read section 3\n\nBody text.'));
  assert.equal(p.reply, '\u{1F4C4} Reading "Annual AI Report" (12 pages). The summary arrives in about a minute.');
});

test('a thin file name takes the first title-like line, skipping licence lines', () => {
  const text = 'Provided proper attribution is provided, Google hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.\nAttention Is All You Need\nAshish Vaswani∗\nGoogle Brain\navaswani@google.com';
  assert.equal(U.uploadTitle({ name: 'attention.pdf' }, { text }), 'Attention Is All You Need');
  assert.equal(U.uploadTitle({ name: 'Bangladesh Bank AI guidelines 2026.pdf' }, { text }), 'Bangladesh Bank AI guidelines 2026');
  assert.equal(U.uploadTitle({ name: 'x.pdf' }, { text: 'lowercase only.\nmore text.' }), 'x');
});
