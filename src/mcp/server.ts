/**
 * memory-mcp: stdio MCP server, spawned by each AI tool (Cursor/Claude/...).
 * Read-only surface over the graph. Never writes to stdout except MCP JSON-RPC
 * (all logging goes to stderr — see core/log.ts).
 *
 * Register in ~/.cursor/mcp.json:
 *   { "mcpServers": { "memorcy": { "command": "node",
 *     "args": ["/home/maragos/memorcy/dist/mcp/server.js"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "../core/config.ts";
import { connect } from "../core/db.ts";
import { hybridSearch, getNode, graphQuery, resume } from "../core/queries.ts";
import { buildEmbedder } from "../enrichment/registry.ts";
import { log } from "../core/log.ts";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = await connect(cfg);
  const embed = buildEmbedder(cfg);

  const server = new McpServer({ name: "memorcy", version: "0.1.0" });

  server.tool(
    "memory_search",
    "Hybrid full-text/semantic search over past sessions, prompts, and decisions.",
    { query: z.string(), project: z.string().optional(), tag: z.string().optional(), limit: z.number().optional() },
    async (args) => asText(await hybridSearch(db, args.query, args, embed)),
  );

  server.tool(
    "memory_get",
    "Fetch the full record for a node id (e.g. session:...).",
    { id: z.string() },
    async (args) => asText(await getNode(db, args.id)),
  );

  server.tool(
    "graph_query",
    "Traverse the graph from a node along an edge path, e.g. '<-touched<-session'.",
    { from: z.string(), edge: z.string() },
    async (args) => asText(await graphQuery(db, args.from, args.edge)),
  );

  server.tool(
    "session_resume",
    "Cold-start briefing for a project: recent sessions, files, and open threads.",
    { project: z.string(), limit: z.number().optional() },
    async (args) => asText(await resume(db, args.project, args.limit)),
  );

  await server.connect(new StdioServerTransport());
  log.info("memory-mcp connected over stdio");
}

main().catch((err) => {
  log.error("mcp fatal", err);
  process.exit(1);
});
