# memorcy — Architecture

A local-first, cross-tool **context memory bank** for AI coding sessions. It ingests
session data from Cursor (and other tools) plus your home directory, builds a
**labeled property graph** in SurrealDB, and serves that memory back to any AI tool
via **MCP**, a **CLI**, and an optional REST/UI.

> Goal: any new session — in any tool — can answer *"what has this user been working
> on, where, and what was decided?"* without re-explaining.

---

## 1. Design decisions (locked)

| Dimension | Choice | Rationale |
|-----------|--------|-----------|
| Scope | Cross-tool + standalone "memory bank" with search | Not locked to Cursor |
| Storage engine | **SurrealDB** (daemon, local) | One engine: graph + vector + full-text + LIVE change-feeds |
| Graph model | **Labeled Property Graph** | Rich node/edge properties, fast multi-hop |
| Language | **TypeScript** (Node 24; Bun optional) | First-class MCP + SurrealDB SDKs; I/O/model-bound workload |
| Enrichment | **Deterministic + LLM** behind an interface | Free/private baseline, optional richer summaries |
| Coordination bus | **SurrealDB LIVE queries** | Change-feeds replace a broker (Pulsar/Redis) — zero extra infra |
| Distribution | Two thin processes + shared core lib | `daemon` (ingest/enrich) + `mcp` (stdio, per tool) |

### Why not the polyglot (Rust + Python) stack?
Excellent for a distributed/team platform, but over-engineered for a personal/standalone
product: 3× the maintenance surface. The workload is dominated by disk I/O, embeddings,
and LLM calls — host-language CPU speed is not the bottleneck. Reserve Rust/Python for a
**proven** hot spot (e.g. heavy local ML), added later behind the provider interfaces.

---

## 2. Topology

```
                 +------------------------------+
                 |      SurrealDB (daemon)       |
                 |  LPG + vector + FT + LIVE     |
                 +---------------+--------------+
                                 ^  ^
             connects (WS)       |  |   connects (WS)
          +----------------------+  +----------------------+
          |                                                |
+---------+-----------+                        +-----------+----------+
| memory-daemon (TS)  |                        |  memory-mcp (TS)     |
|  - source adapters  |                        |  - stdio MCP server  |
|  - backfill         |                        |  - query tools       |
|  - LIVE subscribers |                        |  spawned per AI tool |
|  - enrichment       |                        +-----------+----------+
+---------+-----------+                                    |
          | reads                                          | serves
          v                                                v
  Cursor / Claude / Copilot / home dir            Any AI tool + CLI + UI
```

- **SurrealDB** is the only external dependency and the single coordination point.
- **memory-daemon**: long-running; discovers + backfills sessions, subscribes to LIVE
  changes, runs enrichment. One per machine.
- **memory-mcp**: thin stdio server, spawned by each AI tool; only *reads* the graph.
- Both share `src/core` (db, schema, types, queries).

---

## 3. Data model (Labeled Property Graph)

### Node tables
| Table | Meaning | Key properties |
|-------|---------|----------------|
| `session` | one AI chat/agent run | `tool`, `external_id`, `project`, `started_at`, `ended_at`, `title`, `summary`, `summary_embedding` |
| `project` | a workspace | `name`, `path`, `slug` |
| `repo` | a git repository | `remote`, `root_path`, `default_branch` |
| `file` | a file referenced/edited | `path`, `repo`, `language` |
| `command` | a shell command run | `text`, `cwd`, `exit_code` |
| `prompt` | a user/assistant message | `role`, `text`, `ts`, `text_embedding` |
| `decision` | an extracted insight/decision | `text`, `kind`, `confidence`, `text_embedding` |
| `code_entity` | fn/class/module (optional) | `name`, `kind`, `file` |
| `person` | user identity | `email`, `name` |
| `tool_call` | MCP/tool invocation | `name`, `input`, `ts` |

### Edges (SurrealDB `RELATE`)
| Edge | From → To | Meaning |
|------|-----------|---------|
| `about` | session → project | session concerns project |
| `maps_to` | project → repo | project is this repo |
| `touched` | session → file | file edited/referenced (props: `op`, `ts`, `count`) |
| `ran` | session → command | command executed |
| `contains` | session → prompt | message belongs to session |
| `follows` | session → session | temporal chain (previous session) |
| `relates_to` | decision → file/project/session | what a decision is about |
| `references` | file → code_entity | symbol reference |
| `authored_by` | session → person | who ran it |
| `invoked` | session → tool_call | tool usage |

### Indexes
- **Vector**: HNSW on `session.summary_embedding`, `prompt.text_embedding`,
  `decision.text_embedding`.
- **Full-text**: analyzers on `prompt.text`, `session.summary`, `decision.text`,
  `command.text`.
- **Unique**: `session (tool, external_id)`, `file (repo, path)`, `project (slug)`.

Retrieval is **hybrid GraphRAG**: full-text + vector candidates, then graph expansion
(e.g. "sessions that `touched` this file and their `decision`s").

---

## 4. Common event schema

Every adapter normalizes its source into one stream of `RawEvent`s. Adding a tool =
writing one adapter; nothing downstream changes.

```ts
interface RawEvent {
  tool: string;               // 'cursor' | 'claude' | 'copilot' | ...
  project: string;            // project slug/name
  sessionId: string;          // adapter-stable session id
  ts: string;                 // ISO timestamp
  actor: 'user' | 'assistant' | 'system' | 'tool';
  kind: 'prompt' | 'response' | 'edit' | 'command' | 'tool_call' | 'meta';
  text?: string;
  refs?: EventRef[];          // files, commands, repos, tools
  raw?: unknown;              // original payload (for re-processing)
}
```

The normalizer maps `RawEvent`s to node upserts + edge `RELATE`s.

---

## 5. Source adapters

```ts
interface SourceAdapter {
  id: string;
  discover(): AsyncIterable<SessionRef>;        // enumerate sessions
  read(s: SessionRef): AsyncIterable<RawEvent>; // events for one session
  watch?(onEvent: (e: RawEvent) => void): Disposable; // live capture (optional)
}
```

### Cursor adapter (primary)
Sources on disk (confirmed on this machine):
- `~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl` — clean role/text
  transcripts (best signal/byte). **Primary source.**
- `~/.cursor/chats/<hash>/<uuid>/{store.db,meta.json,prompt_history.json}` — deep
  archive (~1.1 GB). **Optional deep backfill (phase 5).**
- `~/.config/Cursor/User/**/state.vscdb` — chat titles / workspace mapping (best effort).
- `~/.cursor/projects/<project>/repo.json`, `~/.cursor/unified_repo_list.json` — project→repo mapping (free `about`/`maps_to` edges).

Live capture: a Cursor **`stop` hook** writes/points at the transcript; the daemon's
`watch()` (fs watcher on the transcripts dir) ingests incrementally. `stop` is reliable;
`sessionStart` context-injection is historically flaky — see §8.

### Other adapters (stubs)
- `claude` — `~/.claude/**` sessions.
- `copilot`, `codex`, `gemini` — future; same interface.
- `homedir` — git logs + docs/journals (e.g. `**/session_journal.md`) → `decision`/`repo` nodes.

---

## 6. Enrichment

```ts
interface EnrichmentProvider {
  id: string;
  embed?(texts: string[]): Promise<number[][]>;
  summarize?(input: SessionForSummary): Promise<SessionSummary>;
}
```

- **Deterministic** (default, free, private): files touched, commands, repos, prompt
  keywords, temporal `follows` links, git correlation. Covers ~70% of "what happened".
- **LLM** (optional): per-session summary + extracted `decision` nodes. Providers:
  - `ollama` (local, private) via HTTP
  - `openai` / `gemini` (API) via HTTP
- **Embeddings**: `ollama`, API, or local `transformers.js` (optional dependency).

Enrichment runs **reactively**: the daemon subscribes (LIVE) to newly ingested sessions,
computes summary + embeddings, and writes them back.

---

## 7. Coordination via SurrealDB LIVE queries

No external broker. The DB is the bus:

1. Ingestion writes a `session` (status `raw`).
2. Daemon runs `LIVE SELECT * FROM session WHERE status = 'raw'`.
3. On notification → enrich (summary + embeddings) → `UPDATE ... status = 'ready'`.
4. `memory-mcp` only reads `status = 'ready'` sessions.

This mirrors TrustGraph's Pulsar bus with zero extra infrastructure. If durability/retry
becomes critical, swap in NATS/Redis behind the same producer/consumer seam.

---

## 8. Serving to AI tools

### MCP tools (`memory-mcp`)
| Tool | Purpose |
|------|---------|
| `memory_search(query, project?, kind?, limit?)` | hybrid FT+vector search (compact index) |
| `memory_timeline(anchor?, project?, before?, after?)` | context around a session/event |
| `memory_get(id)` | full detail for a node |
| `graph_query(from, edge, depth?)` | multi-hop traversal (e.g. sessions→file→decisions) |
| `session_resume(project)` | briefing: goal, recent files, open threads, next step |
| `remember(text, refs?)` | write an explicit `decision`/memory |

### Reliable cold-start
Because `sessionStart` hook injection is unreliable, ship an **always-apply rule** that
instructs the agent to call `session_resume` at the start of a chat. The rule is the
trigger; MCP is the data.

### Standalone use
- **CLI**: `memory search`, `memory resume`, `memory backfill`, `memory stats`.
- **REST/UI** (optional, phase 5): a local web search over the same graph.

---

## 9. Privacy & safety

- **Local-only** by default; no data leaves the machine unless an API provider is chosen.
- **Secret scrubbing** on ingest (transcripts/commands can contain tokens) — regex +
  entropy filters before persistence.
- **Project scoping** to prevent cross-project bleed; global search is explicit.
- SurrealDB data dir under `~/.local/share/memorcy/`.

---

## 10. Build phases (each independently verifiable)

1. **Backfill (Cursor transcripts)** → nodes/edges in SurrealDB.
   *Verify:* `graph_query` returns sessions-by-file.
2. **Live `stop`-hook capture** → new sessions appear without rescan.
   *Verify:* start a chat, see the session land.
3. **MCP `session_resume` + always-apply rule** → fresh chat summarizes recent work.
   *Verify:* new chat gives a correct briefing.
4. **Hybrid search (embeddings + FT)** → "find where we discussed X".
   *Verify:* semantic query returns the right session.
5. **Optional:** LLM summaries, home-dir/git correlation, deep `chats` (1.1 GB) backfill,
   REST/UI, more adapters (Claude/Copilot).

---

## 11. Repository layout

```
memorcy/
├─ ARCHITECTURE.md          # this file
├─ README.md
├─ package.json
├─ tsconfig.json
├─ .env.example
└─ src/
   ├─ core/                 # types, config, db, schema, queries, log
   ├─ adapters/             # SourceAdapter + cursor/claude/...
   ├─ enrichment/           # EnrichmentProvider + deterministic/llm
   ├─ ingest/               # backfill + live
   ├─ daemon/               # long-running ingest+enrich process
   ├─ mcp/                  # stdio MCP server
   └─ cli/                  # standalone CLI
```
