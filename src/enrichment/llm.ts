/**
 * LLM enrichment provider. Talks to Ollama (local, private) or an OpenAI-compatible
 * API over HTTP. Only used when MEM_ENRICH != deterministic. Falls back gracefully.
 */
import type { Config } from "../core/config.ts";
import type { EnrichmentProvider } from "./types.ts";
import type { SessionForSummary, SessionSummary } from "../core/types.ts";
import { log } from "../core/log.ts";

const SUMMARY_PROMPT = `You are summarizing a coding session for a memory bank.
Return STRICT JSON: {"summary": string, "decisions": [{"text": string, "kind": string, "confidence": number}]}.
Summary: 3-5 sentences on what was worked on, files, and outcome.
Decisions: durable choices/insights worth remembering (may be empty).`;

export class OllamaProvider implements EnrichmentProvider {
  readonly id = "ollama";
  constructor(private readonly cfg: Config) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${this.cfg.ollama.url}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.cfg.ollama.embedModel, prompt: text }),
      });
      const json = (await res.json()) as { embedding?: number[] };
      out.push(json.embedding ?? []);
    }
    return out;
  }

  /** Free-form completion (used by the `ask` RAG command). */
  async generate(prompt: string): Promise<string> {
    const res = await fetch(`${this.cfg.ollama.url}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.ollama.model, prompt, stream: false }),
    });
    const json = (await res.json()) as { response?: string };
    return (json.response ?? "").trim();
  }

  async summarize(input: SessionForSummary): Promise<SessionSummary> {
    const context = renderContext(input);
    try {
      const res = await fetch(`${this.cfg.ollama.url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.cfg.ollama.model,
          prompt: `${SUMMARY_PROMPT}\n\n---\n${context}`,
          format: "json",
          stream: false,
        }),
      });
      const json = (await res.json()) as { response?: string };
      const parsed = JSON.parse(json.response ?? "{}");
      return {
        summary: String(parsed.summary ?? ""),
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      };
    } catch (err) {
      log.warn("ollama summarize failed; empty summary", err);
      return { summary: "", decisions: [] };
    }
  }
}

function renderContext(input: SessionForSummary): string {
  const prompts = input.prompts
    .slice(0, 40)
    .map((p) => `${p.actor}: ${p.text}`)
    .join("\n");
  return [
    input.title ? `Title: ${input.title}` : "",
    `Files: ${input.files.join(", ")}`,
    `Commands: ${input.commands.join(" | ")}`,
    `Transcript:\n${prompts}`,
  ].join("\n");
}
