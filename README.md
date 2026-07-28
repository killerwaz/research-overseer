# Research Overseer

Telegram-driven research discovery pipeline: a bot that searches (Exa, Tavily,
Brave), watches RSS, scrapes (Crawl4AI, Firecrawl fallback), triages every
document with a local LLM against a defined beat, stores the results in
Postgres, and answers questions about what it found.

Runs on self-hosted **n8n**, with **LM Studio** serving the triage model
locally (`qwen/qwen3.5-9b`) and **Supabase** Postgres as the store. One
Telegram chat is the entire UI.

## How this repo works

**Workflows are generated, not hand-edited.** `scripts/build-wf*.js` emit the
JSON in `workflows/`; editing a workflow in the n8n UI gets overwritten on the
next build. Pure logic lives in `shared/` and is inlined into Code nodes at
build time — which is what makes the test suite meaningful: the tests exercise
the code that actually ships inside n8n.

Committed workflow JSON carries no live values. Personal/instance values are
placeholders (`__TG_TOKEN__`, `__TG_CHAT__`, `__ZZ_SECRET__`, `__WF40_ID__`,
`__BEAT__`) substituted at deploy time by `scripts/deploy.js` from `.env`,
`scripts/instance.json`, and `beat.md`. The beat — the editorial definition of
what the triage model scores against — is deliberately untracked: copy
`beat.example.md` to `beat.md` and write your own.

```
sql/        numbered Supabase migrations, apply in order
shared/     pure logic + triage prompt config, inlined into nodes at build
scripts/    build-wf*.js (generators), deploy.js, instance.json (n8n ids)
workflows/  generated + hand-maintained n8n JSON; tools/ = ZZ test harnesses
tests/      node:test suite, no deps  (npm test — runs in ~100ms)
docker/     docker-compose.yml + Crawl4AI config override
```

## Everyday commands

```bash
npm test                                   # run before every deploy
npm run build                              # regenerate workflows/ from scripts/
node scripts/deploy.js wf20-process-urls   # deploy one workflow
node scripts/deploy.js --all               # deploy everything
```

## From scratch

1. **Containers** — one-time: `docker volume create n8n_data`,
   `docker network create overseer`, then
   `docker compose -f docker/docker-compose.yml --env-file .env up -d`.
2. **LM Studio** — native install (not a container), enable the server with
   auth, then `lms server start && lms load qwen/qwen3.5-9b -y`. Needs ~7 GB
   VRAM; auto-unloads after idle.
3. **Database** — create a Supabase project, run `sql/001..009` in order.
4. **Secrets and beat** — copy `.env.example` to `.env` and fill it (n8n API
   key, Telegram bot token + chat id, search API keys, webhook suffix); copy
   `beat.example.md` to `beat.md` and write the beat you want articles scored
   against.
5. **n8n credentials** — create Postgres, Telegram, OpenRouter, Crawl4AI
   bearer, LM Studio bearer, and Firecrawl credentials in the n8n UI, then put
   their ids in `scripts/instance.json`.
6. **Workflows** — import the JSON from `workflows/` (or create empty
   workflows and note their ids), fill the ids into `scripts/instance.json`,
   then `node scripts/deploy.js --all`. Publish everything — the error
   workflow (WF-99) must stay published or it never fires.

Inbound Telegram uses **getUpdates polling** — no public URL, no tunnel. Keep
it that way: the ZZ helper webhooks (SQL runner, test harnesses) authenticate
by path suffix only and must never be internet-reachable.

## Operational notes

The real operating manual — gotchas, measured triage behaviour, data model,
recovery steps — is `CLAUDE.md`. Start there before changing anything.
