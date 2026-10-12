// Builds workflows/wf44-web-answer.json. Run: node scripts/build-wf44.js
//
// Fix 2 (2026-10-12): answers a question from the web when the feed has none.
// One Tavily basic search (1 credit, 5 results with page extracts) -> the 9B
// answers from those results only, citing [n] (thinking off) -> the same
// answer check as the router (shared/answer-check.js): a figure or name not
// in the results means "no clear answer" plus the links, never a guess.
// Called by WF-00 ("Web answer"), never by the model. Nothing is saved to the
// feed (his call: the feed stays his curated beat).
const fs = require('fs');
const path = require('path');

const I = require('./instance.json');
const CRED_LM = I.credentials.lmstudio;
const CRED_TAVILY = I.credentials.tavily;
const inline = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8').replace(/module\.exports[\s\S]*$/, '');

const PREP = inline('web-fallback.js') + `
const q = String($input.first().json.question || '').trim();
return [{ json: { question: q, tavily_body: JSON.stringify(tavilyBody(q)) } }];
`.trim();

const ASK = inline('web-fallback.js') + `
const q = $('Prep').first().json.question;
const results = (($input.first().json || {}).results || []).map((r) => ({ title: r.title || '', url: r.url || '', content: r.content || '' }));
return [{ json: { question: q, results, llm_body: JSON.stringify(webAnswerBody('qwen/qwen3.5-9b', q, results)) } }];
`.trim();

const COMPOSE = inline('web-fallback.js') + inline('answer-check.js') + `
const a = $('Ask the 9B?').first().json;
let answer = '';
try { const m = $input.first().json.choices[0].message; answer = String(m.content || '').trim(); } catch (e) {}
const evidence = a.results.map((r) => r.title + ' ' + r.content).join(' ');
const missing = answer ? unsupportedFacts(answer.replace(/\\[\\d\\]/g, ''), evidence, a.question) : [];
return [{ json: { output: formatWebReply(answer, a.results, missing), web: true, sources: a.results.map((r) => r.url), checked_out: missing.join(', ') } }];
`.trim();

const wf = {
  name: 'WF-44 web_answer',
  nodes: [
    { id: 'trigger', name: 'WF Input', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0],
      parameters: { workflowInputs: { values: [{ name: 'question', type: 'string' }] } } },
    { id: 'prep', name: 'Prep', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: { mode: 'runOnceForAllItems', jsCode: PREP } },
    { id: 'tavily', name: 'Tavily search', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [400, 0],
      parameters: { method: 'POST', url: 'https://api.tavily.com/search',
        authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.tavily_body }}', options: { timeout: 30000 } },
      credentials: { httpBearerAuth: CRED_TAVILY }, retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: 'continueRegularOutput' },
    { id: 'ask', name: 'Ask the 9B?', type: 'n8n-nodes-base.code', typeVersion: 2, position: [600, 0], parameters: { mode: 'runOnceForAllItems', jsCode: ASK } },
    { id: 'answer', name: 'Answer', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [800, 0],
      parameters: { method: 'POST', url: 'http://host.docker.internal:1234/v1/chat/completions',
        authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
        sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.llm_body }}', options: { timeout: 120000 } },
      credentials: { httpBearerAuth: CRED_LM }, retryOnFail: false, onError: 'continueRegularOutput' },
    { id: 'compose', name: 'Compose', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1000, 0], parameters: { mode: 'runOnceForAllItems', jsCode: COMPOSE } }
  ],
  connections: {
    'WF Input': { main: [[{ node: 'Prep', type: 'main', index: 0 }]] },
    'Prep': { main: [[{ node: 'Tavily search', type: 'main', index: 0 }]] },
    'Tavily search': { main: [[{ node: 'Ask the 9B?', type: 'main', index: 0 }]] },
    'Ask the 9B?': { main: [[{ node: 'Answer', type: 'main', index: 0 }]] },
    'Answer': { main: [[{ node: 'Compose', type: 'main', index: 0 }]] }
  },
  settings: { executionOrder: 'v1', errorWorkflow: 'PNJMA4NbQGmp1xKv' }
};

const out = path.join(__dirname, '..', 'workflows', 'wf44-web-answer.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
console.log('wrote', out);
