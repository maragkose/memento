/**
 * Resolve the enrichment provider from config. Deterministic is always available
 * as a baseline; LLM providers layer on top when configured.
 */
import type { Config } from "../core/config.ts";
import type { EnrichmentProvider } from "./types.ts";
import { DeterministicProvider } from "./deterministic.ts";
import { OllamaProvider } from "./llm.ts";

export function buildEnrichment(cfg: Config): EnrichmentProvider {
  switch (cfg.enrich) {
    case "ollama":
      return new OllamaProvider(cfg);
    case "openai":
    case "gemini":
      // TODO: OpenAI/Gemini providers (same interface, different HTTP shape).
      return new DeterministicProvider();
    case "deterministic":
    default:
      return new DeterministicProvider();
  }
}

/**
 * Query-time embedder for hybrid search, or undefined when embeddings are off /
 * unsupported. Only the Ollama embed path is implemented today.
 */
export function buildEmbedder(cfg: Config): ((texts: string[]) => Promise<number[][]>) | undefined {
  if (cfg.embed === "ollama") {
    const p = new OllamaProvider(cfg);
    return (texts) => p.embed!(texts);
  }
  return undefined;
}

export type Chat = (prompt: string) => Promise<string>;

/**
 * Text-generation function for the `ask` RAG command, or undefined when no LLM is
 * configured (MEM_ENRICH=deterministic). Only the Ollama path is implemented today.
 */
export function buildChat(cfg: Config): Chat | undefined {
  if (cfg.enrich === "ollama") {
    const p = new OllamaProvider(cfg);
    return (prompt) => p.generate(prompt);
  }
  return undefined;
}
