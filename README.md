# Research Overseer

A research discovery pipeline that runs on my own hardware. It searches (Exa, Tavily, Brave), watches RSS, scrapes what it finds, scores every document against a defined beat using a local 9B model, stores the results in Postgres, and answers questions about them over Telegram.

Built on self-hosted [n8n](https://n8n.io), with [LM Studio](https://lmstudio.ai) serving the triage model and Supabase for storage. One Telegram chat is the entire interface.

**The repo is the source of truth.** Build scripts generate the workflow JSON, so editing a workflow in the n8n UI gets overwritten on the next build. The pure logic they inline is unit-tested.

## Why I built this

I read across six verticals and most of what arrives is unusable. The obvious fix is an LLM that reads everything and flags what matters. That fix failed in a specific way: ask a model "is this relevant, 1 to 5" and it answers 5. On one live query, ten of ten articles scored exactly 5. The filter discriminated nothing.

Getting useful judgment out of a small local model took three changes. I split the single score into two independent axes. I made the model write its angle before rating that angle. And I reordered the response schema, because grammar-constrained decoding emits properties in schema order, so each field conditions the next.

Then there was n8n itself, which fails silently in ways you only catch by auditing the data. One sub-workflow default wrote every result against the first document and dropped 38% of a corpus. It ran that way for days.

So nothing here is hand-edited in a UI. Scripts generate the workflows, and the logic they inline is unit-tested. It runs on a 12 GB card with a 9B model, because per-document API costs would have killed the habit of running it at all.

## Where the model actually is

Two of the ten pipeline stages call a model. The rest is code, which is what makes the behaviour reproducible and the tests meaningful.

| # | Stage | Kind | Implementation |
|---|---|---|---|
| 1 | Discovery | code | Exa, Tavily, Brave APIs; RSS reader (WF-10..13) |
| 2 | URL canonicalization | code | `shared/canonicalize.js`, unit-tested |
| 3 | Dedupe | code | `seen_urls` primary key, one SQL statement |
| 4 | Scrape | code | Crawl4AI, Firecrawl on failure |
| 5 | **Triage** | **model** | qwen3.5-9b via LM Studio, `json_schema` constrained |
| 6 | Response validation | code | `shared/triage-validate.js`, recovers JSON stranded in `reasoning_content` |
| 7 | Storage and scoring | code | Postgres; `score` is a generated column, not a model output |
| 8 | Recency filtering | code | date arithmetic on `published_at` |
| 9 | **Request routing** | **model** | Claude Haiku via OpenRouter, tool-calling only |
| 10 | Reply formatting | code | `shared/telegram-format.js`, HTML escape and markdown strip |

Recency is stage 8 rather than a scoring axis on purpose. Exa and Brave return a publication date on roughly every result, so recency is subtraction. Asking a 9B model to rate it 1 to 5 would be a lossy substitute for arithmetic it cannot do better.

## What I measured

Numbers from the running system.

**Triage speed is governed by reasoning tokens, not input length.** The same document at three read lengths: 2,500 chars took 38.7s, 6,000 took 47.4s, 8,000 took 32.3s. The longest read was the fastest. Qwen spends roughly 3,000 tokens thinking to emit about 120 tokens of JSON. Truncating the input to speed things up does nothing. Thinking cannot be disabled either: `enable_thinking`, a `/no_think` suffix, and `reasoning_effort: minimal` were all tried and all ignored.

**A single relevance score is useless at this scale.** Of 175 items scored on the original 1-5 axis, 93% landed on 4 or 5 and 71% scored exactly 5. Splitting it into specificity and angle strength took the distinct values on a 10-item sample from 1 to 4, and the two axes agreed exactly on only 3 of 9 items, so they measure different things.

**Specificity measures how checkable a claim is.** A numbers-heavy vendor budget guide can outscore a news break. Worth knowing before trusting the ranking.

**The n8n sub-workflow default is a data-loss bug.** `mode` defaults to `once`, which sends an entire batch into a single sub-workflow execution. It wrote N results against the first document and silently dropped the rest, costing 38% of the corpus before anyone noticed. WF-21 now throws if it receives more than one item.

## Current state

261 documents triaged across 54 runs, 10 active RSS sources, 46 tests running in about 100ms with no dependencies.

## Limitations

Wired but incomplete:

- **RSS items get no structured extraction.** Skills attach to standing queries, not sources, so an article arriving via RSS has no `country` or `instrument` in its `structured` column and never groups into the `feed_stories` view.
- **204 of 261 items predate the two-axis scoring** and carry only the dead `relevance` score, so a `min_score` filter sees a fraction of the corpus. They came from build-time test searches, and backfilling them would tune nothing.
- **10 items are `TRIAGE_FAILED`**, kept rather than dropped so failures stay visible.

Deliberately deferred:

- `relevance` still exists alongside the axes for comparison. It gets dropped once the axes have proven themselves over a longer run.
- Firecrawl is wired as a scrape fallback but rarely fires. Crawl4AI handles almost everything.

## How to read this repo

About 15 minutes, in this order:

1. `shared/triage-config.js`: the triage prompt, the response schema, and the reasoning behind both. Field order is load-bearing.
2. `scripts/build-wf20.js`: how a workflow gets generated, and how `inline()` pastes tested source into a Code node.
3. `sql/006_triage_axes.sql`: the scoring migration, with the distribution data that motivated it.
4. `tests/triage-validate.test.js`: what a 9B model does to your JSON when the reasoning budget runs out.

## Layout

```
sql/         numbered Supabase migrations, applied in order
shared/      pure logic, inlined into n8n Code nodes at build time
scripts/     build-wf*.js generators, deploy.js, instance.json
workflows/   generated and hand-maintained n8n JSON; tools/ are test harnesses
tests/       node:test, no dependencies
docker/      compose file and the Crawl4AI config override
```

## Running it

```bash
npm test                                   # run before every deploy
npm run build                              # regenerate workflows/ from scripts/
node scripts/deploy.js wf20-process-urls   # deploy one workflow
node scripts/deploy.js --all               # deploy everything
```

Committed workflow JSON carries no live values. Personal and instance-specific values are placeholders (`__TG_TOKEN__`, `__TG_CHAT__`, `__ZZ_SECRET__`, `__BEAT__`) that `scripts/deploy.js` substitutes from `.env`, `scripts/instance.json`, and `beat.md`.

The beat itself is untracked. It is the editorial definition of what the model scores against, so it stays out of the repo: copy `beat.example.md` to `beat.md` and write your own.

## From scratch

1. **Containers.** One-time: `docker volume create n8n_data`, `docker network create overseer`, then `docker compose -f docker/docker-compose.yml --env-file .env up -d`.
2. **LM Studio.** Native install, not a container. Enable the server with auth, then `lms server start && lms load qwen/qwen3.5-9b -y`. Needs about 7 GB of VRAM.
3. **Database.** Create a Supabase project and run `sql/001` through `sql/009` in order.
4. **Secrets and beat.** Copy `.env.example` to `.env` and fill it. Copy `beat.example.md` to `beat.md`.
5. **n8n credentials.** Create the Postgres, Telegram, OpenRouter, Crawl4AI, LM Studio, and Firecrawl credentials in the n8n UI, then put their ids in `scripts/instance.json`.
6. **Workflows.** Import from `workflows/`, put the resulting ids in `scripts/instance.json`, then `node scripts/deploy.js --all`. Publish everything: the error workflow has to stay published or it never fires.

Inbound Telegram uses `getUpdates` polling, so n8n needs no public URL and no tunnel. Keep it that way. The ZZ helper webhooks authenticate by path suffix alone and must never be reachable from the internet.
