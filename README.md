# The Scout — Research Overseer, Step 2

Telegram-driven research discovery pipeline on n8n + Supabase + Crawl4AI + Ollama.
Spec: `Obsidian Vault/Research Agentic Architecture Summary/the-scout-build-spec.md`.

## Layout

- `sql/` — Supabase DDL, numbered migrations. `001_init.sql` = spec §4.
- `workflows/` — exported n8n workflow JSON, committed after each phase passes (spec §0).
- `shared/` — Code-node sources and prompts referenced by workflows
  (`canonicalize.js` = WF-20 canonicalizer, `triage-prompt.md` = Qwen triage).
- `.mcp.json` — n8n-mcp server for Claude Code (needs `N8N_API_KEY` env var).

## Build phases (spec §6)

1. WF-20 shared tail + DDL + WF-99 error workflow
2. WF-10 Exa discovery
3. WF-11..13 (Tavily, Brave, RSS) + direct scrape
4. Read tools (query_feed, run_status)
5. Scheduling (schedules CRUD + WF-30 poller)
6. WF-00 agent router (Telegram, Claude Haiku)

## Services

| Service | Where | Port |
|---|---|---|
| n8n | Docker `n8n` | 5678 |
| Crawl4AI | Docker `crawl4ai` | 11235 |
| Ollama | TBD (not yet installed) | 11434 |
| Postgres | Supabase cloud | pooler |
