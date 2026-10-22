// Builds workflows/wf45-synth-answer.json. Run: node scripts/build-wf45.js
//
// #13 (2026-10-12): one cited answer across several feed items. WF-31 finds the
// top 8 items for the question (with their passages, and records them as this
// chat's numbered list, so "#2" works afterwards) -> the 9B writes 3-6 sentences
// citing [n] -> shared/synth.js checks every number and every figure against
// the items cited -> one rewrite with the problems listed -> salvage (drop
// uncited sentences) -> else the plain numbered list. Called by WF-00
// ("Synth answer"), never by the model. mode = fast (thinking off) | think.
const fs = require('fs');
const path = require('path');

const I = require('./ids.js').PLACEHOLDERS;
const CRED_LM = I.credentials.lmstudio;
const WF31 = I.workflows['wf31-query-feed'];
const MODEL = 'qwen/qwen3.5-9b';
const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8').replace(/module\.exports[\s\S]*$/, '');
const LIBS = inline('answer-check.js') + inline('synth.js');

const PREP = LIBS + `
const j = $('WF Input').first().json;
const question = String(j.question || '').trim();
const mode = j.mode === 'think' ? 'think' : 'fast';
return [{ json: { question, mode, verify: String(j.verify) === 'true', chat_id: String(j.chat_id || ''), tag: synthTopic(question) || question, t0: Date.now() } }];
`.trim();

// WF-31's items, the first request body, or (no items) the final reply straight away
const ASK1 = LIBS + `
const p = $('Prep').first().json;
const items = (($input.first().json || {}).items || []).slice(0, SYNTH_MAX_ITEMS);
if (!items.length) return [{ json: { ask: 'false', output: formatFallback([]), items: [], status: 'no items' } }];
return [{ json: { ask: 'true', items, llm_body: JSON.stringify(synthBody(${JSON.stringify(MODEL)}, p.question, items, p.mode)) } }];
`.trim();

const CHECK1 = LIBS + `
const p = $('Prep').first().json;
const a = $('Ask?').first().json;
let answer = '';
try { answer = String($input.first().json.choices[0].message.content || '').trim(); } catch (e) {}
const c = checkSynth(answer, a.items, p.question);
if (c.ok) { const f = finalReply(answer, a.items); return [{ json: { retry: 'false', output: f.output, items: f.items, status: c.nothing ? 'nothing' : 'ok first try', cited: c.cited,
  answer, go_verify: String(p.verify && f.items.length > 0 && claimSentences(answer, f.items).length > 0) } }]; }
return [{ json: { retry: 'true', items: a.items, first: answer, problems: c.problems,
  llm_body: JSON.stringify(synthBody(${JSON.stringify(MODEL)}, p.question, a.items, p.mode, { previous: answer || '(empty)', problems: c.problems })) } }];
`.trim();

const CHECK2 = LIBS + `
const p = $('Prep').first().json;
const r = $('Retry?').first().json;
let answer = '';
try { answer = String($input.first().json.choices[0].message.content || '').trim(); } catch (e) {}
const c = checkSynth(answer, r.items, p.question);
const canVerify = (a, items) => String(p.verify && items.length > 0 && claimSentences(a, items).length > 0);
if (c.ok) { const f = finalReply(answer, r.items); return [{ json: { output: f.output, items: f.items, status: c.nothing ? 'nothing' : 'ok after rewrite', first_problems: r.problems, cited: c.cited,
  answer, go_verify: canVerify(answer, f.items) } }]; }
const kept = salvage(answer, c);
if (kept) { const f = finalReply(kept, r.items); return [{ json: { output: f.output, items: f.items, status: 'salvaged', first_problems: r.problems, problems: c.problems,
  answer: kept, go_verify: canVerify(kept, f.items) } }]; }
return [{ json: { output: formatFallback(r.items), items: r.items, status: 'fallback list', first_problems: r.problems, problems: c.problems, go_verify: 'false' } }];
`.trim();

// ---- the second reading (switch fix_verify): one check per cited sentence,
// then fix -> re-check -> quote -> drop for each flagged one (shared/synth.js).
// Every HTTP node gets one item per sentence and returns them in order, so the
// Code nodes pair requests and replies by index.
const SPLIT = LIBS + `
const d = $input.first().json;
return claimSentences(d.answer, d.items).map(c => ({ json: { s: c.s, llm_body: JSON.stringify(verifyBody(${JSON.stringify(MODEL)}, c.s, d.items)) } }));
`.trim();

const COLLECT = LIBS + `
const d = $('Verify?').first().json;
const jobs = $('Split claims').all().map(i => i.json);
const replies = $input.all().map(i => i.json);
const flagged = [];
jobs.forEach((job, k) => {
  let content = '';
  try { content = replies[k].choices[0].message.content; } catch (e) {}
  for (const u of parseVerify(content, job.s, d.items).unsupported) flagged.push({ s: job.s, why: u.why });
});
return [{ json: { ...d, any_flag: String(flagged.length > 0), flagged, checked: jobs.length } }];
`.trim();

const FIXPREP = LIBS + `
const d = $input.first().json;
return d.flagged.map(f => ({ json: { s: f.s, llm_body: JSON.stringify(fixBody(${JSON.stringify(MODEL)}, f.s, f.why, d.items)) } }));
`.trim();

// a DROP or unreadable fix still sends a (one-token) request, to keep the pairing
const RECHECKPREP = LIBS + `
const d = $('Any flagged?').first().json;
const jobs = $('Fix prep').all().map(i => i.json);
return $input.all().map((i, k) => {
  let content = '';
  try { content = i.json.choices[0].message.content; } catch (e) {}
  const fix = readFix(content, jobs[k].s);
  const body = fix ? verifyBody(${JSON.stringify(MODEL)}, fix, d.items)
    : { model: ${JSON.stringify(MODEL)}, max_tokens: 1, reasoning_effort: 'none', messages: [{ role: 'user', content: 'ok' }] };
  return { json: { s: jobs[k].s, fix, llm_body: JSON.stringify(body) } };
});
`.trim();

const APPLY = LIBS + `
const d = $('Any flagged?').first().json;
const jobs = $('Recheck prep').all().map(i => i.json);
const fixes = $input.all().map((i, k) => {
  const job = jobs[k];
  if (!job.fix) return { s: job.s, fix: '', fixOk: false };
  let content = '';
  try { content = i.json.choices[0].message.content; } catch (e) {}
  const v = parseVerify(content, job.fix, d.items);
  return { s: job.s, fix: job.fix, fixOk: v.parsed && v.unsupported.length === 0 };
});
const r = applyFixes(d.answer, fixes, d.items);
const f = finalReply(r.answer, d.items);
return [{ json: { ...d, output: f.output, items: f.items,
  verify: { checked: d.checked, flagged: d.flagged.length, fixed: r.fixed, quoted: r.quoted, dropped: r.dropped, why: d.flagged.map(x => x.why) } } }];
`.trim();

const DONE = `
const j = $input.first().json;
const p = $('Prep').first().json;
const verify = j.verify || (j.checked !== undefined ? { checked: j.checked, flagged: 0 } : null);
return [{ json: { output: j.output, items: j.items || [], status: j.status, mode: p.mode, seconds: Math.round((Date.now() - p.t0) / 100) / 10,
  first_problems: j.first_problems || [], problems: j.problems || [], verify } }];
`.trim();

const ifTrue = (id, name, field, pos) => ({ id, name, type: 'n8n-nodes-base.if', typeVersion: 2, position: pos,
  parameters: { options: {}, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, combinator: 'and',
    conditions: [{ id: id + '1', leftValue: '={{ $json.' + field + ' }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } }] } } });

const lm = (id, name, pos) => ({ id, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos,
  parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
    authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.llm_body }}', options: { timeout: 240000 } },
  credentials: { httpBearerAuth: CRED_LM }, retryOnFail: false, onError: 'continueRegularOutput' });

const code = (id, name, js, pos) => ({ id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: { mode: 'runOnceForAllItems', jsCode: js } });

const SEARCH_INPUTS = ['since', 'min_relevance', 'tag', 'limit', 'min_score', 'max_age_days', 'group_stories', 'item', 'chat_id', 'user_text'];

const wf = {
  name: 'WF-45 synth_answer',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: ['question', 'chat_id', 'mode', 'verify'].map((name) => ({ name, type: 'string' })) } } },
    code('prep', 'Prep', PREP, [200, 0]),
    { id: 'search', name: 'Feed search', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [400, 0],
      parameters: { workflowId: { __rl: true, value: WF31, mode: 'id' },
        workflowInputs: { mappingMode: 'defineBelow', value: {
          tag: '={{ $json.tag }}', user_text: '={{ $json.question }}', chat_id: '={{ $json.chat_id }}', limit: '8',
          since: '', min_relevance: '', min_score: '', max_age_days: '', group_stories: '', item: '' },
          matchingColumns: [], schema: SEARCH_INPUTS.map((id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' })) },
        options: { waitForSubWorkflow: true } },
      onError: 'continueRegularOutput', alwaysOutputData: true },
    code('ask1prep', 'Ask?', ASK1, [600, 0]),
    ifTrue('askif', 'Has items?', 'ask', [800, 0]),
    lm('ask1', 'Write answer', [1000, -80]),
    code('check1', 'Check answer', CHECK1, [1200, -80]),
    ifTrue('retryif', 'Retry?', 'retry', [1400, -80]),
    lm('ask2', 'Rewrite answer', [1600, -160]),
    code('check2', 'Check rewrite', CHECK2, [1800, -160]),
    ifTrue('verifyif', 'Verify?', 'go_verify', [2000, -80]),
    code('split', 'Split claims', SPLIT, [2200, -240]),
    lm('checksent', 'Check sentence', [2400, -240]),
    code('collect', 'Collect verdicts', COLLECT, [2600, -240]),
    ifTrue('flagif', 'Any flagged?', 'any_flag', [2800, -240]),
    code('fixprep', 'Fix prep', FIXPREP, [3000, -400]),
    lm('fixsent', 'Fix sentence', [3200, -400]),
    code('recheckprep', 'Recheck prep', RECHECKPREP, [3400, -400]),
    lm('recheck', 'Recheck fix', [3600, -400]),
    code('apply', 'Apply fixes', APPLY, [3800, -400]),
    // one exit, whichever way the run went (an IF with an empty branch is not a reliable last node)
    code('done', 'Done', DONE, [4000, 0]),
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Prep', type: 'main', index: 0 }]] },
    'Prep': { main: [[{ node: 'Feed search', type: 'main', index: 0 }]] },
    'Feed search': { main: [[{ node: 'Ask?', type: 'main', index: 0 }]] },
    'Ask?': { main: [[{ node: 'Has items?', type: 'main', index: 0 }]] },
    'Has items?': { main: [[{ node: 'Write answer', type: 'main', index: 0 }], [{ node: 'Done', type: 'main', index: 0 }]] },
    'Write answer': { main: [[{ node: 'Check answer', type: 'main', index: 0 }]] },
    'Check answer': { main: [[{ node: 'Retry?', type: 'main', index: 0 }]] },
    'Retry?': { main: [[{ node: 'Rewrite answer', type: 'main', index: 0 }], [{ node: 'Verify?', type: 'main', index: 0 }]] },
    'Rewrite answer': { main: [[{ node: 'Check rewrite', type: 'main', index: 0 }]] },
    'Check rewrite': { main: [[{ node: 'Verify?', type: 'main', index: 0 }]] },
    'Verify?': { main: [[{ node: 'Split claims', type: 'main', index: 0 }], [{ node: 'Done', type: 'main', index: 0 }]] },
    'Split claims': { main: [[{ node: 'Check sentence', type: 'main', index: 0 }]] },
    'Check sentence': { main: [[{ node: 'Collect verdicts', type: 'main', index: 0 }]] },
    'Collect verdicts': { main: [[{ node: 'Any flagged?', type: 'main', index: 0 }]] },
    'Any flagged?': { main: [[{ node: 'Fix prep', type: 'main', index: 0 }], [{ node: 'Done', type: 'main', index: 0 }]] },
    'Fix prep': { main: [[{ node: 'Fix sentence', type: 'main', index: 0 }]] },
    'Fix sentence': { main: [[{ node: 'Recheck prep', type: 'main', index: 0 }]] },
    'Recheck prep': { main: [[{ node: 'Recheck fix', type: 'main', index: 0 }]] },
    'Recheck fix': { main: [[{ node: 'Apply fixes', type: 'main', index: 0 }]] },
    'Apply fixes': { main: [[{ node: 'Done', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', errorWorkflow: I.workflows['wf99-error-workflow'] }
};

const out = path.join(__dirname, '..', 'workflows', 'wf45-synth-answer.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
console.log('wrote', out);
