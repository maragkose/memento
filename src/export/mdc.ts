/**
 * MdcExporter — the no-MCP fallback.
 *
 * Renders recent session memory into an always-applied Cursor rule file
 * (`.mdc`). Any chat in any project then reads it automatically at start — no
 * MCP server, no tool call, no admin permission required. This is the same
 * mechanism cursor-mem / sessionmark use.
 *
 * The file is marked auto-generated; it is rewritten atomically each cycle.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { Config } from "../core/config.ts";
import { recentSessions, type DigestSession } from "../core/queries.ts";
import { log } from "../core/log.ts";

const MAX_SUMMARY = 400;
const MAX_FILES = 8;
const MAX_DECISIONS = 4;
const MAX_DECISION = 160;

function dedupeDecisions(
  decisions: Array<{ text: string; kind?: string }>,
): Array<{ text: string; kind?: string }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; kind?: string }> = [];
  for (const d of decisions) {
    if (!d?.text) continue;
    const key = d.text.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export async function exportMdc(db: Surreal, cfg: Config): Promise<string> {
  const sessions = await recentSessions(db, cfg.mdc.limit);
  const body = render(sessions);
  await writeAtomic(cfg.mdc.path, body);
  log.info(`mdc digest written (${sessions.length} sessions) -> ${cfg.mdc.path}`);
  return cfg.mdc.path;
}

function render(sessions: DigestSession[]): string {
  const generated = new Date().toISOString();
  const header = [
    "---",
    "description: Auto-generated context memory of recent AI coding sessions. Managed by memento — do not edit by hand.",
    "alwaysApply: true",
    "---",
    "",
    "# Context Memory",
    "",
    `_Auto-generated ${generated}. Recent work across your projects, so this session knows the history._`,
    "",
  ];

  if (sessions.length === 0) {
    return [...header, "_No enriched sessions yet. Run a backfill and the daemon to populate this._", ""].join("\n");
  }

  const byProject = groupByProject(sessions);
  const lines: string[] = [...header];
  for (const [project, items] of byProject) {
    lines.push(`## ${project}`, "");
    for (const s of items) {
      const when = toDay(s.started_at);
      const title = (s.title ?? "session").replace(/\s+/g, " ").trim();
      const pin = s.pinned ? "★ " : "";
      lines.push(`- ${pin}**${title}**${when ? ` (${when})` : ""}`);
      const summary = clip((s.summary ?? "").replace(/\n+/g, " "), MAX_SUMMARY);
      if (summary && !sameText(summary, title)) lines.push(`  - ${summary}`);
      const files = normalizeFiles(s.files ?? []).slice(0, MAX_FILES);
      if (files.length) lines.push(`  - files: ${files.join(", ")}`);
      for (const d of dedupeDecisions(s.decisions ?? []).slice(0, MAX_DECISIONS)) {
        const tag = d.kind === "gotcha" ? "⚠ " : d.kind === "todo" ? "☐ " : "→ ";
        lines.push(`  - ${tag}${clip(d.text.replace(/\n+/g, " "), MAX_DECISION)}`);
      }
    }
    lines.push("");
  }
  lines.push("_To search deeper history, use the memento CLI or MCP tools._", "");
  return lines.join("\n");
}

function groupByProject(sessions: DigestSession[]): Map<string, DigestSession[]> {
  const map = new Map<string, DigestSession[]>();
  for (const s of sessions) {
    const key = s.project ?? "(unscoped)";
    const arr = map.get(key) ?? [];
    arr.push(s);
    map.set(key, arr);
  }
  return map;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** True when the summary adds nothing over the (possibly truncated) title. */
function sameText(summary: string, title: string): boolean {
  return norm(summary) === norm(title);
}

/**
 * Sources often record both a bare basename and its full path for the same
 * file (e.g. "SKILL.md" and "/home/.../SKILL.md"). Keep the informative path
 * and drop the redundant bare basename; distinct paths sharing a basename
 * (src/x.py vs scripts/x.py) are preserved.
 */
function normalizeFiles(files: string[]): string[] {
  const uniq = [...new Set(files.filter(Boolean).map((f) => f.trim()))].sort(
    (a, b) => b.length - a.length, // paths (longer) before bare basenames
  );
  const covered = new Set<string>();
  const out: string[] = [];
  for (const f of uniq) {
    const base = f.split("/").pop() ?? f;
    if (f === base && covered.has(base)) continue;
    covered.add(base);
    out.push(f);
  }
  return out;
}

/** SurrealDB returns datetime as a JS Date; normalize to YYYY-MM-DD. */
function toDay(value: unknown): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

async function writeAtomic(target: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, target);
}

/** Remove the generated file (e.g. on uninstall). */
export async function removeMdc(cfg: Config): Promise<void> {
  if (fs.existsSync(cfg.mdc.path)) await fsp.rm(cfg.mdc.path);
}
