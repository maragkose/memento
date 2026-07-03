/**
 * Deterministic enrichment: free, private, always-on. No model calls.
 * Produces a factual summary from files/commands/prompts and heuristic decisions.
 */
import type { EnrichmentProvider } from "./types.ts";
import type { SessionForSummary, SessionSummary } from "../core/types.ts";

export class DeterministicProvider implements EnrichmentProvider {
  readonly id = "deterministic";

  async summarize(input: SessionForSummary): Promise<SessionSummary> {
    const firstUser = input.prompts.find((p) => p.actor === "user")?.text ?? "";
    const goal = extractGoal(firstUser);
    const cmds = dedupe(input.commands).slice(0, 10);

    const title = clipTitle(input.title?.trim() || goal) || undefined;
    // Body carries the human goal; files are rendered separately by the digest,
    // and the title already surfaces the ask, so don't repeat it here.
    const summary = [
      goal || undefined,
      cmds.length ? `Commands: ${cmds.join(" | ")}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    return { summary, title, decisions: extractDecisions(input.prompts) };
  }
}

/** Category patterns, tested in priority order (first match wins per sentence). */
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  {
    kind: "gotcha",
    re: /\b(gotcha|caveat|watch out|be careful|turned out|root cause|the (?:issue|problem|bug|error) (?:was|is)|fixed by|workaround|beware|pitfall|the trick (?:was|is)|note that)\b/i,
  },
  {
    kind: "decision",
    re: /\b(decided|we(?:'ll| will) use|let'?s use|going with|went with|chose|choose to|opt(?:ed)? for|switch(?:ed)? to|use \w+ instead|instead of|the approach is|plan is to|agreed to)\b/i,
  },
  {
    kind: "todo",
    re: /\b(todo|to-?do|next step|follow[- ]?up|still (?:need|needs|to do)|remaining (?:task|work)|not yet (?:done|implemented))\b/i,
  },
];

/**
 * Heuristic extraction of decisions / gotchas / TODOs from a session's prompts.
 * Deterministic and noisy-tolerant: conservative confidence, deduped, capped.
 */
export function extractDecisions(
  prompts: Array<{ actor: string; text: string }>,
): SessionSummary["decisions"] {
  const out: SessionSummary["decisions"] = [];
  const seen = new Set<string>();
  for (const p of prompts) {
    const clean = stripWrappers(p.text ?? "");
    for (const sentence of splitSentences(clean)) {
      const s = sentence.trim();
      if (s.length < 12 || s.length > 240) continue;
      const hit = PATTERNS.find((pat) => pat.re.test(s));
      if (!hit) continue;
      const key = norm(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: s.replace(/\s+/g, " ").trim(), kind: hit.kind, confidence: 0.6 });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Cursor prompts are wrapped in system-injected blocks (<timestamp>,
 * <manually_attached_skills>, <attached_files>, ...). The real ask is usually
 * inside <user_query>. Recover the human goal, falling back to the first line
 * that isn't a wrapper tag.
 */
function extractGoal(raw: string): string {
  const uq = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  const text = (uq?.[1] ?? stripWrappers(raw)).trim();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !/^<[^>]+>/.test(l)) ?? "";
  return line.slice(0, 200);
}

/** Truncate a title to `max` chars on a word boundary, adding an ellipsis. */
function clipTitle(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 40 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

function stripWrappers(raw: string): string {
  return raw
    .replace(/<(timestamp|manually_attached_skills|attached_files|system_reminder|additional_data|user_info)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
