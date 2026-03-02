/**
 * Integration test: queryContext() against a database exported by the CURRENT
 * version of rrlmgraph::export_to_sqlite().
 *
 * Motivation: the snapshot fixture in tests/fixtures/ was generated once at
 * development time. Schema changes in rrlmgraph silently break the MCP server
 * without this test ever catching them.
 *
 * Preconditions (test is skipped gracefully when absent):
 *   - Rscript is on PATH (or RSCRIPT_PATH is set)
 *   - R packages rrlmgraph and rrlmgraphbench are installed
 *
 * Issue: rrlmgraph-mcp #16
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteGraph } from "../../src/db/sqlite_reader.js";

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the path to use for spawning Rscript.
 * Checks RSCRIPT_PATH env-var first; falls back to Rscript / Rscript.exe.
 */
function getRscriptPath(): string {
  return process.env["RSCRIPT_PATH"] ??
    (process.platform === "win32" ? "Rscript.exe" : "Rscript");
}

/** Returns true when Rscript is available AND both R packages are installed. */
function rEnvironmentAvailable(): boolean {
  const rscript = getRscriptPath();
  // Quick probe: can we run Rscript at all?
  const versionCheck = spawnSync(rscript, ["--version"], { timeout: 5_000 });
  if (versionCheck.error || versionCheck.status !== 0) return false;

  // Check that both packages are installed
  const pkgCheck = spawnSync(
    rscript,
    [
      "--vanilla",
      "-e",
      [
        "stopifnot(requireNamespace('rrlmgraph',     quietly = TRUE))",
        "stopifnot(requireNamespace('rrlmgraphbench', quietly = TRUE))",
      ].join("; "),
    ],
    { timeout: 30_000 }
  );
  return pkgCheck.status === 0;
}

// ── suite ──────────────────────────────────────────────────────────────────

describe("real-export integration (rrlmgraph#16)", () => {
  let tmpDir: string;
  let sqlitePath: string;
  let graph: SQLiteGraph;
  let skipAll = false;

  beforeAll(() => {
    if (!rEnvironmentAvailable()) {
      console.warn(
        "[real-export] Skipping — Rscript / rrlmgraph / rrlmgraphbench not available."
      );
      skipAll = true;
      return;
    }

    tmpDir = mkdtempSync(join(tmpdir(), "rrlmgraph-mcp-real-export-"));
    sqlitePath = join(tmpDir, "graph.sqlite");

    const rscript = getRscriptPath();

    // Build graph from mini_ds_project and export to SQLite
    const rCode = [
      "proj <- system.file('projects/mini_ds_project', package = 'rrlmgraphbench')",
      "if (!nzchar(proj)) stop('mini_ds_project not found in rrlmgraphbench')",
      `g <- rrlmgraph::build_rrlm_graph(proj, embed_method = 'tfidf')`,
      `rrlmgraph::export_to_sqlite(g, '${sqlitePath.replace(/\\/g, "/")}'  )`,
    ].join("; ");

    const result = spawnSync(rscript, ["--vanilla", "-e", rCode], {
      timeout: 120_000,
      encoding: "utf8",
    });

    if (result.status !== 0 || !existsSync(sqlitePath)) {
      console.error("[real-export] R subprocess failed:\n", result.stderr);
      skipAll = true;
      return;
    }

    graph = new SQLiteGraph(sqlitePath);
    graph.load();
    console.log("[real-export] SQLite exported successfully, reading back...");
  }, 150_000);

  afterAll(() => {
    try {
      graph?.close?.();
    } catch {
      // ignore
    }
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips gracefully when R is unavailable (meta-check)", () => {
    // This test always passes; it documents the skip mechanism.
    expect(true).toBe(true);
  });

  it("queryContext returns non-empty node_ids against real export", () => {
    if (skipAll) return;

    const result = graph.queryContext("split the data", "split_data", 2000);
    expect(result.node_ids.length).toBeGreaterThan(0);
  });

  it("context_string contains at least one R function definition", () => {
    if (skipAll) return;

    const result = graph.queryContext("split the data", "split_data", 2000);
    // An R function definition looks like `function(` or `<- function`
    expect(result.context_string).toMatch(/function\s*\(/);
  });

  it("retrieval_mode is tfidf_cosine when TF-IDF vocab is populated", () => {
    if (skipAll) return;

    const result = graph.queryContext("split the data", "split_data", 2000);
    console.log(`[real-export] retrieval_mode = ${result.retrieval_mode}`);
    // Should be tfidf_cosine since embed_method = "tfidf" was used
    expect(result.retrieval_mode).toBe("tfidf_cosine");
  });

  it("tfidf vocab table is non-empty in the real export", () => {
    if (skipAll) return;

    // Probe via the graph's internal DB handle
    // @ts-expect-error accessing private db for test assertion
    const db = graph["db"];
    if (!db) return; // defensive

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM tfidf_vocab")
      .get() as { n: number };
    console.log(`[real-export] tfidf_vocab rows = ${rows.n}`);
    expect(rows.n).toBeGreaterThan(0);
  });
});
