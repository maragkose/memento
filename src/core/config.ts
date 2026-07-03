/**
 * Centralized configuration, resolved from environment with sensible local defaults.
 */
import os from "node:os";
import path from "node:path";

function env(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

const home = os.homedir();

export type EnrichMode = "deterministic" | "ollama" | "openai" | "gemini";
export type EmbedMode = "none" | "ollama" | "openai" | "transformers";

export interface Config {
  db: {
    url: string;
    user: string;
    pass: string;
    namespace: string;
    database: string;
  };
  enrich: EnrichMode;
  embed: EmbedMode;
  ollama: { url: string; model: string; embedModel: string };
  sources: {
    cursorHome: string; // ~/.cursor
    cursorConfig: string; // ~/.config/Cursor
    claudeHome: string; // ~/.claude
    homeDir: string;
  };
  /** Rules-file injection: no-MCP fallback that any session reads automatically. */
  mdc: {
    enabled: boolean;
    path: string; // target .mdc (always-applied)
    limit: number; // max sessions in the digest
    intervalMs: number; // daemon re-export cadence
  };
  /** Daemon-driven incremental ingest: keeps memory fresh with no manual backfill. */
  ingest: {
    watch: boolean; // poll sources for new/changed sessions
    intervalMs: number; // poll cadence
  };
  /** Notes/files indexing: standalone documents (not AI sessions). */
  notes: {
    enabled: boolean;
    roots: string[]; // dirs to walk; set to $HOME to index everything (with ignores)
    exts: string[]; // lowercase extensions incl. leading dot
    maxBytes: number; // skip files larger than this
    ignoreDirs: string[]; // directory names to skip anywhere in the tree
  };
  /** Git indexing: commits/branches from local repos, linked to files/projects. */
  git: {
    enabled: boolean;
    roots: string[]; // explicit repo dirs; empty => auto-discover under $HOME
    scanDepth: number; // auto-discovery depth below $HOME (0 disables the scan)
    lookbackDays: number; // only ingest commits newer than this
    maxCommits: number; // hard cap per repo (newest first)
  };
  dataDir: string;
}

/** Split a ":"-separated path list, trimming blanks. */
function pathList(value: string): string[] {
  return value.split(":").map((s) => s.trim()).filter(Boolean);
}
function csv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    db: {
      url: env("MEM_DB_URL", "ws://127.0.0.1:8000/rpc"),
      user: env("MEM_DB_USER", "root"),
      pass: env("MEM_DB_PASS", "root"),
      namespace: env("MEM_DB_NS", "memento"),
      database: env("MEM_DB_DB", "memory"),
    },
    enrich: env("MEM_ENRICH", "deterministic") as EnrichMode,
    embed: env("MEM_EMBED", "none") as EmbedMode,
    ollama: {
      url: env("MEM_OLLAMA_URL", "http://127.0.0.1:11434"),
      model: env("MEM_OLLAMA_MODEL", "llama3.1"),
      embedModel: env("MEM_OLLAMA_EMBED_MODEL", "nomic-embed-text"),
    },
    sources: {
      cursorHome: env("MEM_CURSOR_HOME", path.join(home, ".cursor")),
      cursorConfig: path.join(home, ".config", "Cursor"),
      claudeHome: path.join(home, ".claude"),
      homeDir: home,
    },
    mdc: {
      enabled: env("MEM_MDC", "true") !== "false",
      path: env("MEM_MDC_PATH", path.join(home, ".cursor", "rules", "memento.mdc")),
      limit: Number(env("MEM_MDC_LIMIT", "12")),
      intervalMs: Number(env("MEM_MDC_INTERVAL_MS", "300000")), // 5 min
    },
    ingest: {
      watch: env("MEM_INGEST_WATCH", "true") !== "false",
      intervalMs: Number(env("MEM_INGEST_INTERVAL_MS", "60000")), // 1 min
    },
    notes: {
      enabled: env("MEM_NOTES", "true") !== "false",
      roots: pathList(env("MEM_NOTES_ROOTS", [path.join(home, "notes"), path.join(home, "Documents")].join(":"))),
      exts: csv(env("MEM_NOTES_EXTS", ".md,.markdown,.txt,.org,.rst,.pdf")).map((e) =>
        (e.startsWith(".") ? e : `.${e}`).toLowerCase(),
      ),
      maxBytes: Number(env("MEM_NOTES_MAX_BYTES", "1000000")), // 1 MB
      ignoreDirs: csv(
        env(
          "MEM_NOTES_IGNORE",
          "node_modules,.git,.cache,.local,.config,.ssh,.gnupg,.npm,.cargo,.rustup,.venv,venv,__pycache__,dist,build,.next,target,.Trash,snap",
        ),
      ),
    },
    git: {
      enabled: env("MEM_GIT", "true") !== "false",
      roots: pathList(env("MEM_GIT_ROOTS", "")),
      scanDepth: Number(env("MEM_GIT_SCAN_DEPTH", "2")),
      lookbackDays: Number(env("MEM_GIT_LOOKBACK_DAYS", "180")),
      maxCommits: Number(env("MEM_GIT_MAX_COMMITS", "500")),
    },
    dataDir: path.join(home, ".local", "share", "memento"),
  };
}
