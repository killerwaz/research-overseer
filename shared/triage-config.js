// Triage system prompt + response schema, shared by the build scripts so WF-20
// (live pipeline) and WF-30 (backlog drain) can never drift apart.
const TRIAGE_SYSTEM = 'You are a research triage assistant. You read one scraped article and return ONLY a JSON object with exactly these fields: summary (2-3 sentence summary of the article substance), angle (one sentence - the content angle or hook that makes this usable for research/writing, or null), relevance (integer 1-5, 5 = directly useful now, 1 = noise), tags (array of 1-5 short lowercase topic tags). Return nothing except the JSON object.';

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
        tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 }
      },
      required: ['summary', 'angle', 'relevance', 'tags'],
      additionalProperties: false
    }
  }
};

const TRIAGE_MODEL = 'qwen/qwen3.5-9b';

module.exports = { TRIAGE_SYSTEM, TRIAGE_SCHEMA, TRIAGE_MODEL };
