# memento

A local-first, cross-tool **context memory bank** for AI coding sessions.

It ingests your Cursor session transcripts, builds a **labeled property graph** in
SurrealDB (nodes: sessions, prompts, files, projects; edges: `contains`, `touched`,
`about`), and feeds that memory back into every new AI chat — so a fresh session
already knows what you've been working on.

Two ways the memory reaches your editor:

1. **Rules-file injection (default, zero-config):** the daemon writes an
   always-applied Cursor rule at `~/.cursor/rules/memento.mdc`. Every chat,
   in every project, reads it automatically at start. No MCP server, no tool call,
   no admin permission.
2. **MCP + CLI:** query the graph on demand (`search`, `resume`, `stats`).

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design.

---

## How it works

```
Cursor transcripts                SurrealDB (graph + FTS + vectors)         Cursor
~/.cursor/projects/**/*.jsonl  ─▶  session ─contains─▶ prompt          ─▶  ~/.cursor/rules/
        │  (adapter)                   └─touched─▶ file                     memento.mdc
        │                              └─about───▶ project                  (always-applied)
        ▼                                   ▲                                     ▲
   daemon: poll for new/changed  ──────────┘   digest export (every change) ──────┘
   sessions, enrich, write graph
```

The **daemon** runs these loops:

- **Incremental ingest** — every minute it scans sources for new/changed
  transcripts (by mtime) and ingests only those. Idempotent: re-reading a grown
  transcript converges instead of duplicating.
- **Notes indexing** — on the same tick it walks the configured notes roots and
  indexes new/changed files (see [Notes & files indexing](#notes--files-indexing)).
- **Enrichment** — each session gets a deterministic summary + title (optionally
  an LLM summary / embeddings).
- **Digest export** — whenever something changes (and on a safety-net interval) it
  rewrites the `.mdc` rule file atomically.

No manual backfill needed once the daemon is running.

## Stack

- **Runtime:** Node ≥ 22 (24 recommended)
- **Store:** SurrealDB 2.x SDK / 3.x engine (property graph + full-text BM25 + HNSW vectors + LIVE change-feeds)
- **Enrichment:** deterministic (default, free, offline) + optional LLM (Ollama / OpenAI / Gemini)
- **Serving:** always-apply `.mdc` rule, CLI, MCP

## Quick start

```bash
# 1. Install (prerequisites, deps, build, .env, data dir; optional SurrealDB + MCP)
./install.sh                 # interactive;  ./install.sh --help for flags

# 2. First-time data load (start DB + init schema + backfill your transcripts)
./run.sh bootstrap

# 3. Start the services (SurrealDB + daemon)
./run.sh start
```

That's it. Open a new Cursor chat — it now sees your recent history via the
auto-generated rule file. The daemon keeps everything fresh from here on.

## Usage

### Automatic (no action needed)

The daemon maintains `~/.cursor/rules/memento.mdc`. Inspect what it feeds Cursor:

```bash
cat ~/.cursor/rules/memento.mdc
```

### On-demand queries

```bash
./run.sh cli search "surrealdb schema"                 # hybrid search
./run.sh cli search "pdlc report" --project home-maragos-ai --limit 5
./run.sh cli resume --project home-maragos-ai          # cold-start briefing
./run.sh cli stats                                     # node counts
./run.sh cli export                                    # force-rewrite the .mdc now
```

**Hybrid search:** `search` is BM25 full-text by default. Set `MEM_EMBED=ollama`
(and enrich with embeddings) to add semantic vector search — results from both are
fused with Reciprocal Rank Fusion. With no embeddings it stays pure BM25, so it
works out of the box and gets better when you turn embeddings on.

Project slugs are the `## headings` in the `.mdc` file.

### Notes & files indexing

Beyond AI sessions, memento can index your **notes/files** (markdown, text, org,
rst, PDF) so their content is searchable alongside your session history. The daemon
walks the configured roots on the same poll loop (incremental by mtime); notes are
surfaced via `search`, MCP, and the web UI — they are **not** added to the digest.

```bash
./run.sh cli notes                 # index now (first run does a full pass)
./run.sh cli search "quarterly budget"   # notes appear as type: "document"
```

- **Roots:** default `~/notes` and `~/Documents`. Set `MEM_NOTES_ROOTS` (a
  `:`-separated list) to anything — e.g. `MEM_NOTES_ROOTS=$HOME` to index your whole
  home directory.
- **Safety:** dotdirs, caches, `node_modules`, and obvious secret files (`.env*`,
  `*.pem`, `*.key`, `id_rsa`, `credentials`, …) are always skipped, plus a per-file
  size cap (`MEM_NOTES_MAX_BYTES`, default 1 MB).
- **PDF:** text is extracted if the optional `pdf-parse` dep is installed (it's in
  `optionalDependencies`); otherwise PDFs are indexed by filename only.

### Decisions, gotchas & TODOs

On enrichment, memento mines each session transcript for **decisions**
("we decided…", "going with…", "use X instead"), **gotchas** ("gotcha", "root
cause", "the bug was…", "fixed by…"), and **TODOs** ("todo", "next step",
"follow-up"). These are stored as `decision` nodes (`session ->decided-> decision`)
and surfaced three ways:

- **CLI/MCP `search`** — decisions are searchable alongside sessions, prompts, and notes.
- **Web UI** — a dedicated **Decisions** tab (filter by kind, click through to the
  session); also listed in the session drill-down panel.
- **Digest** — up to a few per session appear under each entry in the `.mdc` file,
  marked `→` (decision), `⚠` (gotcha), `☐` (todo).

Extraction is deterministic (no LLM required) and idempotent — re-reading a grown
transcript replaces the session's decisions rather than duplicating them.

### Git integration

memento indexes **commits from your local git repos** so your work history and
your code history live in one graph. Each commit becomes a `commit` node (searchable
by message) linked to the files it changed (`commit ->changed-> file`) — reusing the
same `file` nodes sessions touch, which auto-connects commits to the sessions that
worked on those files.

```bash
./run.sh cli git                       # index commits now (daemon also does this)
./run.sh cli search "fix race condition"   # commits appear as type: "commit"
```

- **Repo discovery:** set `MEM_GIT_ROOTS` (a `:`-separated list of repo dirs), or
  leave it empty to auto-discover git repos under `$HOME` (depth `MEM_GIT_SCAN_DEPTH`,
  default 2; caches/dotdirs skipped).
- **Window:** only commits newer than `MEM_GIT_LOOKBACK_DAYS` (default 180) are
  ingested, capped at `MEM_GIT_MAX_COMMITS` per repo (default 500). Sync is
  incremental (hashes already stored are skipped) — disable entirely with `MEM_GIT=false`.

### Ask & recall (local RAG with citations)

Two retrieval commands sit on top of hybrid search:

```bash
./run.sh cli recall "how did we set up hybrid search"   # cited context, no LLM
./run.sh cli ask "why did we pick RRF over reranking?"   # grounded answer + citations
```

- **`recall`** is retrieval-only and always available: it returns the top sources
  (sessions, notes, decisions, commits, prompts) each with a citation line
  `[n] <type> (project, date) — title` and a short snippet.
- **`ask`** feeds those numbered sources to an LLM and asks it to answer using only
  them, citing inline as `[n]`. It needs a model (`MEM_ENRICH=ollama`); with no LLM
  configured it degrades to `recall`. Both honor `--project` and `--limit`, and use
  semantic vectors automatically when embeddings are enabled.

### Related (cross-entity links)

memento connects entities by **shared-file co-occurrence**, computed at query time
(always fresh, never stale): for any session it finds other sessions that touched
the same files (ranked by overlap), the files themselves, notes in the same
project, and **commits** that changed those same files.

```bash
./run.sh cli related "auth refactor"   # related sessions/files/notes/commits for the best match
```

In the web UI this appears as a **Related** section in the session drill-down
(click a related session to jump to it).

### Service lifecycle (`run.sh`)

| Command | Purpose |
| --- | --- |
| `./run.sh start [db\|daemon\|all]` | start services (default `all`) |
| `./run.sh stop [db\|daemon\|all]` | stop services |
| `./run.sh restart [db\|daemon\|all]` | stop then start |
| `./run.sh status` | what's running + node counts |
| `./run.sh logs [db\|daemon\|serve]` | tail a service log |
| `./run.sh bootstrap` | start db + init schema + full backfill |
| `./run.sh serve` | start the web UI / API server |
| `./run.sh cli <cmd> …` | run a CLI command (`search`, `notes`, `pin`, `doctor`, …) |

## Visualization (web UI)

A local, read-only web app to explore the graph: an interactive **2D/3D
force-graph**, a per-project **timeline**, a **decisions** feed, a **stats
dashboard**, and live **search** with drill-down into any session's summary,
files, decisions, related sessions/notes, and transcript.

Stack: a tiny Node `http` JSON API (`src/serve`, loopback-only) + a Vite + React +
Tailwind SPA (`web/`) with `react-force-graph` (WebGL).

```bash
# one-time: build the SPA (outputs web/dist, served by the API)
cd web && npm install && npm run build && cd ..

# start it (needs SurrealDB running)
./run.sh serve            # -> http://127.0.0.1:7077
```

For UI development with hot-reload, run the API and the Vite dev server (it proxies
`/api` to `:7077`):

```bash
./run.sh serve                       # backend API on :7077
cd web && npm run dev                # UI on :5173
```

## Configuration

Copy `.env.example` to `.env` (the installer does this). Key settings:

| Variable | Default | Description |
| --- | --- | --- |
| `MEM_DB_URL` | `ws://127.0.0.1:8000/rpc` | SurrealDB endpoint |
| `MEM_DB_USER` / `MEM_DB_PASS` | `root` / `root` | credentials |
| `MEM_DB_NS` / `MEM_DB_DB` | `memento` / `memory` | namespace / database |
| `MEM_ENRICH` | `deterministic` | `deterministic` \| `ollama` \| `openai` \| `gemini` |
| `MEM_EMBED` | `none` | `none` \| `ollama` \| `openai` \| `transformers` |
| `MEM_MDC` | `true` | write the always-apply rule file |
| `MEM_MDC_PATH` | `~/.cursor/rules/memento.mdc` | rule file location |
| `MEM_MDC_LIMIT` | `12` | max sessions in the digest |
| `MEM_MDC_INTERVAL_MS` | `300000` | digest safety-net re-export cadence |
| `MEM_INGEST_WATCH` | `true` | daemon auto-ingests new/changed sessions |
| `MEM_INGEST_INTERVAL_MS` | `60000` | ingest poll cadence |
| `MEM_NOTES` | `true` | index notes/files (documents) too |
| `MEM_NOTES_ROOTS` | `~/notes:~/Documents` | `:`-separated dirs to index (set to `$HOME` for everything) |
| `MEM_NOTES_EXTS` | `.md,.markdown,.txt,.org,.rst,.pdf` | file types to index |
| `MEM_NOTES_MAX_BYTES` | `1000000` | skip files larger than this |
| `MEM_NOTES_IGNORE` | (dotdirs, caches, …) | directory names to skip |
| `MEM_GIT` | `true` | index commits from local git repos |
| `MEM_GIT_ROOTS` | (auto) | `:`-separated repo dirs; empty = auto-discover under `$HOME` |
| `MEM_GIT_SCAN_DEPTH` | `2` | auto-discovery depth below `$HOME` (0 disables) |
| `MEM_GIT_LOOKBACK_DAYS` | `180` | only ingest commits newer than this |
| `MEM_GIT_MAX_COMMITS` | `500` | cap per repo (newest first) |
| `MEM_SERVE_HOST` / `MEM_SERVE_PORT` | `127.0.0.1` / `7077` | web UI / API bind address |

## Manual / development

```bash
cp .env.example .env
npm install
npm run build            # compile to dist/  (run.sh prefers dist/, falls back to src/)

# run TypeScript directly during development:
npm run dev:cli -- init
npm run dev:cli -- backfill --tool cursor
npm run dev:daemon
```

`backfill` is idempotent, so it's safe to re-run for a full rebuild.

## Layout

```
src/core/        types, config, db, schema, queries, graph, log
src/adapters/    SourceAdapter + cursor / claude (stub) + notes (files/docs) + git (commits)
src/enrichment/  EnrichmentProvider + deterministic / llm + run helper
src/export/      MdcExporter (always-apply rules-file digest)
src/ingest/      backfill (full + incremental sync) + notes + git + live enrichment subscriber
src/daemon/      long-running ingest + enrichment + export process
src/mcp/         stdio MCP server
src/cli/         standalone CLI
src/serve/       read-only JSON API + static file server for the web UI
web/             Vite + React + Tailwind SPA (graph / timeline / stats / search)
install.sh       one-time machine setup
run.sh           service lifecycle (start/stop/status/logs/bootstrap/serve)
```

## Status & limitations

- **Cursor** is the implemented source; the **Claude** adapter is a stub.
- Enrichment defaults to deterministic (no network). LLM summaries/embeddings are opt-in.
- Ingest is **poll-based** (mtime diff on a short interval), which is robust and
  cheap; a true fs-watcher (`SourceAdapter.watch`) is stubbed for a future phase.
- Single-user, local-first. The DB listens on loopback with default `root` creds —
  change them for anything shared.
