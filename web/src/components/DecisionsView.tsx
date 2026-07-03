import { useEffect, useMemo, useState } from "react";
import { api, type DecisionItem } from "../api.ts";
import { projectColor } from "../lib/colors.ts";

interface Props {
  project?: string;
  onSelectSession: (id: string) => void;
}

const KINDS = [
  { id: "", label: "All" },
  { id: "decision", label: "Decisions" },
  { id: "gotcha", label: "Gotchas" },
  { id: "todo", label: "TODOs" },
];

function icon(kind: string): string {
  return kind === "gotcha" ? "⚠️" : kind === "todo" ? "☐" : "→";
}

function toDay(v?: string): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export default function DecisionsView({ project, onSelectSession }: Props) {
  const [items, setItems] = useState<DecisionItem[]>([]);
  const [kind, setKind] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .decisions(project, kind || undefined)
      .then(setItems)
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [project, kind]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, [items]);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-100">Decisions &amp; notes</h2>
          <span className="text-xs text-slate-500">
            {items.length} item{items.length === 1 ? "" : "s"}
            {kind ? "" : ` · → ${counts.decision ?? 0}  ⚠️ ${counts.gotcha ?? 0}  ☐ ${counts.todo ?? 0}`}
          </span>
          <div className="ml-auto flex rounded-lg border border-slate-800 bg-slate-900 p-0.5">
            {KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  kind === k.id ? "bg-sky-500/20 text-sky-300" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <p className="text-slate-500">loading…</p>
        ) : items.length === 0 ? (
          <p className="text-slate-500">
            No decisions extracted yet. They are mined from session transcripts on enrichment.
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((d, i) => (
              <li
                key={i}
                onClick={() => onSelectSession(d.session)}
                className="flex cursor-pointer gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3 transition hover:border-slate-700 hover:bg-slate-900"
              >
                <span className="text-base leading-none" title={d.kind}>{icon(d.kind)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200">{d.text}</p>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                    {d.project && (
                      <span style={{ color: projectColor(d.project) }}>{d.project}</span>
                    )}
                    {d.title && <span className="truncate">· {d.title}</span>}
                    {toDay(d.started_at) && <span>· {toDay(d.started_at)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
