/**
 * Creates a minimal SQLite fixture for unit tests.
 *
 * Run once with:  npx tsx tests/fixtures/create_fixture.ts
 *
 * The resulting fixture.sqlite is committed to the repo so that
 * tests can run without R or a live graph build.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturePath = join(__dirname, "fixture.sqlite");
mkdirSync(__dirname, { recursive: true });

const db = new Database(fixturePath);
db.pragma("journal_mode = WAL");

// Apply schema
const schemaPath = join(__dirname, "../../src/db/schema.sql");
const schema = readFileSync(schemaPath, "utf8");
db.exec(schema);

// Nodes
const insertNode = db.prepare(`
  INSERT OR REPLACE INTO nodes
    (node_id, name, file, node_type, signature, body_text, roxygen_text,
     complexity, pagerank, task_weight, embedding, pkg_name, pkg_version)
  VALUES
    (@node_id, @name, @file, @node_type, @signature, @body_text, @roxygen_text,
     @complexity, @pagerank, @task_weight, @embedding, @pkg_name, @pkg_version)
`);

const nodes = [
  {
    node_id: "build_rrlm_graph",
    name: "build_rrlm_graph",
    file: "R/graph_build.R",
    node_type: "function",
    signature: "build_rrlm_graph(project_path, embed_method = 'tfidf', cache = TRUE)",
    body_text: "function(project_path, embed_method = 'tfidf', cache = TRUE) {\n  # builds the graph\n}",
    roxygen_text: "@title Build an rrlm_graph\\n@param project_path Path to the R project root.",
    complexity: 12,
    pagerank: 0.08,
    task_weight: 0.7,
    embedding: JSON.stringify(Array.from({ length: 8 }, (_, i) => 0.1 * (i + 1))),
    pkg_name: "rrlmgraph",
    pkg_version: "0.2.0",
  },
  {
    node_id: "query_context",
    name: "query_context",
    file: "R/graph_traverse.R",
    node_type: "function",
    signature: "query_context(graph, query, budget_tokens = 6000)",
    body_text: "function(graph, query, budget_tokens = 6000) {\n  # BFS traversal\n}",
    roxygen_text: "@title Query context\\n@param graph An rrlm_graph object.",
    complexity: 8,
    pagerank: 0.07,
    task_weight: 0.65,
    embedding: JSON.stringify(Array.from({ length: 8 }, (_, i) => 0.05 * (i + 2))),
    pkg_name: "rrlmgraph",
    pkg_version: "0.2.0",
  },
  {
    node_id: "export_to_sqlite",
    name: "export_to_sqlite",
    file: "R/cache.R",
    node_type: "function",
    signature: "export_to_sqlite(graph, db_path)",
    body_text: "function(graph, db_path) {\n  # exports to SQLite\n}",
    roxygen_text: "@title Export graph to SQLite\\n@param graph The graph to export.",
    complexity: 6,
    pagerank: 0.05,
    task_weight: 0.5,
    embedding: JSON.stringify(Array.from({ length: 8 }, (_, i) => 0.03 * (i + 1))),
    pkg_name: "rrlmgraph",
    pkg_version: "0.2.0",
  },
];

for (const n of nodes) {
  insertNode.run(n);
}

// Edges
const insertEdge = db.prepare(`
  INSERT OR IGNORE INTO edges(source_id, target_id, edge_type, weight)
  VALUES(@source_id, @target_id, @edge_type, @weight)
`);
insertEdge.run({ source_id: "build_rrlm_graph", target_id: "query_context", edge_type: "CALLS", weight: 1.0 });
insertEdge.run({ source_id: "build_rrlm_graph", target_id: "export_to_sqlite", edge_type: "CALLS", weight: 1.0 });
insertEdge.run({ source_id: "query_context", target_id: "build_rrlm_graph", edge_type: "CALLS", weight: 0.5 });

// TF-IDF vocab
const insertVocab = db.prepare(
  "INSERT OR REPLACE INTO tfidf_vocab(term, idf, doc_count, term_count) VALUES(?,?,?,?)"
);
const vocab = [
  ["build", 0.4, 3, 5],
  ["graph", 0.3, 3, 8],
  ["query", 0.5, 2, 3],
  ["context", 0.6, 2, 4],
  ["export", 0.8, 1, 2],
  ["sqlite", 0.9, 1, 1],
  ["traverse", 1.0, 1, 2],
];
for (const [term, idf, dc, tc] of vocab) {
  insertVocab.run(term, idf, dc, tc);
}

// Metadata
const insertMeta = db.prepare(
  "INSERT OR REPLACE INTO graph_metadata(key, value) VALUES(?,?)"
);
insertMeta.run("rrlmgraph_version", "0.2.0");
insertMeta.run("embed_method", "tfidf");
insertMeta.run("project_root", "/tmp/test_project");
insertMeta.run("build_time", new Date().toISOString());
insertMeta.run("schema_version", "1");

// FTS rebuild
try {
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
} catch {
  // FTS triggers may have already populated it
}

db.close();
console.log(`Fixture created: ${fixturePath}`);
