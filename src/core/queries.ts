/**
 * Retrieval queries: the read surface used by the MCP server and CLI.
 * Hybrid GraphRAG = full-text (BM25) + optional vector, then graph expansion.
 */
import type { Surreal } from "surrealdb";
import type { SearchHit } from "./types.ts";

export interface DigestSession {
  project?: string;
  title?: string;
  summary?: string;
  started_at?: string;
  files?: string[];
  pinned?: boolean;
  decisions?: Array<{ text: string; kind?: string }>;
}

/**
 * Most recent enriched sessions, for the rules-file digest / cold-start briefing.
 * Pinned sessions surface first (and are always included) regardless of recency.
 */
export async function recentSessions(db: Surreal, limit = 12): Promise<DigestSession[]> {
  const [rows] = await db.query<[DigestSession[]]>(
    `SELECT
        project,
        title,
        summary,
        started_at,
        pinned,
        ->touched->file.path AS files,
        ->decided->decision.{ text, kind } AS decisions
     FROM session
     WHERE status = 'ready'
     ORDER BY pinned DESC, started_at DESC
     LIMIT $limit;`,
    { limit },
  );
  return rows ?? [];
}

export interface SearchOpts {
  project?: string;
  kind?: string; // table name filter
  tag?: string; // only sessions/documents carrying this tag
  limit?: number;
}

type Row = { id: string; type: string; title: string; ts?: string; project?: string; score: number; pinned?: boolean };

/** Tokenize a query into distinct significant terms (cap keeps match refs sane). */
function terms(query: string, max = 6): string[] {
  const seen = new Set<string>();
  for (const t of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (t.length > 1) seen.add(t);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * Full-text search. SurrealDB FT requires the matched field to be indexed on its
 * own table, so we query each table separately (session.summary, prompt.text)
 * and merge by BM25 score. Terms are OR-matched with summed relevance for recall.
 * Vector rerank is added in phase 4.
 */
export async function search(db: Surreal, query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 20;
  const project = opts.project ?? undefined;
  const tag = opts.tag ?? undefined;
  const ts = terms(query);
  if (ts.length === 0) return [];

  const params: Record<string, unknown> = { limit, project, tag };
  ts.forEach((t, i) => (params[`t${i}`] = t));
  const where = (field: string) => ts.map((_, i) => `${field} @${i}@ $t${i}`).join(" OR ");
  const score = ts.map((_, i) => `search::score(${i})`).join(" + ");
  const tagClause = "($tag = NONE OR $tag IN (tags ?? []))";

  const [sessions] = await db.query<[Row[]]>(
    `SELECT meta::id(id) AS id, 'session' AS type,
            (summary ?? title ?? external_id) AS title,
            started_at AS ts, project, pinned, (${score}) AS score
     FROM session
     WHERE (${where("summary")}) AND ($project = NONE OR project = $project) AND ${tagClause}
     ORDER BY score DESC LIMIT $limit;`,
    params,
  );

  // Prompts have no tags/pins; skip them when a tag filter is active.
  const prompts = tag
    ? []
    : (await db.query<[Row[]]>(
        `SELECT meta::id(id) AS id, 'prompt' AS type,
                text AS title, ts,
                (<-contains<-session.project)[0] AS project,
                (${score}) AS score
         FROM prompt
         WHERE ${where("text")}
         ORDER BY score DESC LIMIT $limit;`,
        params,
      ))[0];

  // Notes/documents: match content (refs 0..n-1) and title (refs n..2n-1),
  // summing both for a combined BM25 score.
  const nn = ts.length;
  const whereDoc =
    ts.map((_, i) => `content @${i}@ $t${i}`).join(" OR ") +
    " OR " +
    ts.map((_, i) => `title @${nn + i}@ $t${i}`).join(" OR ");
  const scoreDoc =
    ts.map((_, i) => `search::score(${i})`).join(" + ") +
    " + " +
    ts.map((_, i) => `search::score(${nn + i})`).join(" + ");
  const [documents] = await db.query<[Row[]]>(
    `SELECT meta::id(id) AS id, 'document' AS type,
            (title ?? path) AS title, source_mtime AS ts, project, pinned,
            (${scoreDoc}) AS score
     FROM document
     WHERE (${whereDoc}) AND ($project = NONE OR project = $project) AND ${tagClause}
     ORDER BY score DESC LIMIT $limit;`,
    params,
  );

  // Decisions/gotchas/TODOs (no tags/pins); skip under a tag filter.
  const decisions = tag
    ? []
    : (await db.query<[Row[]]>(
        `SELECT meta::id(id) AS id, 'decision' AS type,
                text AS title,
                (<-decided<-session.project)[0] AS project,
                (${score}) AS score
         FROM decision
         WHERE ${where("text")}
         ORDER BY score DESC LIMIT $limit;`,
        params,
      ))[0];

  // Git commits (no tags/pins); match commit messages. Skip under a tag filter.
  const commits = tag
    ? []
    : (await db.query<[Row[]]>(
        `SELECT meta::id(id) AS id, 'commit' AS type,
                message AS title, committed_at AS ts, project,
                (${score}) AS score
         FROM commit
         WHERE (${where("message")}) AND ($project = NONE OR project = $project)
         ORDER BY score DESC LIMIT $limit;`,
        params,
      ))[0];

  // Pinned items get a relevance boost so curated memory floats up.
  const boost = (r: Row) => (r.score ?? 0) * (r.pinned ? 1.3 : 1);
  return [...(sessions ?? []), ...(prompts ?? []), ...(documents ?? []), ...(decisions ?? []), ...(commits ?? [])]
    .filter((r) => (project ? r.project === project : true))
    .sort((a, b) => boost(b) - boost(a))
    .slice(0, limit);
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

/** KNN over one table's embedding field. Returns [] if no index/embeddings. */
async function vectorHits(
  db: Surreal,
  spec: { table: string; field: string; title: string; ts: string },
  qvec: number[],
  limit: number,
): Promise<Row[]> {
  // HNSW KNN operator requires an EF (search breadth) alongside K.
  const ef = Math.max(64, limit * 4);
  const [rows] = await db.query<[Row[]]>(
    `SELECT meta::id(id) AS id, '${spec.table}' AS type,
            (${spec.title}) AS title, ${spec.ts} AS ts, project, pinned,
            vector::distance::knn() AS dist
     FROM ${spec.table}
     WHERE ${spec.field} <|${limit},${ef}|> $vec
     ORDER BY dist;`,
    { vec: qvec },
  );
  return rows ?? [];
}

/**
 * Hybrid search: BM25 (via {@link search}) fused with vector KNN using Reciprocal
 * Rank Fusion. Degrades to pure BM25 when no embedder is supplied, embeddings are
 * absent, or vector indexes aren't defined (any vector error is swallowed).
 */
export async function hybridSearch(
  db: Surreal,
  query: string,
  opts: SearchOpts = {},
  embed?: Embedder,
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 20;
  const bm = await search(db, query, opts);
  // Tag filtering is BM25-only (vector rows carry no tags); skip fusion.
  if (!embed || opts.tag) return bm;

  let qvec: number[] | undefined;
  try {
    qvec = (await embed([query]))[0];
  } catch {
    return bm;
  }
  if (!qvec?.length) return bm;

  let vhits: Row[] = [];
  try {
    const [s, d] = await Promise.all([
      vectorHits(db, { table: "session", field: "summary_embedding", title: "summary ?? title ?? external_id", ts: "started_at" }, qvec, limit),
      vectorHits(db, { table: "document", field: "content_embedding", title: "title ?? path", ts: "source_mtime" }, qvec, limit),
    ]);
    vhits = [...s, ...d];
  } catch {
    return bm; // no vector index / embeddings yet
  }
  if (opts.project) vhits = vhits.filter((r) => r.project === opts.project);
  vhits.sort((a, b) => ((a as Row & { dist?: number }).dist ?? 1) - ((b as Row & { dist?: number }).dist ?? 1));

  // Reciprocal Rank Fusion over the two ranked lists.
  const K = 60;
  const fused = new Map<string, { hit: SearchHit; rrf: number }>();
  const add = (hit: SearchHit, rank: number) => {
    const key = `${hit.type}:${hit.id}`;
    const cur = fused.get(key);
    const inc = 1 / (K + rank);
    if (cur) cur.rrf += inc;
    else fused.set(key, { hit, rrf: inc });
  };
  bm.forEach((h, i) => add(h, i));
  vhits.forEach((h, i) => add(h as unknown as SearchHit, i));

  return [...fused.values()].sort((a, b) => b.rrf - a.rrf).map((v) => v.hit).slice(0, limit);
}

export async function getNode(db: Surreal, id: string): Promise<unknown> {
  const [rows] = await db.query(`SELECT * FROM $id;`, { id });
  return (rows as unknown[])?.[0] ?? null;
}

/**
 * Multi-hop traversal: from a node id along an edge to a given depth.
 * e.g. graphQuery(db, 'file:xyz', '<-touched<-session', 1)
 */
export async function graphQuery(
  db: Surreal,
  fromId: string,
  edgePath: string,
): Promise<unknown[]> {
  const [rows] = await db.query(`SELECT ${edgePath} AS related FROM $id;`, { id: fromId });
  return (rows as unknown[]) ?? [];
}

/**
 * Cold-start briefing for a project: most recent sessions, their files, and open
 * decisions. This is what an agent calls at the start of a chat.
 */
export async function resume(db: Surreal, project: string, limit = 5): Promise<unknown> {
  const [rows] = await db.query(
    `SELECT
        title,
        summary,
        started_at,
        ->touched->file.path AS files,
        ->decided->decision.{ text, kind } AS decisions,
        ->contains->prompt.text AS recent_prompts
     FROM session
     WHERE project = $project AND status = 'ready'
     ORDER BY started_at DESC
     LIMIT $limit;`,
    { project, limit },
  );
  return rows ?? [];
}
