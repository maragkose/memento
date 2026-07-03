/**
 * SurrealDB connection wrapper. All processes (daemon, mcp, cli) connect to the
 * same local SurrealDB daemon over WebSocket; SurrealDB is the coordination point.
 */
import { Surreal } from "surrealdb";
import type { Config } from "./config.ts";
import { applySchema } from "./schema.ts";
import { log } from "./log.ts";

let singleton: Surreal | undefined;

/** Backtick-quote an identifier so ns/db names are safe to interpolate. */
function ident(name: string): string {
  return "`" + name.replace(/`/g, "") + "`";
}

export async function connect(cfg: Config): Promise<Surreal> {
  const db = new Surreal();
  // Connect + authenticate first WITHOUT selecting a namespace/db, so we can
  // create them idempotently (a fresh DB has neither, and USE would then fail).
  await db.connect(cfg.db.url, {
    authentication: { username: cfg.db.user, password: cfg.db.pass },
  });
  const ns = ident(cfg.db.namespace);
  const dbName = ident(cfg.db.database);
  await db.query(`DEFINE NAMESPACE IF NOT EXISTS ${ns}; USE NS ${ns}; DEFINE DATABASE IF NOT EXISTS ${dbName};`);
  await db.use({ namespace: cfg.db.namespace, database: cfg.db.database });
  // Ensure tables/indexes exist so every command works on a fresh DB (idempotent).
  await applySchema(db, { withVectors: cfg.db.namespace !== "" && cfg.embed !== "none" });
  log.info(`connected to SurrealDB at ${cfg.db.url} (${cfg.db.namespace}/${cfg.db.database})`);
  return db;
}

export async function getDb(cfg: Config): Promise<Surreal> {
  if (!singleton) singleton = await connect(cfg);
  return singleton;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = undefined;
  }
}
