/**
 * Standalone CLI for the memory bank (works without any AI tool).
 *
 * Usage:
 *   memento init
 *   memento backfill --tool cursor
 *   memento search "surrealdb schema" [--project <slug>]
 *   memento resume --project <slug>
 *   memento export
 *   memento stats
 */
import { loadConfig } from "../core/config.ts";
import { getDb, closeDb } from "../core/db.ts";
import { applySchema } from "../core/schema.ts";
import { getAdapter } from "../adapters/registry.ts";
import { backfill } from "../ingest/backfill.ts";
import { syncDocuments } from "../ingest/notes.ts";
import { syncCommits } from "../ingest/git.ts";
import { buildEnrichment, buildEmbedder, buildChat } from "../enrichment/registry.ts";
import { hybridSearch, resume } from "../core/queries.ts";
import { retrieve, ask as ragAsk, citation } from "../rag/index.ts";
import { setPinned, addTags } from "../core/graph.ts";
import { doctor, prune, backup, restore, resolveTopHit } from "../ops/maintenance.ts";
import { relatedData } from "../serve/data.ts";
import { exportMdc } from "../export/mdc.ts";
import { log } from "../core/log.ts";

interface Args {
  _: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

async function main(): Promise<void> {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  const cfg = loadConfig();

  switch (cmd) {
    case "init": {
      const db = await getDb(cfg);
      await applySchema(db, { withVectors: cfg.embed !== "none" });
      console.log("schema initialized");
      break;
    }
    case "backfill": {
      const toolId = flags.tool ?? "cursor";
      const adapter = getAdapter(cfg, toolId);
      if (!adapter) throw new Error(`unknown adapter: ${toolId}`);
      const db = await getDb(cfg);
      await applySchema(db, { withVectors: cfg.embed !== "none" });
      const provider = flags["no-enrich"] ? undefined : buildEnrichment(cfg);
      const stats = await backfill(db, cfg, adapter, provider);
      console.log(`backfill: ${stats.sessions} sessions, ${stats.events} events`);
      break;
    }
    case "notes": {
      const db = await getDb(cfg);
      await applySchema(db, { withVectors: cfg.embed !== "none" });
      if (!cfg.notes.enabled) {
        console.log("notes indexing disabled (MEM_NOTES=false)");
        break;
      }
      const stats = await syncDocuments(db, cfg);
      console.log(`notes: ${stats.updated}/${stats.scanned} documents indexed (roots: ${cfg.notes.roots.join(", ")})`);
      break;
    }
    case "git": {
      const db = await getDb(cfg);
      await applySchema(db, { withVectors: cfg.embed !== "none" });
      if (!cfg.git.enabled) {
        console.log("git indexing disabled (MEM_GIT=false)");
        break;
      }
      const stats = await syncCommits(db, cfg);
      console.log(`git: ${stats.commits} commit(s) across ${stats.repos} repo(s)`);
      break;
    }
    case "search": {
      const query = _.slice(1).join(" ") || flags.query || "";
      const db = await getDb(cfg);
      const hits = await hybridSearch(db, query, { project: flags.project, limit: Number(flags.limit ?? 20) }, buildEmbedder(cfg));
      console.log(JSON.stringify(hits, null, 2));
      break;
    }
    case "resume": {
      if (!flags.project) throw new Error("--project required");
      const db = await getDb(cfg);
      const briefing = await resume(db, flags.project);
      console.log(JSON.stringify(briefing, null, 2));
      break;
    }
    case "recall": {
      const query = _.slice(1).join(" ") || flags.query || "";
      if (!query) throw new Error("usage: memento recall <query>");
      const db = await getDb(cfg);
      const sources = await retrieve(
        db,
        query,
        { project: flags.project, limit: Number(flags.limit ?? 6) },
        buildEmbedder(cfg),
      );
      if (sources.length === 0) { console.log("no matches"); break; }
      for (const s of sources) {
        console.log(citation(s));
        console.log(`    ${s.snippet}\n`);
      }
      break;
    }
    case "ask": {
      const query = _.slice(1).join(" ") || flags.query || "";
      if (!query) throw new Error("usage: memento ask <question>");
      const db = await getDb(cfg);
      const embed = buildEmbedder(cfg);
      const chat = buildChat(cfg);
      if (!chat) {
        // No LLM configured: degrade to recall (retrieval with citations).
        const sources = await retrieve(db, query, { project: flags.project, limit: Number(flags.limit ?? 6) }, embed);
        console.log("(no LLM configured — set MEM_ENRICH=ollama to get answers; showing recalled context)\n");
        for (const s of sources) { console.log(citation(s)); console.log(`    ${s.snippet}\n`); }
        break;
      }
      const { answer, sources } = await ragAsk(db, query, chat, { project: flags.project, limit: Number(flags.limit ?? 6) }, embed);
      console.log(answer + "\n");
      console.log("Sources:");
      for (const s of sources) console.log(citation(s));
      break;
    }
    case "export": {
      const db = await getDb(cfg);
      const target = await exportMdc(db, cfg);
      console.log(`digest written to ${target}`);
      break;
    }
    case "stats": {
      const db = await getDb(cfg);
      const [rows] = await db.query(
        `SELECT count() AS n, meta::tb(id) AS tb FROM session, prompt, decision, file, document, commit GROUP BY tb;`,
      );
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    case "pin":
    case "unpin": {
      const query = _.slice(1).join(" ") || flags.query || "";
      if (!query) throw new Error(`usage: memento ${cmd} <query>`);
      const db = await getDb(cfg);
      const hit = await resolveTopHit(db, query);
      if (!hit) { console.log("no match"); break; }
      await setPinned(db, hit.rid, cmd === "pin");
      console.log(`${cmd === "pin" ? "pinned" : "unpinned"} ${hit.type}: ${hit.title}`);
      break;
    }
    case "tag": {
      const tag = _[1];
      const query = _.slice(2).join(" ") || flags.query || "";
      if (!tag || !query) throw new Error("usage: memento tag <tag> <query>");
      const db = await getDb(cfg);
      const hit = await resolveTopHit(db, query);
      if (!hit) { console.log("no match"); break; }
      await addTags(db, hit.rid, [tag]);
      console.log(`tagged ${hit.type} '#${tag}': ${hit.title}`);
      break;
    }
    case "pins": {
      const db = await getDb(cfg);
      const [rows] = await db.query(
        `SELECT meta::tb(id) AS type, (title ?? summary ?? path ?? external_id) AS title, project, tags
         FROM session, document WHERE pinned = true;`,
      );
      console.log(JSON.stringify(rows, null, 2));
      break;
    }
    case "related": {
      const query = _.slice(1).join(" ") || flags.query || "";
      if (!query) throw new Error("usage: memento related <query>");
      const db = await getDb(cfg);
      const hit = await resolveTopHit(db, query);
      if (!hit) { console.log("no match"); break; }
      if (hit.type !== "session") { console.log(`top match is a ${hit.type}; related is session-only for now`); break; }
      const r = await relatedData(db, hit.id);
      console.log(JSON.stringify({ for: hit.title, ...r }, null, 2));
      break;
    }
    case "doctor": {
      const db = await getDb(cfg);
      console.log(JSON.stringify(await doctor(db, cfg), null, 2));
      break;
    }
    case "prune": {
      const db = await getDb(cfg);
      const r = await prune(db);
      console.log(`pruned ${r.removedDocuments} missing document(s)`);
      break;
    }
    case "backup": {
      const db = await getDb(cfg);
      const target = await backup(db, cfg, flags.out);
      console.log(`backup written to ${target}`);
      break;
    }
    case "restore": {
      const file = flags.file ?? _[1];
      if (!file) throw new Error("usage: memento restore --file <dump.surql>");
      const db = await getDb(cfg);
      await restore(db, file);
      console.log(`restored from ${file}`);
      break;
    }
    default:
      console.log(
        [
          "memento <command>",
          "  init                      initialize schema",
          "  backfill --tool cursor    ingest existing sessions",
          "  notes                     index notes/files from configured roots",
          "  git                       index commits from local git repos",
          "  search <query>            search the memory bank",
          "  recall <query>            retrieve cited context (no LLM)",
          "  ask <question>            answer from memory with citations (needs MEM_ENRICH=ollama)",
          "  resume --project <slug>   cold-start briefing",
          "  export                    write the always-apply .mdc digest",
          "  stats                     node counts",
          "  pin/unpin <query>         (un)pin the best-matching item",
          "  tag <tag> <query>         tag the best-matching item",
          "  pins                      list pinned items",
          "  related <query>           sessions/files/notes related to the best match",
          "  doctor                    health snapshot",
          "  prune                     drop docs whose file is gone",
          "  backup [--out <file>]     export the namespace (SurrealQL)",
          "  restore --file <dump>     import a backup",
        ].join("\n"),
      );
  }

  await closeDb();
}

main().catch((err) => {
  log.error("cli fatal", err);
  process.exit(1);
});
