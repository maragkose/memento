import type { Stats } from "../api.ts";
import { projectColor } from "../lib/colors.ts";

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-5">
      <div className="text-3xl font-bold text-slate-100">{value.toLocaleString()}</div>
      <div className="mt-1 text-xs uppercase tracking-wide text-slate-500">{label}</div>
    </div>
  );
}

export default function StatsView({ data, onPickProject }: { data: Stats; onPickProject: (p: string) => void }) {
  const maxDay = Math.max(1, ...data.byDay.map((d) => d.n));
  const maxProj = Math.max(1, ...data.byProject.map((p) => p.n));
  const maxFile = Math.max(1, ...data.topFiles.map((f) => f.n));

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="grid grid-cols-3 gap-4 lg:grid-cols-6">
          <Card label="Sessions" value={data.counts.session} />
          <Card label="Prompts" value={data.counts.prompt} />
          <Card label="Files" value={data.counts.file} />
          <Card label="Notes" value={data.counts.document} />
          <Card label="Decisions" value={data.counts.decision} />
          <Card label="Commits" value={data.counts.commit} />
        </div>

        {/* Activity over time */}
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <h3 className="mb-4 text-sm font-semibold text-slate-200">Activity over time</h3>
          <div className="flex h-40 items-end gap-[3px]">
            {data.byDay.map((d) => (
              <div key={d.day} className="group relative flex-1" title={`${d.day}: ${d.n}`}>
                <div
                  className="w-full rounded-t bg-gradient-to-t from-sky-600 to-cyan-400 transition group-hover:from-sky-400 group-hover:to-cyan-300"
                  style={{ height: `${(d.n / maxDay) * 100}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-[10px] text-slate-500">
            <span>{data.byDay[0]?.day}</span>
            <span>{data.byDay[data.byDay.length - 1]?.day}</span>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* By project */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
            <h3 className="mb-4 text-sm font-semibold text-slate-200">Sessions by project</h3>
            <div className="space-y-2">
              {data.byProject.map((p) => (
                <button key={p.project} onClick={() => onPickProject(p.project)} className="group block w-full text-left">
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="truncate text-slate-300 group-hover:text-white">{p.project}</span>
                    <span className="text-slate-500">{p.n}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full" style={{ width: `${(p.n / maxProj) * 100}%`, background: projectColor(p.project) }} />
                  </div>
                </button>
              ))}
            </div>
          </section>

          {/* Top files */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
            <h3 className="mb-4 text-sm font-semibold text-slate-200">Most-touched files</h3>
            <div className="space-y-2">
              {data.topFiles.map((f) => (
                <div key={f.path} title={f.path}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="truncate font-mono text-slate-400">{f.label}</span>
                    <span className="text-slate-500">{f.n}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                    <div className="h-full rounded-full bg-gradient-to-r from-fuchsia-500 to-violet-500" style={{ width: `${(f.n / maxFile) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
