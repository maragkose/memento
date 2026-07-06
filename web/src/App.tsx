import { useEffect, useMemo, useState } from "react";
import { api, type GraphData, type SearchHit, type Stats, type Timeline } from "./api.ts";
import GraphView from "./components/GraphView.tsx";
import TimelineView from "./components/TimelineView.tsx";
import StatsView from "./components/StatsView.tsx";
import DecisionsView from "./components/DecisionsView.tsx";
import SearchBar from "./components/SearchBar.tsx";
import SessionPanel from "./components/SessionPanel.tsx";
import { projectColor } from "./lib/colors.ts";

type View = "graph" | "timeline" | "decisions" | "stats";

const TABS: Array<{ id: View; label: string }> = [
  { id: "graph", label: "Graph" },
  { id: "timeline", label: "Timeline" },
  { id: "decisions", label: "Decisions" },
  { id: "stats", label: "Stats" },
];

export default function App() {
  const [view, setView] = useState<View>("graph");
  const [project, setProject] = useState<string | undefined>();
  const [graph, setGraph] = useState<GraphData>({ nodes: [], links: [] });
  const [timeline, setTimeline] = useState<Timeline>({ sessions: [], projects: [] });
  const [stats, setStats] = useState<Stats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [t, s] = await Promise.all([api.timeline(), api.stats()]);
        setTimeline(t);
        setStats(s);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    api.graph(project).then(setGraph).catch(() => setGraph({ nodes: [], links: [] }));
  }, [project]);

  const highlight = useMemo(() => {
    const set = new Set<string>();
    for (const h of hits) if (h.type === "session") set.add(`session:${h.id}`);
    return set;
  }, [hits]);

  const timelineFiltered = useMemo<Timeline>(() => {
    if (!project) return timeline;
    return { ...timeline, sessions: timeline.sessions.filter((s) => s.project === project) };
  }, [timeline, project]);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-200">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-slate-800 bg-slate-900/60 px-4 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded bg-gradient-to-br from-sky-400 to-fuchsia-500" />
          <span className="text-sm font-semibold tracking-tight">memorcy</span>
        </div>

        <nav className="flex rounded-lg border border-slate-800 bg-slate-900 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                view === t.id ? "bg-sky-500/20 text-sky-300" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <select
          value={project ?? ""}
          onChange={(e) => setProject(e.target.value || undefined)}
          className="rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-sky-500"
        >
          <option value="">All projects</option>
          {timeline.projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        {project && (
          <span className="flex items-center gap-1 text-xs" style={{ color: projectColor(project) }}>
            <span className="h-2 w-2 rounded-full" style={{ background: projectColor(project) }} />
            filtered
          </span>
        )}

        <div className="ml-auto">
          <SearchBar project={project} onHits={setHits} onSelectSession={setSelected} />
        </div>
      </header>

      {/* Body */}
      <main className="relative flex-1 overflow-hidden">
        {loading && <div className="absolute inset-0 z-10 flex items-center justify-center text-slate-500">loading…</div>}

        {view === "graph" && (
          <GraphView data={graph} highlight={highlight} onSelectSession={setSelected} />
        )}
        {view === "timeline" && (
          <TimelineView data={timelineFiltered} highlight={highlight} onSelectSession={setSelected} />
        )}
        {view === "decisions" && (
          <DecisionsView project={project} onSelectSession={setSelected} />
        )}
        {view === "stats" && stats && (
          <StatsView data={stats} onPickProject={(p) => { setProject(p); setView("graph"); }} />
        )}

        <SessionPanel sessionId={selected} onClose={() => setSelected(null)} onSelectSession={setSelected} />
      </main>
    </div>
  );
}
