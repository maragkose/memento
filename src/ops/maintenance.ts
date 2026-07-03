/**
 * Maintenance & curation ops used by the CLI:
 *  - doctor : health snapshot (counts, stale docs, config)
 *  - prune  : drop documents whose source file no longer exists (+ their edges)
 *  - backup : dump the whole namespace via SurrealDB export
 *  - restore: import a previous dump
 *  - resolveTopHit : map a search query -> a single record (for pin/tag)
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Surreal } from "surrealdb";
import type { Config } from "../core/config.ts";
import { search } from "../core/queries.ts";
import { ridFrom } from "../core/graph.ts";

const NODE_TABLES = ["project", "repo", "file", "document", "command", "prompt", "decision", "person", "tool_call", "session"];

export interface DoctorReport {
  db: { url: string; ns: string; db: string };
  counts: Record<string, number>;
  staleDocuments: number;
  config: { notesRoots: string[]; enrich: string; embed: string; mdc: string };
}

async function count(db: Surreal, table: string): Promise<number> {
  try {
    const [rows] = await db.query<[Array<{ c: number }>]>(`SELECT count() AS c FROM ${table} GROUP ALL;`);
    return rows?.[0]?.c ?? 0;
  } catch {
    return 0;
  }
}

export async function doctor(db: Surreal, cfg: Config): Promise<DoctorReport> {
  const counts: Record<string, number> = {};
  for (const t of NODE_TABLES) counts[t] = await count(db, t);

  const [docs] = await db.query<[Array<{ path: string }>]>(`SELECT path FROM document;`);
  let stale = 0;
  for (const d of docs ?? []) if (d.path && !fs.existsSync(d.path)) stale++;

  return {
    db: { url: cfg.db.url, ns: cfg.db.namespace, db: cfg.db.database },
    counts,
    staleDocuments: stale,
    config: {
      notesRoots: cfg.notes.roots,
      enrich: cfg.enrich,
      embed: cfg.embed,
      mdc: cfg.mdc.enabled ? cfg.mdc.path : "(disabled)",
    },
  };
}

/** Remove documents whose file vanished on disk, plus their `about` edges. */
export async function prune(db: Surreal): Promise<{ removedDocuments: number }> {
  const [docs] = await db.query<[Array<{ path: string }>]>(`SELECT path FROM document;`);
  const gone = (docs ?? []).map((d) => d.path).filter((p) => p && !fs.existsSync(p));
  if (gone.length === 0) return { removedDocuments: 0 };
  // `about` may not exist yet (notes-only namespaces have no edges); ignore that.
  await db.query(`DELETE about WHERE in.path IN $gone;`, { gone }).catch(() => {});
  await db.query(`DELETE document WHERE path IN $gone;`, { gone });
  return { removedDocuments: gone.length };
}

/** Full namespace dump via SurrealDB's native export (SurrealQL text). */
export async function backup(db: Surreal, cfg: Config, file?: string): Promise<string> {
  const dir = path.join(cfg.dataDir, "backups");
  await fsp.mkdir(dir, { recursive: true });
  const target = file ?? path.join(dir, `memento-${new Date().toISOString().replace(/[:.]/g, "-")}.surql`);
  const anyDb = db as unknown as { export?: () => Promise<string> };
  if (typeof anyDb.export !== "function") throw new Error("this SurrealDB SDK build has no export(); upgrade the driver");
  const dump = await anyDb.export();
  await fsp.writeFile(target, dump, "utf8");
  return target;
}

export async function restore(db: Surreal, file: string): Promise<void> {
  const anyDb = db as unknown as { import?: (data: string) => Promise<unknown> };
  if (typeof anyDb.import !== "function") throw new Error("this SurrealDB SDK build has no import(); upgrade the driver");
  const data = await fsp.readFile(file, "utf8");
  await anyDb.import(data);
}

/** Resolve a free-text query to the single best session/document record id. */
export async function resolveTopHit(
  db: Surreal,
  query: string,
): Promise<{ rid: string; id: string; type: string; title: string } | null> {
  const hits = (await search(db, query, { limit: 5 })).filter((h) => h.type === "session" || h.type === "document");
  const top = hits[0];
  if (!top) return null;
  return { rid: ridFrom(top.type, top.id), id: top.id, type: top.type, title: top.title };
}
