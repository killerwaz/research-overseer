// Triage system prompt + response schema, shared by the build scripts so WF-20
// (live pipeline) and WF-30 (backlog drain) can never drift apart.
//
// v2 (2026-07-26): two judgement axes replace the single `relevance` score,
// which collapsed — on a real query ("AI infrastructure costs") 10 of 10 items
// scored 5, so min_relevance filtered nothing. `relevance` is still emitted
// alongside for A/B comparison and will be dropped once the axes are trusted.
//
// Deliberately NOT an axis: novelty. exa and brave return a publication date on
// ~100% of results, so recency is exact SQL arithmetic on published_at rather
// than a 9B model's guess. The prompt still receives the dates so it does not
// invent recency inside the summary.
//
// The beat — what the writer actually covers — is personal editorial
// configuration and stays out of the repo. beat.md (gitignored; one paragraph
// of plain prose, no quotes/backticks/backslashes) is substituted for
// __BEAT__ by scripts/deploy.js. Copy beat.example.md to beat.md to start.
const BEAT = '__BEAT__';

const TRIAGE_SYSTEM = [
  'You are a research triage assistant for a writer covering: ' + BEAT,
  'The audience is practitioners — people who build and operate these systems,',
  'not general readers. Score every article against that beat, not general',
  'interest.',
  '',
  'You read one scraped article and return ONLY a JSON object with exactly these',
  'fields, in this order:',
  '',
  'summary: 2-3 sentences on what the article actually says. Substance only — no',
  'meta-commentary about the article itself.',
  '',
  'angle: one sentence naming the specific, publishable hook this gives the writer',
  'for that audience. Use null if there is no defensible angle beyond restating',
  'the article.',
  '',
  'relevance (integer 1-5): overall usefulness to that beat.',
  '',
  'specificity (integer 1-5): how well anchored the claims are.',
  '  5 = concrete data points, named companies and people, quantified outcomes,',
  '      verifiable claims.',
  '  3 = a mix — some claims backed, some asserted.',
  '  1 = entirely abstract commentary, opinion, or speculation with nothing to',
  '      check. Vendor content marketing and SEO listicles that recycle public',
  '      figures without sourcing belong at 1-2.',
  '',
  'angle_strength (integer 1-5): how good the angle you just wrote actually is.',
  '  5 = supports a contrarian, non-obvious, or counterintuitive take that most',
  '      commentators would miss.',
  '  3 = a viable angle, but the obvious one most people would write.',
  '  1 = no defensible angle. If angle is null, angle_strength is 1.',
  '',
  'tags: array of 1-5 short lowercase kebab-case topic tags (e.g. "ai-agents",',
  '"frontier-markets", "inference-cost"). No spaces, no punctuation.',
  '',
  'Scoring rules:',
  '- specificity and angle_strength are independent. Judge each on its own',
  '  evidence and do not let one pull the other. An article often deserves a high',
  '  score on one and a low score on the other; that spread is the point.',
  '- Most articles are not 5s. A typical useful article lands at 2-4. Reserve 5',
  '  for cases that clearly meet its anchor.',
  '- If the content is unusable — a paywall stub, error page, login wall, or a',
  '  navigation/index/listing page with no article body — set angle to null, set',
  '  all scores to 1, and say so in the summary.',
  '',
  'Return nothing except the JSON object.'
].join('\n');

// Property order is load-bearing: grammar-constrained decoding emits fields in
// schema order, so summary forces a real read before any number is committed,
// and angle_strength comes after the angle it rates.
const TRIAGE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'triage', strict: true,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        angle: { type: ['string', 'null'] },
        relevance: { type: 'integer', minimum: 1, maximum: 5 },
        specificity: { type: 'integer', minimum: 1, maximum: 5 },
        angle_strength: { type: 'integer', minimum: 1, maximum: 5 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 }
      },
      required: ['summary', 'angle', 'relevance', 'specificity', 'angle_strength', 'tags'],
      additionalProperties: false
    }
  }
};

const TRIAGE_MODEL = 'qwen/qwen3.5-9b';

// Per-source triage profiles.
//
// MEASURED, 2026-07-27 — read this before tuning, it is counter-intuitive:
// triage time tracks the model's REASONING OUTPUT, not how much you feed it.
// Same document at three read lengths: 2500 chars/2835 tokens/38.7s,
// 6000/4113/47.4s, 8000/2779/32.3s. The longest read was the fastest.
// Qwen spends ~3000 tokens thinking to produce ~120 tokens of JSON, and that
// is where the ~33s goes.
//
// Suppressing the thinking does not work on this model: enable_thinking via
// chat_template_kwargs, a /no_think suffix, and reasoning_effort:minimal were
// all tried and all ignored (2900-3300 tokens, 32-38s, no change).
//
// So `content_chars` does NOT buy speed. It buys judgement quality and context
// budget, which is still worth varying: a feed blurb has nothing after 2500
// chars, a hand-picked URL deserves the full read.
//
// The one real speed/cost lever is `model`. LM Studio serves every loaded
// model on the same endpoint with the same key, so pointing a source at a
// different model needs no new credential or URL — just `lms load <id>` first.
// If the named model is not loaded the request fails, retries, and falls back
// to TRIAGE_FAILED, so a missing model degrades rather than breaks.
//
// max_tokens is a ceiling, not a target — the model stops on its own well
// below it. Keep it above ~2500 or the reasoning strands the JSON.
const TRIAGE_PROFILES = {
  // Feed items are short and mostly low-signal; a smaller read is plenty.
  rss:     { model: TRIAGE_MODEL, content_chars: 2500, max_tokens: 3000 },
  // Search hits on the standing queries are the material worth thinking about.
  exa:     { model: TRIAGE_MODEL, content_chars: 6000, max_tokens: 6000 },
  tavily:  { model: TRIAGE_MODEL, content_chars: 6000, max_tokens: 6000 },
  brave:   { model: TRIAGE_MODEL, content_chars: 6000, max_tokens: 6000 },
  // A URL pasted by hand was chosen deliberately — read it properly.
  manual:  { model: TRIAGE_MODEL, content_chars: 8000, max_tokens: 6000 },
  default: { model: TRIAGE_MODEL, content_chars: 6000, max_tokens: 6000 }
};

function profileFor(source) {
  const key = String(source || '').toLowerCase().trim();
  return TRIAGE_PROFILES[key] || TRIAGE_PROFILES.default;
}

module.exports = { TRIAGE_SYSTEM, TRIAGE_SCHEMA, TRIAGE_MODEL, TRIAGE_PROFILES, profileFor };
