/**
 * Graph write helpers: upsert nodes and RELATE edges from normalized events.
 * Uses SurrealQL with parameters. Kept intentionally small; extend per phase.
 */
import type { Surreal } from "surrealdb";
import type { RawEvent, SessionStatus } from "./types.ts";

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export async function upsertProject(db: Surreal, name: string): Promise<void> {
  const slug = slugify(name);
  await db.query(
    `UPSERT project SET name = $name, slug = $slug WHERE slug = $slug;`,
    { name, slug },
  );
}

/** Deterministic record id so re-ingest is idempotent. */
export function sessionRid(tool: string, sessionId: string): string {
  return `session:⟨${tool}::${sessionId}⟩`.replace(/[⟨⟩]/g, "`");
}

export async function upsertSession(
  db: Surreal,
  s: { tool: string; sessionId: string; project: string; title?: string; startedAt?: string; mtime?: string },
): Promise<string> {
  const id = sessionRid(s.tool, s.sessionId);
  // Build SET conditionally: option<...> fields reject NULL in SurrealDB 3.x,
  // so omit absent ones rather than passing null.
  const sets = ["tool = $tool", "external_id = $sid", "project = $project", "status = status OR 'raw'"];
  const params: Record<string, unknown> = { tool: s.tool, sid: s.sessionId, project: s.project };
  if (s.title) {
    sets.push("title = $title");
    params.title = s.title;
  }
  if (s.startedAt) {
    sets.push("started_at = <datetime> $startedAt");
    params.startedAt = s.startedAt;
  }
  if (s.mtime) {
    sets.push("source_mtime = <datetime> $mtime");
    params.mtime = s.mtime;
  }
  await db.query(`UPSERT ${id} SET ${sets.join(", ")};`, params);
  // Link session -> project
  await db.query(
    `LET $p = (SELECT VALUE id FROM project WHERE slug = $slug)[0];
     IF $p THEN RELATE ${id}->about->$p END;`,
    { slug: slugify(s.project) },
  );
  return id;
}

/**
 * Remove a session's prompts and its outgoing content edges so the session can
 * be re-read cleanly (transcripts grow/change on disk). Shared file nodes are
 * kept; only this session's `touched` edges are dropped.
 */
export async function clearSessionContent(db: Surreal, sessionRidStr: string): Promise<void> {
  await db.query(
    `LET $ps = (SELECT VALUE out FROM contains WHERE in = ${sessionRidStr});
     DELETE prompt WHERE id IN $ps;
     DELETE contains WHERE in = ${sessionRidStr};
     DELETE touched WHERE in = ${sessionRidStr};
     LET $ds = (SELECT VALUE out FROM decided WHERE in = ${sessionRidStr});
     DELETE decision WHERE id IN $ds;
     DELETE decided WHERE in = ${sessionRidStr};`,
  );
}

export async function addDecision(
  db: Surreal,
  sessionRidStr: string,
  d: { text: string; kind?: string; confidence?: number },
): Promise<void> {
  await db.query(
    `LET $d = (CREATE decision SET text = $text, kind = $kind, confidence = $conf)[0].id;
     RELATE ${sessionRidStr}->decided->$d;`,
    { text: d.text, kind: d.kind ?? "note", conf: d.confidence ?? 0.5 },
  );
}

/** Map of already-ingested sessions -> stored source_mtime (ISO or null). */
export async function existingSessionMtimes(db: Surreal): Promise<Map<string, string | null>> {
  const [rows] = await db.query<[Array<{ tool: string; external_id: string; source_mtime: unknown }>]>(
    `SELECT tool, external_id, source_mtime FROM session;`,
  );
  const map = new Map<string, string | null>();
  for (const r of rows ?? []) {
    const mt = r.source_mtime instanceof Date ? r.source_mtime.toISOString() : (r.source_mtime as string | null) ?? null;
    map.set(`${r.tool}::${r.external_id}`, mt);
  }
  return map;
}

/** Deterministic record id from a file path (idempotent re-ingest). */
export function documentRid(filePath: string): string {
  return `document:⟨${filePath}⟩`.replace(/[⟨⟩]/g, "`");
}

export async function upsertDocument(
  db: Surreal,
  d: { path: string; title?: string; content?: string; project?: string; ext?: string; bytes?: number; mtime?: string },
): Promise<string> {
  const id = documentRid(d.path);
  const sets = ["path = $path"];
  const params: Record<string, unknown> = { path: d.path };
  if (d.title !== undefined) { sets.push("title = $title"); params.title = d.title; }
  if (d.content !== undefined) { sets.push("content = $content"); params.content = d.content; }
  if (d.project) { sets.push("project = $project"); params.project = d.project; }
  if (d.ext) { sets.push("ext = $ext"); params.ext = d.ext; }
  if (d.bytes !== undefined) { sets.push("bytes = $bytes"); params.bytes = d.bytes; }
  if (d.mtime) { sets.push("source_mtime = <datetime> $mtime"); params.mtime = d.mtime; }
  await db.query(`UPSERT ${id} SET ${sets.join(", ")};`, params);
  if (d.project) {
    await db.query(
      `LET $p = (SELECT VALUE id FROM project WHERE slug = $slug)[0];
       IF $p THEN RELATE ${id}->about->$p END;`,
      { slug: slugify(d.project) },
    );
  }
  return id;
}

/** Map of already-ingested documents -> stored source_mtime (ISO or null). */
export async function existingDocumentMtimes(db: Surreal): Promise<Map<string, string | null>> {
  const [rows] = await db.query<[Array<{ path: string; source_mtime: unknown }>]>(
    `SELECT path, source_mtime FROM document;`,
  );
  const map = new Map<string, string | null>();
  for (const r of rows ?? []) {
    const mt = r.source_mtime instanceof Date ? r.source_mtime.toISOString() : (r.source_mtime as string | null) ?? null;
    map.set(r.path, mt);
  }
  return map;
}

/** Build a quoted record id string from a table + key (handles ::/paths). */
export function ridFrom(table: string, key: string): string {
  return `${table}:⟨${key}⟩`.replace(/[⟨⟩]/g, "`");
}

/** Deterministic commit id (per repo, so identical hashes across forks don't clash). */
export function commitRid(repoSlug: string, hash: string): string {
  return `commit:⟨${repoSlug}::${hash}⟩`.replace(/[⟨⟩]/g, "`");
}

/** Set of commit hashes already ingested for a repo (for incremental sync). */
export async function existingCommitHashes(db: Surreal, repoSlug: string): Promise<Set<string>> {
  const [rows] = await db.query<[Array<{ hash: string }>]>(
    `SELECT hash FROM commit WHERE repo = $repo;`,
    { repo: repoSlug },
  );
  return new Set((rows ?? []).map((r) => r.hash));
}

/**
 * Insert a commit and link it to the files it changed (reusing shared `file`
 * nodes by absolute path — the same nodes sessions touch). Idempotent per hash;
 * callers should skip hashes already present to avoid duplicate `changed` edges.
 */
export async function addCommit(
  db: Surreal,
  repoSlug: string,
  c: { hash: string; message: string; author?: string; branch?: string; project?: string; committedAt?: string; files: string[] },
): Promise<void> {
  const id = commitRid(repoSlug, c.hash);
  const sets = ["hash = $hash", "message = $message", "repo = $repo"];
  const params: Record<string, unknown> = { hash: c.hash, message: c.message, repo: repoSlug, paths: c.files };
  if (c.author) { sets.push("author = $author"); params.author = c.author; }
  if (c.branch) { sets.push("branch = $branch"); params.branch = c.branch; }
  if (c.project) { sets.push("project = $project"); params.project = c.project; }
  if (c.committedAt) { sets.push("committed_at = <datetime> $at"); params.at = c.committedAt; }
  await db.query(`UPSERT ${id} SET ${sets.join(", ")};`, params);
  if (c.files.length > 0) {
    await db.query(
      `FOR $p IN $paths {
         LET $f = (UPSERT file SET path = $p WHERE path = $p RETURN id)[0].id
             ?? (CREATE file SET path = $p)[0].id;
         RELATE ${id}->changed->$f;
       };`,
      { paths: c.files },
    );
  }
  if (c.project) {
    await db.query(
      `LET $p = (SELECT VALUE id FROM project WHERE slug = $slug)[0];
       IF $p THEN RELATE ${id}->about->$p END;`,
      { slug: slugify(c.project) },
    );
  }
}

export async function setPinned(db: Surreal, rid: string, pinned: boolean): Promise<void> {
  await db.query(`UPDATE ${rid} SET pinned = $p;`, { p: pinned });
}

export async function addTags(db: Surreal, rid: string, tags: string[]): Promise<void> {
  await db.query(`UPDATE ${rid} SET tags = array::distinct((tags ?? []) + $t);`, { t: tags });
}

export async function addPrompt(
  db: Surreal,
  sessionRidStr: string,
  e: RawEvent,
): Promise<void> {
  const tsExpr = e.ts ? "<datetime> $ts" : "NONE";
  await db.query(
    `LET $pr = (CREATE prompt SET role = $role, text = $text, ts = ${tsExpr})[0].id;
     RELATE ${sessionRidStr}->contains->$pr;`,
    { role: e.actor, text: e.text ?? "", ts: e.ts },
  );
}

export async function touchFile(
  db: Surreal,
  sessionRidStr: string,
  filePath: string,
  op: string,
): Promise<void> {
  await db.query(
    `LET $f = (UPSERT file SET path = $path WHERE path = $path RETURN id)[0].id
        ?? (CREATE file SET path = $path)[0].id;
     RELATE ${sessionRidStr}->touched->$f SET op = $op;`,
    { path: filePath, op },
  );
}

export async function setSessionStatus(
  db: Surreal,
  sessionRidStr: string,
  status: SessionStatus,
): Promise<void> {
  await db.query(`UPDATE ${sessionRidStr} SET status = $status;`, { status });
}

export async function setSessionSummary(
  db: Surreal,
  sessionRidStr: string,
  summary: string,
  embedding?: number[],
  title?: string,
): Promise<void> {
  const sets = ["summary = $summary", "summary_embedding = $emb", "status = 'ready'"];
  const params: Record<string, unknown> = { summary, emb: embedding ?? null };
  if (title) {
    sets.push("title = $title");
    params.title = title;
  }
  await db.query(`UPDATE ${sessionRidStr} SET ${sets.join(", ")};`, params);
}
