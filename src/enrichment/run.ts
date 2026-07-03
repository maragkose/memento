/**
 * Shared enrichment step: summarize (+ optional embed) a session, then mark it
 * 'ready'. Used by both the live subscriber and inline backfill so batch and
 * live paths behave identically.
 */
import type { Surreal } from "surrealdb";
import type { EnrichmentProvider } from "./types.ts";
import type { SessionForSummary } from "../core/types.ts";
import { setSessionSummary, addDecision } from "../core/graph.ts";

export async function enrichSession(
  db: Surreal,
  provider: EnrichmentProvider,
  rid: string,
  input: SessionForSummary,
): Promise<void> {
  const summaryObj = provider.summarize
    ? await provider.summarize(input)
    : { summary: "", decisions: [] };

  let embedding: number[] | undefined;
  if (provider.embed && summaryObj.summary) {
    embedding = (await provider.embed([summaryObj.summary]))[0];
  }
  await setSessionSummary(db, rid, summaryObj.summary, embedding, summaryObj.title);

  // Persist extracted decisions/gotchas/TODOs (prior ones were cleared on re-read).
  for (const d of summaryObj.decisions ?? []) {
    await addDecision(db, rid, d);
  }
}
