/**
 * SQLiteGraph — pure TypeScript BFS traversal of an rrlmgraph SQLite export.
 *
 * No R subprocess required.  All queries run directly against the SQLite
 * file produced by rrlmgraph::export_to_sqlite().
 *
 * Issue: rrlmgraph-mcp #2
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";
import type {
  NodeRow,
  EdgeRow,
  TaskTraceRow,
  TfidfVocabRow,
  GraphMetadataRow,
  NodeInfo,
  ContextResult,
  GraphSummary,
  TaskTrace,
} from "../types.js";

// ── Inlined schema (avoids dist/schema.sql lookup in bundled binary) ─────────
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS nodes (
  node_id       TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  file          TEXT,
  node_type     TEXT,
  signature     TEXT,
  body_text     TEXT,
  roxygen_text  TEXT,
  complexity    REAL,
  pagerank      REAL,
  task_weight   REAL    DEFAULT 0.5,
  embedding     TEXT,
  pkg_name      TEXT,
  pkg_version   TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  edge_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  TEXT    NOT NULL,
  target_id  TEXT    NOT NULL,
  edge_type  TEXT,
  weight     REAL,
  metadata   TEXT,
  UNIQUE(source_id, target_id, edge_type)
);
CREATE TABLE IF NOT EXISTS task_traces (
  trace_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  query      TEXT,
  nodes_json TEXT,
  polarity   REAL    DEFAULT 1.0,
  session_id TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS graph_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS tfidf_vocab (
  term        TEXT    PRIMARY KEY,
  idf         REAL,
  doc_count   INTEGER,
  term_count  INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  node_id    UNINDEXED,
  name,
  body_text,
  roxygen_text,
  content    = "nodes",
  content_rowid = "rowid"
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type   ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_nodes_name   ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(file);
CREATE INDEX IF NOT EXISTS idx_trace_dedup
  ON task_traces(query, session_id, created_at);
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
`;

// ── Token counting (approximation) ──────────────────────────────────────────

/**
 * Rough token estimate: ~3.5 chars per token for R source code.
 * Good enough for budget enforcement; API calls provide exact counts.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── TF-IDF query encoding ────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** @internal Exported for unit testing only. */
export function buildQueryVector(
  query: string,
  vocab: Map<string, TfidfVocabRow>
): Map<string, number> {
  const tokens = tokenize(query);
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  const result = new Map<string, number>();
  for (const [term, count] of tf) {
    const row = vocab.get(term);
    if (row) {
      // Log-normalised TF to match text2vec's default encoding:
      //   TF(t, q) = log(1 + count(t, q)) / log(1 + |q|)
      // Proportional raw TF (count / |q|) diverges on short queries and
      // does not reproduce the IDF weighting expected by the R side.
      // See rrlmgraph-mcp#13.
      const logTf = Math.log(1 + count) / Math.log(1 + tokens.length);
      result.set(term, logTf * row.idf);
    }
  }
  return result;
}

// ── SQLiteGraph class ────────────────────────────────────────────────────────

export class SQLiteGraph {
  private db: Database.Database;
  private tfidfVocab: Map<string, TfidfVocabRow> = new Map();
  private schemaApplied = false;

  constructor(dbPath: string) {
    this.db = new Database(resolve(dbPath), { readonly: false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this._ensureSchema();
    this._loadVocab();
  }

  // ── Schema bootstrap ──────────────────────────────────────────────────────

  private _ensureSchema(): void {
    if (this.schemaApplied) return;
    // Schema is inlined — no file I/O needed in the bundled binary
    this.db.exec(SCHEMA_SQL);
    this._runMigrations();
    this.schemaApplied = true;
  }

  private _runMigrations(): void {
    const currentVersion = this._getMeta("schema_version") ?? "0";
    const targetVersion = "1";
    if (currentVersion === targetVersion) return;

    // v0 → v1: add embedding column to nodes if missing
    const cols = this.db.pragma("table_info(nodes)") as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    if (!colNames.includes("embedding")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN embedding TEXT");
    }
    if (!colNames.includes("task_weight")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN task_weight REAL DEFAULT 0.5");
    }
    // Rebuild FTS index after potential schema change
    try {
      this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
    } catch {
      // FTS may not exist in old DBs; ignore
    }

    this._setMeta("schema_version", targetVersion);
  }

  // ── Metadata helpers ──────────────────────────────────────────────────────

  private _getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM graph_metadata WHERE key = ?")
      .get(key) as GraphMetadataRow | undefined;
    return row?.value ?? null;
  }

  private _setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO graph_metadata(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(key, value);
  }

  // ── Vocab ────────────────────────────────────────────────────────────────

  private _loadVocab(): void {
    try {
      const rows = this.db
        .prepare("SELECT * FROM tfidf_vocab")
        .all() as TfidfVocabRow[];
      this.tfidfVocab = new Map(rows.map((r) => [r.term, r]));
    } catch {
      // Table may not exist in older exports
    }
  }

  // ── Seed node discovery ──────────────────────────────────────────────────

  /**
   * Find the best seed node for a query.
   * 1. If seed_node is provided and exists, use it.
   * 2. Try FTS5 full-text search on body_text + name.
   * 3. Fall back to TF-IDF term overlap against node names.
   */
  private _findSeedNode(
    query: string,
    seedNodeName?: string
  ): string | null {
    if (seedNodeName) {
      const row = this.db
        .prepare("SELECT node_id FROM nodes WHERE name = ? LIMIT 1")
        .get(seedNodeName) as { node_id: string } | undefined;
      if (row) return row.node_id;
    }

    // FTS5 search
    try {
      const ftsQuery = tokenize(query).slice(0, 10).join(" OR ");
      if (ftsQuery) {
        const row = this.db
          .prepare(
            `SELECT n.node_id FROM nodes_fts f
             JOIN nodes n ON n.rowid = f.rowid
             WHERE nodes_fts MATCH ?
             ORDER BY rank
             LIMIT 1`
          )
          .get(ftsQuery) as { node_id: string } | undefined;
        if (row) return row.node_id;
      }
    } catch {
      // FTS not available (old DB without virtual table)
    }

    // TF-IDF term-overlap fallback: match query tokens against node names
    const tokens = new Set(tokenize(query));
    const rows = this.db
      .prepare("SELECT node_id, name, pagerank FROM nodes ORDER BY pagerank DESC LIMIT 200")
      .all() as Array<{ node_id: string; name: string; pagerank: number }>;

    let bestScore = 0;
    let bestId: string | null = null;
    for (const row of rows) {
      const nameTokens = tokenize(row.name);
      const overlap = nameTokens.filter((t) => tokens.has(t)).length;
      const score = overlap + (row.pagerank ?? 0);
      if (score > bestScore) {
        bestScore = score;
        bestId = row.node_id;
      }
    }
    if (bestId) return bestId;

    // Last resort: highest pagerank node
    const top = this.db
      .prepare(
        "SELECT node_id FROM nodes ORDER BY pagerank DESC NULLS LAST LIMIT 1"
      )
      .get() as { node_id: string } | undefined;
    return top?.node_id ?? null;
  }

  // ── BFS traversal ────────────────────────────────────────────────────────

  /**
   * BFS SQL using UNION (not UNION ALL) — SQLite recursive CTEs prohibit
   * referencing the CTE name in nested sub-selects (NOT EXISTS guard),
   * so we rely on UNION's built-in deduplication to avoid cycles.
   * The outer GROUP BY picks the minimum depth per node.
   */
  private static readonly BFS_SQL = `
    WITH RECURSIVE bfs(node_id, depth) AS (
      SELECT @seed_node AS node_id, 0 AS depth

      UNION

      SELECT e.target_id, bfs.depth + 1
      FROM   edges e
      JOIN   bfs   ON e.source_id = bfs.node_id
      WHERE  bfs.depth < @max_depth
    )
    SELECT n.*, MIN(bfs.depth) AS depth
    FROM   bfs
    JOIN   nodes n ON n.node_id = bfs.node_id
    GROUP  BY n.node_id
    ORDER  BY depth ASC, n.pagerank DESC
    LIMIT  @max_nodes;
  `;

  /**
   * Query the graph for relevant context.
   *
   * 1. Find seed node (from explicit name, FTS, or TF-IDF fallback).
   * 2. Run recursive BFS CTE in SQLite.
   * 3. Re-rank: cosine similarity against query embedding (when available),
   *    weighted with pagerank and task_weight.
   * 4. Assemble context string within budgetTokens.
   */
  queryContext(
    query: string,
    seedNodeName?: string,
    budgetTokens: number = 6000,
    maxDepth: number = 3,
    maxNodes: number = 80
  ): ContextResult {
    const seedId = this._findSeedNode(query, seedNodeName);

    if (!seedId) {
      return {
        context_string: "# No graph data available.\n",
        node_ids: [],
        token_estimate: 0,
        seed_node: null,
      };
    }

    const stmt = this.db.prepare(SQLiteGraph.BFS_SQL);
    const bfsNodes = stmt.all({
      seed_node: seedId,
      max_depth: maxDepth,
      max_nodes: maxNodes,
    }) as Array<NodeRow & { depth: number }>;

    // Build query TF-IDF vector for cosine re-ranking
    const qVec = buildQueryVector(query, this.tfidfVocab);
    const qVecArr =
      qVec.size > 0
        ? Array.from(qVec.values())
        : null;

    // Score each node
    const scored = bfsNodes.map((node) => {
      let semScore = 0;
      if (node.embedding && qVecArr) {
        try {
          const emb: number[] = JSON.parse(node.embedding);
          semScore = cosineSimilarity(qVecArr, emb.slice(0, qVecArr.length));
        } catch {
          /* ignore parse errors */
        }
      }
      const pagerank = node.pagerank ?? 0;
      const tw = node.task_weight ?? 0.5;
      // audit/expert-review fix: restore agreed weights from
      // implementation_plan.md §compute_relevance:
      //   0.40 * sem_sim + 0.25 * centrality + 0.25 * trace_score + 0.10 * co_change
      // CO_CHANGES are deferred; depth_penalty is used as a structural proxy.
      const depthPenalty = 1 / (1 + node.depth * 0.5);
      const score =
        0.4 * semScore + 0.25 * pagerank + 0.25 * tw + 0.1 * depthPenalty;
      return { node, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Assemble context string within budget
    const chunks: string[] = [];
    const usedIds: string[] = [];
    let usedTokens = 0;

    for (const { node } of scored) {
      const chunk = this._formatNodeContext(node);
      const chunkTokens = estimateTokens(chunk);
      if (usedTokens + chunkTokens > budgetTokens) break;
      chunks.push(chunk);
      usedIds.push(node.node_id);
      usedTokens += chunkTokens;
    }

    const header = `# rrlmgraph context\n# Query: ${query}\n# Nodes: ${usedIds.length} | Tokens: ~${usedTokens}\n\n`;
    const context_string = header + chunks.join("\n---\n");

    return {
      context_string,
      node_ids: usedIds,
      token_estimate: usedTokens,
      seed_node: seedId,
    };
  }

  // audit/expert-review fix: include callers/callees in compressed
  // Φ(v) format per implementation_plan.md §assemble_context_string.
  private _formatNodeContext(node: NodeRow): string {
    const lines: string[] = [];
    const type = node.node_type ?? "node";
    const file = node.file ? ` [${node.file}]` : "";
    lines.push(`## ${node.name}  <${type}>${file}`);
    if (node.signature) lines.push(`**Signature**: \`${node.signature}\``);
    if (node.roxygen_text) {
      lines.push("**Documentation**:");
      lines.push(node.roxygen_text.slice(0, 400));
    }
    // Callers / callees — part of compressed Φ(v) format
    const callees = (
      this.db
        .prepare(
          `SELECT n.name FROM edges e
           JOIN nodes n ON n.node_id = e.target_id
           WHERE e.source_id = ? AND e.edge_type = 'CALLS'
           LIMIT 10`
        )
        .all(node.node_id) as Array<{ name: string }>
    ).map((r) => r.name);
    const callers = (
      this.db
        .prepare(
          `SELECT n.name FROM edges e
           JOIN nodes n ON n.node_id = e.source_id
           WHERE e.target_id = ? AND e.edge_type = 'CALLS'
           LIMIT 10`
        )
        .all(node.node_id) as Array<{ name: string }>
    ).map((r) => r.name);
    if (callees.length > 0) lines.push(`**Calls**: ${callees.join(", ")}`);
    if (callers.length > 0) lines.push(`**Called by**: ${callers.join(", ")}`);
    if (node.body_text) {
      lines.push("```r");
      lines.push(node.body_text.slice(0, 1200));
      lines.push("```");
    }
    return lines.join("\n");
  }

  // ── getNodeInfo ───────────────────────────────────────────────────────────

  getNodeInfo(nodeName: string, includeSource: boolean = false): NodeInfo | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE name = ? LIMIT 1")
      .get(nodeName) as NodeRow | undefined;

    if (!row) return null;

    // Callers: nodes that have a CALLS edge targeting this node
    const callers = (
      this.db
        .prepare(
          `SELECT n.name FROM edges e
           JOIN nodes n ON n.node_id = e.source_id
           WHERE e.target_id = ? AND e.edge_type = 'CALLS'
           LIMIT 20`
        )
        .all(row.node_id) as Array<{ name: string }>
    ).map((r) => r.name);

    // Callees: nodes that this node calls
    const callees = (
      this.db
        .prepare(
          `SELECT n.name FROM edges e
           JOIN nodes n ON n.node_id = e.target_id
           WHERE e.source_id = ? AND e.edge_type = 'CALLS'
           LIMIT 20`
        )
        .all(row.node_id) as Array<{ name: string }>
    ).map((r) => r.name);

    // Tests: test nodes that test this node
    const tests = (
      this.db
        .prepare(
          `SELECT n.name FROM edges e
           JOIN nodes n ON n.node_id = e.source_id
           WHERE e.target_id = ? AND e.edge_type = 'TESTS'
           LIMIT 20`
        )
        .all(row.node_id) as Array<{ name: string }>
    ).map((r) => r.name);

    return {
      node_id: row.node_id,
      name: row.name,
      file: row.file,
      node_type: row.node_type,
      signature: row.signature,
      body_text: includeSource ? row.body_text : null,
      roxygen_text: row.roxygen_text,
      complexity: row.complexity,
      pagerank: row.pagerank,
      task_weight: row.task_weight,
      pkg_name: row.pkg_name,
      pkg_version: row.pkg_version,
      callers,
      callees,
      tests,
    };
  }

  /** Find similar node names when requested node is not found. */
  /**
   * Find nodes whose name contains all word-tokens of `name` as substrings.
   * Splits on non-alphanumeric characters (underscores, hyphens, dots, etc.)
   * before building per-segment LIKE clauses, so that e.g. "build_graph"
   * (tokens: ["build","graph"]) matches "build_rrlm_graph".
   */
  findSimilarNodes(name: string, limit: number = 5): string[] {
    if (!name.trim()) return [];
    try {
      // Split search term into word segments
      const parts = name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1);

      const segments = parts.length > 0 ? parts : [name];

      // Build: WHERE name LIKE '%seg1%' AND name LIKE '%seg2%' …
      const conditions = segments
        .map(() => "name LIKE ?")
        .join(" AND ");
      const likeParams: unknown[] = segments.map(
        (s) => `%${s.replace(/[\\%]/g, "\\$&")}%`
      );

      const rows = this.db
        .prepare(
          `SELECT name FROM nodes
           WHERE  ${conditions}
           ORDER  BY pagerank DESC
           LIMIT  ?`
        )
        .all(...likeParams, limit) as Array<{ name: string }>;

      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  // ── getGraphSummary ───────────────────────────────────────────────────────

  getGraphSummary(): GraphSummary {
    const nodeCount = (
      this.db.prepare("SELECT COUNT(*) as c FROM nodes").get() as { c: number }
    ).c;
    const edgeCount = (
      this.db.prepare("SELECT COUNT(*) as c FROM edges").get() as { c: number }
    ).c;

    const nodeTypes = Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT node_type, COUNT(*) as c FROM nodes GROUP BY node_type"
          )
          .all() as Array<{ node_type: string; c: number }>
      ).map((r) => [r.node_type ?? "unknown", r.c])
    );

    const edgeTypes = Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT edge_type, COUNT(*) as c FROM edges GROUP BY edge_type"
          )
          .all() as Array<{ edge_type: string; c: number }>
      ).map((r) => [r.edge_type ?? "unknown", r.c])
    );

    const topHubs = (
      this.db
        .prepare(
          "SELECT name, pagerank FROM nodes ORDER BY pagerank DESC NULLS LAST LIMIT 10"
        )
        .all() as Array<{ name: string; pagerank: number }>
    ).map((r) => ({ name: r.name, pagerank: r.pagerank ?? 0 }));

    return {
      node_count: nodeCount,
      edge_count: edgeCount,
      node_types: nodeTypes,
      edge_types: edgeTypes,
      top_hubs: topHubs,
      build_time: this._getMeta("build_time"),
      rrlmgraph_version: this._getMeta("rrlmgraph_version"),
      embed_method: this._getMeta("embed_method"),
      project_root: this._getMeta("project_root"),
    };
  }

  // ── getFileNodes ──────────────────────────────────────────────────────────

  getFileNodes(filePath: string): NodeInfo[] {
    const decoded = decodeURIComponent(filePath);
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE file = ? OR file LIKE ?")
      .all(decoded, `%${decoded}`) as NodeRow[];
    return rows.map((r) => ({
      node_id: r.node_id,
      name: r.name,
      file: r.file,
      node_type: r.node_type,
      signature: r.signature,
      body_text: r.body_text,
      roxygen_text: r.roxygen_text,
      complexity: r.complexity,
      pagerank: r.pagerank,
      task_weight: r.task_weight,
      pkg_name: r.pkg_name,
      pkg_version: r.pkg_version,
      callers: [],
      callees: [],
      tests: [],
    }));
  }

  // ── getTaskHistory ────────────────────────────────────────────────────────

  getTaskHistory(maxEntries: number = 20): TaskTrace[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM task_traces ORDER BY trace_id DESC LIMIT ?"
      )
      .all(maxEntries) as TaskTraceRow[];

    return rows.map((r) => ({
      trace_id: r.trace_id,
      query: r.query,
      nodes: (() => {
        try {
          return JSON.parse(r.nodes_json ?? "[]") as string[];
        } catch {
          return [];
        }
      })(),
      polarity: r.polarity,
      session_id: r.session_id,
      created_at: r.created_at,
    }));
  }

  // ── addTaskTrace ──────────────────────────────────────────────────────────

  addTaskTrace(
    query: string,
    nodes: string[],
    polarity: number = 0,
    sessionId?: string
  ): number {
    if (polarity < -1 || polarity > 1) {
      throw new RangeError(`polarity must be in [-1, 1], got ${polarity}`);
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO task_traces(query, nodes_json, polarity, session_id, created_at)
         VALUES(?, ?, ?, ?, ?)`
      )
      .run(query, JSON.stringify(nodes), polarity, sessionId ?? null, now);
    return result.lastInsertRowid as number;
  }

  // ── reload (after rebuild_graph) ─────────────────────────────────────────

  /** Reload vocabulary after R rebuilds the graph. */
  reload(): void {
    this._loadVocab();
  }

  // ── close ─────────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
