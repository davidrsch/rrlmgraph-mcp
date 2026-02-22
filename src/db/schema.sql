-- rrlmgraph-mcp SQLite schema
-- Version: 1  (stored in graph_metadata key="schema_version")
--
-- This schema is created by the R package's export_to_sqlite() and read
-- by the TypeScript/Python MCP server.  All DDL uses IF NOT EXISTS so
-- the file can be opened in both fresh and pre-populated states.
--
-- Migration: when rrlmgraph_version in graph_metadata changes and the
-- schema_version is behind the current DDL version, the MCP server runs
-- ADD COLUMN migrations without touching existing data.

-- ─── Core tables ──────────────────────────────────────────────────────────

-- nodes: one row per graph vertex (function, file, package, …)
CREATE TABLE IF NOT EXISTS nodes (
  node_id       TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  file          TEXT,
  node_type     TEXT,           -- "function" | "file" | "package" | …
  signature     TEXT,
  body_text     TEXT,
  roxygen_text  TEXT,
  complexity    REAL,
  pagerank      REAL,
  task_weight   REAL    DEFAULT 0.5,
  embedding     TEXT,           -- JSON float array, e.g. "[0.1, 0.2, …]"
  pkg_name      TEXT,
  pkg_version   TEXT
);

-- edges: one row per directed, typed edge
CREATE TABLE IF NOT EXISTS edges (
  edge_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  TEXT    NOT NULL,
  target_id  TEXT    NOT NULL,
  edge_type  TEXT,              -- CALLS | IMPORTS | TESTS | CO_CHANGES | …
  weight     REAL,
  metadata   TEXT,              -- JSON object for extra attributes
  UNIQUE(source_id, target_id, edge_type)
);

-- task_traces: LLM task interaction log (written by add_task_trace tool)
CREATE TABLE IF NOT EXISTS task_traces (
  trace_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT,
  nodes_json TEXT,              -- JSON array of node_ids
  polarity   REAL    DEFAULT 1.0,
  session_id TEXT,
  created_at TEXT               -- ISO-8601 UTC
);

-- graph_metadata: key/value project configuration
CREATE TABLE IF NOT EXISTS graph_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- tfidf_vocab: TF-IDF vocabulary exported from R so TypeScript can encode
-- queries identically to the R package traversal
CREATE TABLE IF NOT EXISTS tfidf_vocab (
  term        TEXT    PRIMARY KEY,
  idf         REAL,
  doc_count   INTEGER,
  term_count  INTEGER
);

-- ─── FTS5 virtual table ───────────────────────────────────────────────────
-- Used for seed-node discovery when no explicit seed_node is provided.
-- Content table mirrors nodes(body_text); rebuilding is cheap (< 1s for
-- typical packages).
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id    UNINDEXED,
  name,
  body_text,
  roxygen_text,
  content    = "nodes",
  content_rowid = "rowid"
);

-- ─── Standard indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type   ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_nodes_name   ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_trace_dedup
  ON task_traces(query, session_id, created_at);

-- ─── FTS5 triggers: keep nodes_fts in sync with nodes ─────────────────────
CREATE TRIGGER IF NOT EXISTS nodes_fts_insert
  AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, node_id, name, body_text, roxygen_text)
    VALUES (new.rowid, new.node_id, new.name, new.body_text, new.roxygen_text);
  END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_update
  AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, node_id, name, body_text, roxygen_text)
    VALUES ('delete', old.rowid, old.node_id, old.name, old.body_text, old.roxygen_text);
    INSERT INTO nodes_fts(rowid, node_id, name, body_text, roxygen_text)
    VALUES (new.rowid, new.node_id, new.name, new.body_text, new.roxygen_text);
  END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_delete
  AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, node_id, name, body_text, roxygen_text)
    VALUES ('delete', old.rowid, old.node_id, old.name, old.body_text, old.roxygen_text);
  END;
