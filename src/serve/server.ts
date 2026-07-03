/**
 * Read-only local web server for the visualization UI.
 *
 *   GET /api/stats            counts, per-project, per-day, top files
 *   GET /api/graph[?project=] nodes + edges (sessions/files/projects)
 *   GET /api/timeline         sessions for the timeline swimlanes
 *   GET /api/decisions[?project=&kind=]  extracted decisions/gotchas/TODOs
 *   GET /api/search?q=[&project=]
 *   GET /api/session/:id      drill-down (summary, prompts, files, decisions)
 *   GET /api/related/:id      related sessions/files/notes (shared-file co-occurrence)
 *   GET /*                    static SPA from web/dist
 *
 * Binds to loopback only. No writes, no auth (local-first, single user).
 *
 * Run: npm run dev:serve   (or `npm run serve` after build), or ./run.sh serve
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.ts";
import { getDb } from "../core/db.ts";
import { buildEmbedder } from "../enrichment/registry.ts";
import { log } from "../core/log.ts";
import { graphData, timelineData, statsData, sessionDetail, searchData, decisionsData, relatedData } from "./data.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..", "..", "web", "dist");
const PORT = Number(process.env.MEM_SERVE_PORT ?? "7077");
const HOST = process.env.MEM_SERVE_HOST ?? "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function serveStatic(res: http.ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.resolve(WEB_DIR, rel);
  // Prevent path traversal outside WEB_DIR.
  if (!target.startsWith(WEB_DIR)) return void notFound(res);
  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback: serve index.html for unknown non-asset routes.
    if (!path.extname(target) && fs.existsSync(path.join(WEB_DIR, "index.html"))) {
      const html = await fsp.readFile(path.join(WEB_DIR, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(html);
    } else notFound(res);
  }
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = await getDb(cfg);
  const embed = buildEmbedder(cfg);
  const hasWeb = fs.existsSync(path.join(WEB_DIR, "index.html"));
  if (!hasWeb) log.warn(`web/dist not built yet (${WEB_DIR}); API is up, UI 404s. Run: (cd web && npm install && npm run build)`);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
      const p = url.pathname;
      if (p.startsWith("/api/")) {
        if (p === "/api/stats") return sendJson(res, 200, await statsData(db));
        if (p === "/api/graph") return sendJson(res, 200, await graphData(db, { project: url.searchParams.get("project") ?? undefined }));
        if (p === "/api/timeline") return sendJson(res, 200, await timelineData(db));
        if (p === "/api/decisions") return sendJson(res, 200, await decisionsData(db, { project: url.searchParams.get("project") ?? undefined, kind: url.searchParams.get("kind") ?? undefined }));
        if (p === "/api/search") return sendJson(res, 200, await searchData(db, url.searchParams.get("q") ?? "", url.searchParams.get("project") ?? undefined, embed));
        if (p.startsWith("/api/session/")) {
          const id = decodeURIComponent(p.slice("/api/session/".length));
          const detail = await sessionDetail(db, id);
          return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "not found" });
        }
        if (p.startsWith("/api/related/")) {
          const id = decodeURIComponent(p.slice("/api/related/".length));
          return sendJson(res, 200, await relatedData(db, id));
        }
        return sendJson(res, 404, { error: "unknown endpoint" });
      }
      await serveStatic(res, p);
    } catch (err) {
      log.error("request failed", err);
      sendJson(res, 500, { error: String(err) });
    }
  });

  server.listen(PORT, HOST, () => {
    log.info(`memento UI on http://${HOST}:${PORT}  (api: /api/stats)`);
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("serve fatal", err);
  process.exit(1);
});
