/**
 * GitSource: reads commit history from local git repositories and normalizes it
 * for the graph. Commits link to the files they changed (absolute paths, so they
 * reuse the same `file` nodes sessions touch) and to a project (slug of the repo
 * path, matching Cursor's workspace-slug scheme).
 *
 * Repo discovery: explicit MEM_GIT_ROOTS, else a shallow scan under $HOME for
 * `.git` directories (depth MEM_GIT_SCAN_DEPTH), skipping the notes ignore list.
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "../core/config.ts";
import { slugify } from "../core/graph.ts";
import { log } from "../core/log.ts";

export interface CommitRef {
  hash: string;
  message: string;
  author?: string;
  committedAt: string; // ISO
  files: string[]; // absolute paths
}

export interface RepoRef {
  root: string; // absolute repo dir
  slug: string; // project slug (matches session.project when opened as workspace)
  branch?: string;
}

export class GitSource {
  readonly id = "git";
  constructor(private readonly cfg: Config) {}

  /** Locate repos: explicit roots first, then a shallow $HOME scan. */
  async discoverRepos(): Promise<RepoRef[]> {
    const roots = new Set<string>();
    for (const r of this.cfg.git.roots) {
      if (await isRepo(r)) roots.add(path.resolve(r));
    }
    if (this.cfg.git.roots.length === 0 && this.cfg.git.scanDepth > 0) {
      const ignore = new Set(this.cfg.notes.ignoreDirs);
      await scanForRepos(this.cfg.sources.homeDir, this.cfg.git.scanDepth, ignore, roots);
    }
    const repos: RepoRef[] = [];
    for (const root of roots) {
      repos.push({ root, slug: slugify(root), branch: await currentBranch(root) });
    }
    return repos;
  }

  /** Read commits newer than the lookback window (newest first, capped). */
  async readCommits(repo: RepoRef): Promise<CommitRef[]> {
    const since = new Date(Date.now() - this.cfg.git.lookbackDays * 86_400_000).toISOString();
    // Each commit starts with a record separator (\x1e); header fields are unit-
    // separated (\x1f); --name-only lists changed files one per line afterwards.
    const fmt = "%x1e%H%x1f%an%x1f%aI%x1f%s";
    const out = await git(
      repo.root,
      ["log", `--since=${since}`, `--max-count=${this.cfg.git.maxCommits}`, "--name-only", `--pretty=format:${fmt}`],
    ).catch((e) => {
      log.debug(`git: log failed for ${repo.root}`, e);
      return "";
    });
    return parseLog(out, repo.root);
  }
}

/** Parse `git log --name-only` output (RS-prefixed records) into commits. */
function parseLog(raw: string, root: string): CommitRef[] {
  const commits: CommitRef[] = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const lines = record.split("\n");
    const [hash, author, at, subject] = (lines.shift() ?? "").split("\x1f");
    if (!hash) continue;
    const files = lines
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => path.resolve(root, f));
    commits.push({
      hash,
      message: (subject ?? "").trim(),
      author: author?.trim() || undefined,
      committedAt: (at ?? "").trim(),
      files,
    });
  }
  return commits;
}

async function isRepo(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(path.join(dir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

/** Depth-limited BFS for `.git` dirs; stops descending into a repo once found. */
async function scanForRepos(root: string, depth: number, ignore: Set<string>, out: Set<string>): Promise<void> {
  if (depth < 0) return;
  if (await isRepo(root)) {
    out.add(path.resolve(root));
    return; // don't descend into a repo's subdirs
  }
  if (depth === 0) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".") || ignore.has(ent.name)) continue;
    await scanForRepos(path.join(root, ent.name), depth - 1, ignore, out);
  }
}

async function currentBranch(root: string): Promise<string | undefined> {
  const b = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  return b && b !== "HEAD" ? b : undefined;
}

/** Run git in a repo, resolving stdout. Rejects on non-zero exit. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `git exited ${code}`))));
  });
}
