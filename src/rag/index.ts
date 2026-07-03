/**
 * Local RAG over the memory bank: retrieve hybrid-ranked context with citations
 * (`recall`), and optionally have an LLM answer a question grounded in that context
 * with inline [n] citations (`ask`). No cloud calls unless you configure one.
 */
import type { Surreal } from "surrealdb";
import { hybridSearch, type Embedder } from "../core/queries.ts";
import type { Chat } from "../enrichment/registry.ts";

export interface Source {
  n: number; // 1-based citation index
  id: string; // meta id
  type: string; // session | prompt | document | decision | commit
  title: string;
  project?: string;
  ts?: string;
  snippet: string;
}

const SNIPPET_MAX = 500;

function clip(s: string, max = SNIPPET_MAX): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Build the record-id string for a hit (handles ::/path keys). */
function ridFor(type: string, id: string): string {
  return `${type}:⟨${id}⟩`.replace(/[⟨⟩]/g, "`");
}

/** Retrieve top hits and hydrate each into a cited Source with a text snippet. */
export async function retrieve(
  db: Surreal,
  query: string,
  opts: { project?: string; limit?: number } = {},
  embed?: Embedder,
): Promise<Source[]> {
  const limit = opts.limit ?? 6;
  const hits = await hybridSearch(db, query, { project: opts.project, limit }, embed);
  const sources: Source[] = [];
  for (const h of hits.slice(0, limit)) {
    const rid = ridFor(h.type, h.id);
    const [rows] = await db.query<[Array<Record<string, unknown>>]>(`SELECT * FROM type::record($rid);`, { rid });
    const row = rows?.[0] ?? {};
    // Prefer a proper title/path for the label; the snippet carries the body.
    const label = (typeof row.title === "string" && row.title) || (typeof row.path === "string" && row.path) || h.title;
    sources.push({
      n: sources.length + 1,
      id: h.id,
      type: h.type,
      title: clip(label, 120),
      project: h.project,
      ts: h.ts,
      snippet: snippetOf(h.type, row, h.title),
    });
  }
  return sources;
}

function snippetOf(type: string, row: Record<string, unknown>, fallback: string): string {
  const str = (k: string) => (typeof row[k] === "string" ? (row[k] as string) : "");
  switch (type) {
    case "session":
      return clip(str("summary") || str("title") || fallback);
    case "document":
      return clip(str("content") || str("title") || fallback);
    case "prompt":
      return clip(str("text") || fallback);
    case "decision":
      return clip(str("text") || fallback);
    case "commit":
      return clip(str("message") || fallback);
    default:
      return clip(fallback);
  }
}

/** Human-readable one-line citation label. */
export function citation(s: Source): string {
  const when = s.ts ? new Date(s.ts).toISOString().slice(0, 10) : "";
  const meta = [s.project, when].filter(Boolean).join(", ");
  return `[${s.n}] ${s.type}${meta ? ` (${meta})` : ""} — ${s.title}`;
}

const ASK_PROMPT = `You are answering a question using a developer's memory bank.
Use ONLY the numbered sources below. Cite them inline as [n] right after each claim.
If the sources don't contain the answer, say so plainly. Be concise.`;

export interface Answer {
  answer: string;
  sources: Source[];
}

/**
 * Grounded question-answering. Retrieves context then asks the LLM to answer with
 * inline citations. Requires a chat function (MEM_ENRICH=ollama); callers should
 * fall back to {@link retrieve} (recall) when none is configured.
 */
export async function ask(
  db: Surreal,
  query: string,
  chat: Chat,
  opts: { project?: string; limit?: number } = {},
  embed?: Embedder,
): Promise<Answer> {
  const sources = await retrieve(db, query, opts, embed);
  if (sources.length === 0) return { answer: "No relevant context found in the memory bank.", sources };
  const block = sources.map((s) => `[${s.n}] (${s.type}${s.project ? `, ${s.project}` : ""}) ${s.title}\n${s.snippet}`).join("\n\n");
  const prompt = `${ASK_PROMPT}\n\nQuestion: ${query}\n\nSources:\n${block}\n\nAnswer:`;
  const answer = await chat(prompt);
  return { answer: answer || "(the model returned an empty answer)", sources };
}
