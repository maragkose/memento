/**
 * Labeled Property Graph schema for SurrealDB.
 *
 * Node tables + graph edges (created via RELATE at ingest time) + vector/full-text
 * indexes for hybrid GraphRAG retrieval. Idempotent: safe to run on every startup.
 *
 * NOTE: embedding dimension defaults to 768 (nomic-embed-text). Change EMBED_DIM to
 * match your embedding model before creating vector indexes.
 */
import type { Surreal } from "surrealdb";
import { log } from "./log.ts";

export const EMBED_DIM = 768;

const DDL = /* surql */ `
-- ---------- analyzers ----------
DEFINE ANALYZER IF NOT EXISTS cm_text TOKENIZERS blank,class,camel FILTERS lowercase,ascii;

-- ---------- node tables ----------
DEFINE TABLE IF NOT EXISTS project SCHEMALESS;
DEFINE FIELD IF NOT EXISTS name ON project TYPE string;
DEFINE FIELD IF NOT EXISTS slug ON project TYPE string;
DEFINE FIELD IF NOT EXISTS path ON project TYPE option<string>;
DEFINE INDEX IF NOT EXISTS project_slug ON project FIELDS slug UNIQUE;

DEFINE TABLE IF NOT EXISTS repo SCHEMALESS;
DEFINE FIELD IF NOT EXISTS remote ON repo TYPE option<string>;
DEFINE FIELD IF NOT EXISTS root_path ON repo TYPE option<string>;

DEFINE TABLE IF NOT EXISTS file SCHEMALESS;
DEFINE FIELD IF NOT EXISTS path ON file TYPE string;
DEFINE FIELD IF NOT EXISTS language ON file TYPE option<string>;

-- Standalone notes/files (not AI sessions): searchable by title + content.
DEFINE TABLE IF NOT EXISTS document SCHEMALESS;
DEFINE FIELD IF NOT EXISTS path ON document TYPE string;
DEFINE FIELD IF NOT EXISTS title ON document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content ON document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS project ON document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS ext ON document TYPE option<string>;
DEFINE FIELD IF NOT EXISTS bytes ON document TYPE option<number>;
DEFINE FIELD IF NOT EXISTS source_mtime ON document TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS pinned ON document TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS tags ON document TYPE option<array<string>>;
DEFINE INDEX IF NOT EXISTS document_path ON document FIELDS path UNIQUE;
DEFINE INDEX IF NOT EXISTS document_ft_content ON document FIELDS content FULLTEXT ANALYZER cm_text BM25;
DEFINE INDEX IF NOT EXISTS document_ft_title ON document FIELDS title FULLTEXT ANALYZER cm_text BM25;

DEFINE TABLE IF NOT EXISTS command SCHEMALESS;
DEFINE FIELD IF NOT EXISTS text ON command TYPE string;
DEFINE INDEX IF NOT EXISTS command_ft ON command FIELDS text FULLTEXT ANALYZER cm_text BM25;

DEFINE TABLE IF NOT EXISTS prompt SCHEMALESS;
DEFINE FIELD IF NOT EXISTS role ON prompt TYPE string;
DEFINE FIELD IF NOT EXISTS text ON prompt TYPE string;
DEFINE FIELD IF NOT EXISTS ts ON prompt TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS prompt_ft ON prompt FIELDS text FULLTEXT ANALYZER cm_text BM25;

DEFINE TABLE IF NOT EXISTS decision SCHEMALESS;
DEFINE FIELD IF NOT EXISTS text ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS kind ON decision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS confidence ON decision TYPE option<number>;
DEFINE INDEX IF NOT EXISTS decision_ft ON decision FIELDS text FULLTEXT ANALYZER cm_text BM25;

-- Git commits: searchable by message, linked to files (changed) + project.
DEFINE TABLE IF NOT EXISTS commit SCHEMALESS;
DEFINE FIELD IF NOT EXISTS hash ON commit TYPE string;
DEFINE FIELD IF NOT EXISTS message ON commit TYPE string;
DEFINE FIELD IF NOT EXISTS author ON commit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS branch ON commit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS repo ON commit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS project ON commit TYPE option<string>;
DEFINE FIELD IF NOT EXISTS committed_at ON commit TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS commit_ft ON commit FIELDS message FULLTEXT ANALYZER cm_text BM25;

DEFINE TABLE IF NOT EXISTS person SCHEMALESS;
DEFINE FIELD IF NOT EXISTS email ON person TYPE option<string>;

DEFINE TABLE IF NOT EXISTS tool_call SCHEMALESS;
DEFINE FIELD IF NOT EXISTS name ON tool_call TYPE string;

DEFINE TABLE IF NOT EXISTS session SCHEMALESS;
DEFINE FIELD IF NOT EXISTS tool ON session TYPE string;
DEFINE FIELD IF NOT EXISTS external_id ON session TYPE string;
DEFINE FIELD IF NOT EXISTS project ON session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS title ON session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS summary ON session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON session TYPE string DEFAULT 'raw';
DEFINE FIELD IF NOT EXISTS started_at ON session TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS ended_at ON session TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS source_mtime ON session TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS pinned ON session TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS tags ON session TYPE option<array<string>>;
DEFINE INDEX IF NOT EXISTS session_uident ON session FIELDS tool, external_id UNIQUE;
DEFINE INDEX IF NOT EXISTS session_ft ON session FIELDS summary FULLTEXT ANALYZER cm_text BM25;

-- ---------- edges (relations) ----------
-- Defined explicitly so DELETE/clear works even on a fresh namespace.
DEFINE TABLE IF NOT EXISTS about TYPE RELATION;
DEFINE TABLE IF NOT EXISTS contains TYPE RELATION;
DEFINE TABLE IF NOT EXISTS touched TYPE RELATION;
DEFINE TABLE IF NOT EXISTS decided TYPE RELATION;
DEFINE TABLE IF NOT EXISTS changed TYPE RELATION;
`;

/**
 * Vector (HNSW) indexes are defined separately so EMBED_DIM can be templated.
 * Only meaningful once embeddings are populated.
 */
function vectorDDL(dim: number): string {
  return /* surql */ `
DEFINE INDEX IF NOT EXISTS session_vec ON session FIELDS summary_embedding HNSW DIMENSION ${dim} DIST COSINE;
DEFINE INDEX IF NOT EXISTS prompt_vec ON prompt FIELDS text_embedding HNSW DIMENSION ${dim} DIST COSINE;
DEFINE INDEX IF NOT EXISTS decision_vec ON decision FIELDS text_embedding HNSW DIMENSION ${dim} DIST COSINE;
DEFINE INDEX IF NOT EXISTS document_vec ON document FIELDS content_embedding HNSW DIMENSION ${dim} DIST COSINE;
`;
}

export async function applySchema(db: Surreal, opts: { withVectors?: boolean } = {}): Promise<void> {
  await db.query(DDL);
  if (opts.withVectors) await db.query(vectorDDL(EMBED_DIM));
  log.debug(`schema applied${opts.withVectors ? " (incl. vector indexes)" : ""}`);
}
