/**
 * Read models for the visualization UI. Kept deliberately query-light: we pull a
 * couple of base result sets and shape graph / timeline / stats in JS, which is
 * simpler and more portable than leaning on SurrealDB GROUP BY quirks.
 */
import type { Surreal } from "surrealdb";
import { hybridSearch, type Embedder } from "../core/queries.ts";
import type { SearchHit } from "../core/types.ts";

export interface SessionLite {
  id: string; // meta id, e.g. "cursor::<uuid>"
  title?: string;
  project?: string;
  started_at?: string;
  status?: string;
  files: number;
}

interface TouchRow {
  s: string;
  path: string | null;
}

async function fetchSessions(db: Surreal): Promise<SessionLite[]> {
  const [rows] = await db.query<[Array<Omit<SessionLite, "files">>]>(
    `SELECT meta::id(id) AS id, title, project, started_at, status FROM session ORDER BY started_at DESC;`,
  );
  return (rows ?? []).map((r) => ({ ...r, files: 0 }));
}

async function fetchTouched(db: Surreal): Promise<TouchRow[]> {
  const [rows] = await db.query<[TouchRow[]]>(
    `SELECT meta::id(in) AS s, out.path AS path FROM touched;`,
  );
  return (rows ?? []).filter((r) => r.path);
}

export interface GraphNode {
  id: string;
  type: "session" | "file" | "project";
  label: string;
  project?: string;
  ts?: string;
  status?: string;
  val: number; // node size weight (degree-based)
}
export interface GraphLink {
  source: string;
  target: string;
  kind: "touched" | "about";
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Sessions + files + projects with touched/about edges. Prompts are excluded
 *  (too many); they surface in the per-session drill-down. */
export async function graphData(db: Surreal, opts: { project?: string } = {}): Promise<GraphData> {
  const [sessions, touched] = await Promise.all([fetchSessions(db), fetchTouched(db)]);
  const keep = opts.project ? sessions.filter((s) => s.project === opts.project) : sessions;
  const sessionIds = new Set(keep.map((s) => s.id));

  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const fileDegree = new Map<string, number>();
  const sessionDegree = new Map<string, number>();

  for (const s of keep) {
    if (s.project) {
      const pid = `project:${s.project}`;
      if (!nodes.has(pid)) nodes.set(pid, { id: pid, type: "project", label: s.project, project: s.project, val: 4 });
      links.push({ source: `session:${s.id}`, target: pid, kind: "about" });
    }
  }

  for (const t of touched) {
    if (!sessionIds.has(t.s) || !t.path) continue;
    const fid = `file:${t.path}`;
    links.push({ source: `session:${t.s}`, target: fid, kind: "touched" });
    fileDegree.set(t.path, (fileDegree.get(t.path) ?? 0) + 1);
    sessionDegree.set(t.s, (sessionDegree.get(t.s) ?? 0) + 1);
    if (!nodes.has(fid)) {
      nodes.set(fid, { id: fid, type: "file", label: shortPath(t.path), val: 1 });
    }
  }

  for (const s of keep) {
    const deg = sessionDegree.get(s.id) ?? 0;
    nodes.set(`session:${s.id}`, {
      id: `session:${s.id}`,
      type: "session",
      label: s.title ?? s.id,
      project: s.project,
      ts: s.started_at,
      status: s.status,
      val: 3 + Math.min(deg, 12),
    });
  }
  for (const [path, deg] of fileDegree) {
    const n = nodes.get(`file:${path}`);
    if (n) n.val = 1 + Math.min(deg, 10);
  }

  return { nodes: [...nodes.values()], links };
}

export interface TimelineData {
  sessions: Array<{ id: string; title: string; project: string; started_at?: string; status?: string; files: number }>;
  projects: string[];
}

export async function timelineData(db: Surreal): Promise<TimelineData> {
  const [sessions, touched] = await Promise.all([fetchSessions(db), fetchTouched(db)]);
  const deg = new Map<string, number>();
  for (const t of touched) deg.set(t.s, (deg.get(t.s) ?? 0) + 1);
  const projects = [...new Set(sessions.map((s) => s.project ?? "(unscoped)"))].sort();
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title ?? s.id,
      project: s.project ?? "(unscoped)",
      started_at: s.started_at,
      status: s.status,
      files: deg.get(s.id) ?? 0,
    })),
    projects,
  };
}

export interface StatsData {
  counts: { session: number; prompt: number; file: number; document: number; decision: number; commit: number };
  byProject: Array<{ project: string; n: number }>;
  byDay: Array<{ day: string; n: number }>;
  topFiles: Array<{ path: string; label: string; n: number }>;
}

export async function statsData(db: Surreal): Promise<StatsData> {
  const [sessions, touched] = await Promise.all([fetchSessions(db), fetchTouched(db)]);
  const [countRows] = await db.query<[Array<{ n: number; tb: string }>]>(
    `SELECT count() AS n, meta::tb(id) AS tb FROM session, prompt, file, document, decision, commit GROUP BY tb;`,
  );
  const counts = { session: 0, prompt: 0, file: 0, document: 0, decision: 0, commit: 0 };
  for (const r of countRows ?? []) {
    if (r.tb in counts) (counts as Record<string, number>)[r.tb] = r.n;
  }

  const byProjectMap = new Map<string, number>();
  const byDayMap = new Map<string, number>();
  for (const s of sessions) {
    const p = s.project ?? "(unscoped)";
    byProjectMap.set(p, (byProjectMap.get(p) ?? 0) + 1);
    const day = toDay(s.started_at);
    if (day) byDayMap.set(day, (byDayMap.get(day) ?? 0) + 1);
  }
  const fileDeg = new Map<string, number>();
  for (const t of touched) if (t.path) fileDeg.set(t.path, (fileDeg.get(t.path) ?? 0) + 1);

  return {
    counts,
    byProject: [...byProjectMap.entries()].map(([project, n]) => ({ project, n })).sort((a, b) => b.n - a.n),
    byDay: [...byDayMap.entries()].map(([day, n]) => ({ day, n })).sort((a, b) => a.day.localeCompare(b.day)),
    topFiles: [...fileDeg.entries()]
      .map(([path, n]) => ({ path, label: shortPath(path), n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15),
  };
}

export interface SessionDetail {
  id: string;
  title?: string;
  summary?: string;
  project?: string;
  started_at?: string;
  status?: string;
  files: string[];
  prompts: Array<{ role: string; text: string }>;
  decisions: Array<{ text: string; kind?: string; confidence?: number }>;
}

export async function sessionDetail(db: Surreal, id: string): Promise<SessionDetail | null> {
  // SurrealDB 3.x: build a record id from the meta id ("<tool>::<uuid>") string.
  // Fetch prompts via graph traversal (fast) rather than `id IN (subquery)`
  // (which scans the whole prompt table).
  const rid = "session:`" + id + "`";
  const [head] = await db.query<
    [
      Array<
        Omit<SessionDetail, "prompts" | "decisions"> & {
          prompts?: Array<{ role: string; text: string }>;
          decisions?: Array<{ text: string; kind?: string; confidence?: number }>;
        }
      >,
    ]
  >(
    `SELECT meta::id(id) AS id, title, summary, project, started_at, status,
            ->touched->file.path AS files,
            ->decided->decision.{ text, kind, confidence } AS decisions,
            ->contains->prompt.{ role, text } AS prompts
     FROM type::record($rid);`,
    { rid },
  );
  const s = head?.[0];
  if (!s) return null;
  return {
    ...s,
    files: (s.files ?? []).filter(Boolean),
    prompts: (s.prompts ?? []).filter((p) => p && p.text).slice(0, 300),
    decisions: (s.decisions ?? []).filter((d) => d && d.text),
  };
}

export interface DecisionItem {
  text: string;
  kind: string;
  confidence?: number;
  session: string; // meta id
  title?: string;
  project?: string;
  started_at?: string;
}

/** All extracted decisions/gotchas/TODOs with their originating session, newest first. */
export async function decisionsData(
  db: Surreal,
  opts: { project?: string; kind?: string } = {},
): Promise<DecisionItem[]> {
  const [rows] = await db.query<[DecisionItem[]]>(
    `SELECT
        out.text AS text,
        out.kind AS kind,
        out.confidence AS confidence,
        meta::id(in) AS session,
        in.title AS title,
        in.project AS project,
        in.started_at AS started_at
     FROM decided
     ORDER BY started_at DESC;`,
  );
  let items = (rows ?? []).filter((d) => d.text);
  if (opts.project) items = items.filter((d) => d.project === opts.project);
  if (opts.kind) items = items.filter((d) => d.kind === opts.kind);
  return items;
}

export interface RelatedData {
  files: Array<{ path: string; label: string }>;
  sessions: Array<{ id: string; title?: string; project?: string; shared: number }>;
  documents: Array<{ id: string; title?: string; project?: string }>;
  commits: Array<{ id: string; message: string; committed_at?: string; shared: number }>;
}

/**
 * Cross-entity "related" for a session, computed at query time (always fresh):
 *  - files it touched,
 *  - other sessions that touched any of the same files (ranked by overlap),
 *  - notes/documents in the same project.
 */
export async function relatedData(db: Surreal, metaId: string): Promise<RelatedData> {
  const empty: RelatedData = { files: [], sessions: [], documents: [], commits: [] };
  const rid = "session:`" + metaId + "`";
  const [head] = await db.query<[Array<{ project?: string; files?: string[] }>]>(
    `SELECT project, ->touched->file.path AS files FROM type::record($rid);`,
    { rid },
  );
  const self = head?.[0];
  if (!self) return empty;
  const paths = (self.files ?? []).filter(Boolean);

  // Sessions sharing any of those files (aggregate overlap in JS).
  const shared = new Map<string, number>();
  if (paths.length > 0) {
    const [rows] = await db.query<[Array<{ s: string; path: string }>]>(
      `SELECT meta::id(in) AS s, out.path AS path FROM touched WHERE out.path IN $paths;`,
      { paths },
    );
    for (const r of rows ?? []) {
      if (r.s === metaId) continue;
      shared.set(r.s, (shared.get(r.s) ?? 0) + 1);
    }
  }
  const topIds = [...shared.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id]) => id);
  let sessions: RelatedData["sessions"] = [];
  if (topIds.length > 0) {
    const [meta] = await db.query<[Array<{ id: string; title?: string; project?: string }>]>(
      `SELECT meta::id(id) AS id, title, project FROM session WHERE meta::id(id) IN $ids;`,
      { ids: topIds },
    );
    const byId = new Map((meta ?? []).map((m) => [m.id, m]));
    sessions = topIds.map((id) => ({ ...(byId.get(id) ?? { id }), shared: shared.get(id) ?? 0 }));
  }

  let documents: RelatedData["documents"] = [];
  if (self.project) {
    const [docs] = await db.query<[RelatedData["documents"]]>(
      `SELECT meta::id(id) AS id, (title ?? path) AS title, project
       FROM document WHERE project = $p LIMIT 8;`,
      { p: self.project },
    );
    documents = docs ?? [];
  }

  // Commits that changed any of the same files (overlap-ranked).
  let commits: RelatedData["commits"] = [];
  if (paths.length > 0) {
    const [rows] = await db.query<[Array<{ id: string; message: string; committed_at?: string; path: string }>]>(
      `SELECT meta::id(in) AS id, in.message AS message, in.committed_at AS committed_at, out.path AS path
       FROM changed WHERE out.path IN $paths;`,
      { paths },
    );
    const agg = new Map<string, { id: string; message: string; committed_at?: string; shared: number }>();
    for (const r of rows ?? []) {
      const cur = agg.get(r.id);
      if (cur) cur.shared++;
      else agg.set(r.id, { id: r.id, message: r.message, committed_at: r.committed_at, shared: 1 });
    }
    commits = [...agg.values()].sort((a, b) => b.shared - a.shared).slice(0, 8);
  }

  return {
    files: paths.map((path) => ({ path, label: shortPath(path) })),
    sessions,
    documents,
    commits,
  };
}

export async function searchData(db: Surreal, q: string, project?: string, embed?: Embedder): Promise<SearchHit[]> {
  if (!q.trim()) return [];
  return hybridSearch(db, q, { project, limit: 30 }, embed);
}

function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

function toDay(value: unknown): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
