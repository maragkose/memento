/**
 * Git ingestion: discover local repos, read recent commits, and upsert them as
 * graph nodes linked to the files they changed. Incremental (skips hashes already
 * stored) and cheap enough for the daemon's poll loop.
 */
import type { Surreal } from "surrealdb";
import type { Config } from "../core/config.ts";
import { GitSource } from "../adapters/git.ts";
import { addCommit, existingCommitHashes } from "../core/graph.ts";
import { log } from "../core/log.ts";

export interface GitStats {
  repos: number;
  commits: number;
}

export async function syncCommits(db: Surreal, cfg: Config, source?: GitSource): Promise<GitStats> {
  const stats: GitStats = { repos: 0, commits: 0 };
  if (!cfg.git.enabled) return stats;
  const src = source ?? new GitSource(cfg);
  const repos = await src.discoverRepos();
  for (const repo of repos) {
    stats.repos++;
    const seen = await existingCommitHashes(db, repo.slug);
    const commits = await src.readCommits(repo);
    let added = 0;
    for (const c of commits) {
      if (seen.has(c.hash)) continue;
      await addCommit(db, repo.slug, {
        hash: c.hash,
        message: c.message,
        author: c.author,
        branch: repo.branch,
        project: repo.slug,
        committedAt: c.committedAt,
        files: c.files,
      });
      added++;
    }
    stats.commits += added;
    if (added > 0) log.info(`git: ${added} new commit(s) from ${repo.root}`);
  }
  if (stats.commits > 0) log.info(`git sync: ${stats.commits} commit(s) across ${stats.repos} repo(s)`);
  return stats;
}
