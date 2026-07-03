import { useEffect, useState } from "react";
import { api, type RelatedData, type SessionDetail } from "../api.ts";
import { projectColor } from "../lib/colors.ts";

interface Props {
  sessionId: string | null;
  onClose: () => void;
  onSelectSession?: (id: string) => void;
}

function kindIcon(kind?: string): string {
  return kind === "gotcha" ? "⚠️" : kind === "todo" ? "☐" : "→";
}

export default function SessionPanel({ sessionId, onClose, onSelectSession }: Props) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [related, setRelated] = useState<RelatedData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    setDetail(null);
    setRelated(null);
    api
      .session(sessionId)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
    api.related(sessionId).then(setRelated).catch(() => setRelated(null));
  }, [sessionId]);

  if (!sessionId) return null;

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md animate-fadeIn flex-col border-l border-slate-700/60 bg-slate-950/95 shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between gap-3 border-b border-slate-800 p-4">
        <div className="min-w-0">
          {detail?.project && (
            <span
              className="inline-block rounded px-2 py-0.5 text-[11px] font-medium"
              style={{ background: `${projectColor(detail.project)}22`, color: projectColor(detail.project) }}
            >
              {detail.project}
            </span>
          )}
          <h2 className="mt-1 text-sm font-semibold leading-snug text-slate-100">
            {loading ? "Loading…" : detail?.title ?? "(untitled session)"}
          </h2>
          {detail?.started_at && (
            <p className="mt-0.5 text-xs text-slate-500">{new Date(detail.started_at).toLocaleString()}</p>
          )}
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200">✕</button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {detail?.summary && (
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h3>
            <p className="whitespace-pre-wrap text-sm text-slate-300">{detail.summary}</p>
          </section>
        )}

        {detail && detail.decisions.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Decisions &amp; notes ({detail.decisions.length})
            </h3>
            <ul className="space-y-1.5">
              {detail.decisions.map((d, i) => (
                <li key={i} className="flex gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2 text-xs">
                  <span title={d.kind ?? "note"}>{kindIcon(d.kind)}</span>
                  <span className="text-slate-300">{d.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {related && (related.sessions.length > 0 || related.documents.length > 0 || related.commits.length > 0) && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Related</h3>
            {related.sessions.length > 0 && (
              <ul className="mb-2 space-y-1">
                {related.sessions.map((s) => (
                  <li
                    key={s.id}
                    onClick={() => onSelectSession?.(s.id)}
                    className="flex cursor-pointer items-center gap-2 rounded bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                    title={`${s.shared} shared file${s.shared === 1 ? "" : "s"}`}
                  >
                    {s.project && (
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: projectColor(s.project) }} />
                    )}
                    <span className="truncate">{s.title ?? s.id}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-500">{s.shared}★</span>
                  </li>
                ))}
              </ul>
            )}
            {related.documents.length > 0 && (
              <ul className="space-y-1">
                {related.documents.map((d) => (
                  <li key={d.id} className="truncate rounded bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-400" title={d.title}>
                    📄 {d.title}
                  </li>
                ))}
              </ul>
            )}
            {related.commits.length > 0 && (
              <ul className="mt-2 space-y-1">
                {related.commits.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-2 truncate rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-400"
                    title={`${c.shared} shared file${c.shared === 1 ? "" : "s"}${c.committed_at ? ` · ${new Date(c.committed_at).toLocaleDateString()}` : ""}`}
                  >
                    <span>⎇</span>
                    <span className="truncate">{c.message}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-500">{c.shared}★</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {detail && detail.files.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Files ({detail.files.length})
            </h3>
            <ul className="space-y-1">
              {detail.files.map((f) => (
                <li key={f} className="truncate rounded bg-slate-900 px-2 py-1 font-mono text-[11px] text-slate-400" title={f}>
                  {f}
                </li>
              ))}
            </ul>
          </section>
        )}

        {detail && detail.prompts.length > 0 && (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Transcript ({detail.prompts.length})
            </h3>
            <div className="space-y-2">
              {detail.prompts.map((p, i) => (
                <div key={i} className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
                  <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
                    p.role === "assistant" ? "text-emerald-400" : p.role === "user" ? "text-sky-400" : "text-slate-500"
                  }`}>
                    {p.role}
                  </div>
                  <p className="line-clamp-6 whitespace-pre-wrap text-xs text-slate-300">{p.text}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
