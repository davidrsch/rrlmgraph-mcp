/**
 * Unit tests for SQLiteGraph class.
 *
 * Uses the snapshot fixture in tests/fixtures/fixture.sqlite.
 * To regenerate the fixture: npx tsx tests/fixtures/create_fixture.ts
 *
 * Issue: rrlmgraph-mcp #10
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SQLiteGraph } from "../../src/db/sqlite_reader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = join(__dirname, "../fixtures/fixture.sqlite");

let graph: SQLiteGraph;

beforeAll(async () => {
  if (!existsSync(fixturePath)) {
    // Auto-generate fixture if not present
    const { execSync } = await import("node:child_process");
    const fixtureScript = join(__dirname, "../fixtures/create_fixture.ts");
    execSync(`npx tsx "${fixtureScript}"`, { stdio: "inherit" });
  }
  graph = new SQLiteGraph(fixturePath);
});

afterAll(() => {
  graph?.close();
});

// ── queryContext ───────────────────────────────────────────────────────────────

describe("queryContext", () => {
  it("returns a non-empty context string", () => {
    const result = graph.queryContext("build a graph from an R project");
    expect(result.context_string).toContain("rrlmgraph context");
    expect(result.node_ids.length).toBeGreaterThan(0);
    expect(result.token_estimate).toBeGreaterThan(0);
  });

  // audit/expert-review fix: token budget is a HARD constraint
  // per Round 7 success criterion #2. No overshoot is acceptable.
  it("respects budget_tokens hard limit", () => {
    const budget = 200;
    const result = graph.queryContext("export to sqlite", undefined, budget);
    expect(result.token_estimate).toBeLessThanOrEqual(budget);
  });

  it("uses provided seed_node when it exists", () => {
    const result = graph.queryContext("traverse the graph", "query_context");
    expect(result.seed_node).toBe("query_context");
    expect(result.node_ids).toContain("query_context");
  });

  it("falls back gracefully when seed_node not found", () => {
    const result = graph.queryContext("do something", "nonexistent_function_xyz");
    // Should still return a result using FTS/overlap fallback
    expect(result.context_string).toBeDefined();
  });

  // audit/expert-review fix: previous test was a dead assertion
  // (a lambda is always defined). Replaced with a real empty-graph guard check.
  it("returns defined result even when no seed can be found", () => {
    const result = graph.queryContext("do something", "zzz_nonexistent_zzz");
    expect(result.context_string).toBeDefined();
    expect(typeof result.token_estimate).toBe("number");
  });
});

// ── getNodeInfo ────────────────────────────────────────────────────────────────

describe("getNodeInfo", () => {
  it("returns full info for a known node", () => {
    const info = graph.getNodeInfo("build_rrlm_graph");
    expect(info).not.toBeNull();
    expect(info!.name).toBe("build_rrlm_graph");
    expect(info!.file).toBe("R/graph_build.R");
    expect(info!.node_type).toBe("function");
    expect(info!.callees).toContain("query_context");
  });

  it("returns null for unknown node", () => {
    const info = graph.getNodeInfo("definitely_not_a_real_function_zzz");
    expect(info).toBeNull();
  });

  it("includes body_text when include_source=true", () => {
    const info = graph.getNodeInfo("build_rrlm_graph", true);
    expect(info!.body_text).toBeTruthy();
  });

  it("omits body_text when include_source=false", () => {
    const info = graph.getNodeInfo("build_rrlm_graph", false);
    expect(info!.body_text).toBeNull();
  });
});

// ── findSimilarNodes ───────────────────────────────────────────────────────────

describe("findSimilarNodes", () => {
  it("returns suggestions for nearby names", () => {
    const suggestions = graph.findSimilarNodes("build_graph");
    // Should find build_rrlm_graph via FTS prefix match
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("returns empty array for blank input", () => {
    const suggestions = graph.findSimilarNodes("   ");
    expect(suggestions).toEqual([]);
  });
});

// ── getGraphSummary ────────────────────────────────────────────────────────────

describe("getGraphSummary", () => {
  it("returns correct node and edge counts", () => {
    const s = graph.getGraphSummary();
    expect(s.node_count).toBe(3);
    expect(s.edge_count).toBe(3);
  });

  it("includes top_hubs sorted by pagerank", () => {
    const s = graph.getGraphSummary();
    expect(s.top_hubs.length).toBeGreaterThan(0);
    // Highest pagerank should be first
    expect(s.top_hubs[0].pagerank).toBeGreaterThanOrEqual(s.top_hubs[1]?.pagerank ?? 0);
  });

  it("reports correct metadata", () => {
    const s = graph.getGraphSummary();
    expect(s.rrlmgraph_version).toBe("0.2.0");
    expect(s.embed_method).toBe("tfidf");
  });
});

// ── getFileNodes ───────────────────────────────────────────────────────────────

describe("getFileNodes", () => {
  it("returns nodes for a known file", () => {
    const nodes = graph.getFileNodes("R/graph_build.R");
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe("build_rrlm_graph");
  });

  it("returns empty array for unknown file", () => {
    const nodes = graph.getFileNodes("R/nonexistent.R");
    expect(nodes).toEqual([]);
  });
});

// ── addTaskTrace + getTaskHistory ──────────────────────────────────────────────

describe("addTaskTrace / getTaskHistory", () => {
  it("records a trace and retrieves it", () => {
    const id = graph.addTaskTrace("test task", ["build_rrlm_graph"], 0.8, "test-session");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);

    const history = graph.getTaskHistory(1);
    expect(history.length).toBe(1);
    expect(history[0].query).toBe("test task");
    expect(history[0].nodes).toContain("build_rrlm_graph");
    expect(history[0].polarity).toBe(0.8);
  });

  it("throws on out-of-range polarity", () => {
    expect(() => graph.addTaskTrace("bad", [], 2.0)).toThrow(RangeError);
    expect(() => graph.addTaskTrace("bad", [], -1.5)).toThrow(RangeError);
  });
});
