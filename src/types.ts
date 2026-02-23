/**
 * Shared TypeScript types for rrlmgraph-mcp.
 * These mirror the SQLite schema defined in src/db/schema.sql.
 */

export interface NodeRow {
  node_id: string;
  name: string;
  file: string | null;
  node_type: string | null;
  signature: string | null;
  body_text: string | null;
  roxygen_text: string | null;
  complexity: number | null;
  pagerank: number | null;
  task_weight: number | null;
  embedding: string | null; // JSON float array
  pkg_name: string | null;
  pkg_version: string | null;
}

export interface EdgeRow {
  edge_id: number;
  source_id: string;
  target_id: string;
  edge_type: string | null;
  weight: number | null;
  metadata: string | null; // JSON object
}

export interface TaskTraceRow {
  trace_id: number;
  query: string | null;
  nodes_json: string | null; // JSON array of node_ids
  polarity: number;
  session_id: string | null;
  created_at: string | null;
}

export interface TfidfVocabRow {
  term: string;
  idf: number;
  doc_count: number;
  term_count: number;
}

export interface GraphMetadataRow {
  key: string;
  value: string;
}

// ── Result types returned by SQLiteGraph methods ──────────────────────────

export interface NodeInfo {
  node_id: string;
  name: string;
  file: string | null;
  node_type: string | null;
  signature: string | null;
  body_text: string | null;
  roxygen_text: string | null;
  complexity: number | null;
  pagerank: number | null;
  task_weight: number | null;
  pkg_name: string | null;
  pkg_version: string | null;
  callers: string[];
  callees: string[];
  tests: string[];
}

export interface ContextResult {
  context_string: string;
  node_ids: string[];
  token_estimate: number;
  seed_node: string | null;
  /**
   * Describes the retrieval path actually used for this query.
   *
   * - `"tfidf_cosine"` — TF-IDF vocab was available and the query was
   *   re-ranked using cosine similarity.
   * - `"fts5_fallback"` — vocab was empty (e.g. graph built with
   *   `embed_method = "ollama"`) but an FTS5 seed node was found.
   * - `"pagerank_only"` — no embedding and no FTS5 match; results are
   *   ordered by PageRank only.
   */
  retrieval_mode: "tfidf_cosine" | "fts5_fallback" | "pagerank_only";
}

export interface GraphSummary {
  node_count: number;
  edge_count: number;
  node_types: Record<string, number>;
  edge_types: Record<string, number>;
  top_hubs: Array<{ name: string; pagerank: number }>;
  build_time: string | null;
  rrlmgraph_version: string | null;
  embed_method: string | null;
  project_root: string | null;
}

export interface TaskTrace {
  trace_id: number;
  query: string | null;
  nodes: string[];
  polarity: number;
  session_id: string | null;
  created_at: string | null;
}
