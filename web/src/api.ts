// Typed client for the local memorcy API (src/serve/server.ts).

export interface GraphNode {
  id: string;
  type: "session" | "file" | "project";
  label: string;
  project?: string;
  ts?: string;
  status?: string;
  val: number;
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

export interface Stats {
  counts: { session: number; prompt: number; file: number; document: number; decision: number; commit: number };
  byProject: Array<{ project: string; n: number }>;
  byDay: Array<{ day: string; n: number }>;
  topFiles: Array<{ path: string; label: string; n: number }>;
}

export interface TimelineSession {
  id: string;
  title: string;
  project: string;
  started_at?: string;
  status?: string;
  files: number;
}
export interface Timeline {
  sessions: TimelineSession[];
  projects: string[];
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

export interface DecisionItem {
  text: string;
  kind: string;
  confidence?: number;
  session: string;
  title?: string;
  project?: string;
  started_at?: string;
}

export interface RelatedData {
  files: Array<{ path: string; label: string }>;
  sessions: Array<{ id: string; title?: string; project?: string; shared: number }>;
  documents: Array<{ id: string; title?: string; project?: string }>;
  commits: Array<{ id: string; message: string; committed_at?: string; shared: number }>;
}

export interface SearchHit {
  id: string;
  type: string;
  title: string;
  ts?: string;
  project?: string;
  score: number;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  stats: () => get<Stats>("/api/stats"),
  graph: (project?: string) => get<GraphData>(`/api/graph${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  timeline: () => get<Timeline>("/api/timeline"),
  decisions: (project?: string, kind?: string) =>
    get<DecisionItem[]>(
      `/api/decisions?${new URLSearchParams({ ...(project ? { project } : {}), ...(kind ? { kind } : {}) }).toString()}`,
    ),
  search: (q: string, project?: string) =>
    get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  session: (id: string) => get<SessionDetail>(`/api/session/${encodeURIComponent(id)}`),
  related: (id: string) => get<RelatedData>(`/api/related/${encodeURIComponent(id)}`),
};
