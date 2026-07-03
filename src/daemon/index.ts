/**
 * memory-daemon: long-running process.
 *  - applies schema
 *  - starts the LIVE enrichment subscriber
 *  - starts live source capture (watch) for each adapter that supports it
 *
 * Run: npm run dev:daemon   (or `npm run daemon` after build)
 */
import { loadConfig } from "../core/config.ts";
import { connect } from "../core/db.ts";
import { applySchema } from "../core/schema.ts";
import { buildAdapters } from "../adapters/registry.ts";
import { buildEnrichment } from "../enrichment/registry.ts";
import { startEnrichmentSubscriber } from "../ingest/live.ts";
import { syncChanged } from "../ingest/backfill.ts";
import { syncDocuments } from "../ingest/notes.ts";
import { syncCommits } from "../ingest/git.ts";
import { NotesSource } from "../adapters/notes.ts";
import { GitSource } from "../adapters/git.ts";
import { exportMdc } from "../export/mdc.ts";
import { log } from "../core/log.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = await connect(cfg);
  await applySchema(db, { withVectors: cfg.embed !== "none" });

  const provider = buildEnrichment(cfg);
  const stopEnrich = await startEnrichmentSubscriber(db, cfg, provider);

  const exportSafe = () => exportMdc(db, cfg).catch((e) => log.warn("mdc export failed", e));

  // Incremental ingest: poll sources for new/changed sessions, enrich inline,
  // and refresh the digest whenever something changed. No manual backfill.
  const adapters = [...buildAdapters(cfg).values()];
  const notes = cfg.notes.enabled ? new NotesSource(cfg) : undefined;
  const gitSrc = cfg.git.enabled ? new GitSource(cfg) : undefined;
  let syncing = false;
  const syncOnce = async () => {
    if (syncing) return; // skip overlapping ticks
    syncing = true;
    try {
      let updated = 0;
      for (const adapter of adapters) {
        const s = await syncChanged(db, cfg, adapter, provider).catch((e) => {
          log.warn(`sync failed for ${adapter.id}`, e);
          return { updated: 0, scanned: 0, events: 0 };
        });
        updated += s.updated;
      }
      // Notes/documents (not part of the digest; searchable via CLI/MCP/web).
      if (notes) {
        await syncDocuments(db, cfg, notes).catch((e) => log.warn("notes sync failed", e));
      }
      // Git commits (searchable; linked to files/projects).
      if (gitSrc) {
        await syncCommits(db, cfg, gitSrc).catch((e) => log.warn("git sync failed", e));
      }
      if (updated > 0 && cfg.mdc.enabled) await exportSafe();
    } finally {
      syncing = false;
    }
  };

  let syncTimer: NodeJS.Timeout | undefined;
  if (cfg.ingest.watch) {
    await syncOnce();
    syncTimer = setInterval(() => void syncOnce(), cfg.ingest.intervalMs);
    syncTimer.unref?.();
  }

  // Rules-file injection (no-MCP fallback): render digest now + on an interval
  // (a safety net in case nothing changed but the file was removed/edited).
  let mdcTimer: NodeJS.Timeout | undefined;
  if (cfg.mdc.enabled) {
    await exportSafe();
    mdcTimer = setInterval(() => void exportSafe(), cfg.mdc.intervalMs);
    mdcTimer.unref?.();
  }

  log.info("memory-daemon running. Ctrl-C to stop.");

  const shutdown = async () => {
    log.info("shutting down...");
    if (syncTimer) clearInterval(syncTimer);
    if (mdcTimer) clearInterval(mdcTimer);
    await stopEnrich();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("daemon fatal", err);
  process.exit(1);
});
