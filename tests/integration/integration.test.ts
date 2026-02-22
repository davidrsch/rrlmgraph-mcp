/**
 * Integration test: MCP client connects and calls all tools and resources.
 *
 * Requires:
 *   - built server (dist/index.js)
 *   - fixture.sqlite (auto-generated from create_fixture.ts)
 *
 * Tests run in CI without VS Code.
 * Test completes in < 30 seconds.
 *
 * Issue: rrlmgraph-mcp #10
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = join(__dirname, "../fixtures/fixture.sqlite");
const distPath = join(__dirname, "../../dist/index.js");

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // Ensure fixture exists
  if (!existsSync(fixturePath)) {
    const script = join(__dirname, "../fixtures/create_fixture.ts");
    execSync(`npx tsx "${script}"`, { stdio: "inherit" });
  }

  // Ensure server is built
  if (!existsSync(distPath)) {
    execSync("npm run build", {
      cwd: join(__dirname, "../.."),
      stdio: "inherit",
    });
  }

  transport = new StdioClientTransport({
    command: "node",
    args: [distPath, "--db-path", fixturePath],
    env: { ...process.env },
  });

  client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
}, 20_000);

afterAll(async () => {
  await client?.close();
});

// ── Tools list ────────────────────────────────────────────────────────────────

describe("tools/list", () => {
  it("returns all 4 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("query_context");
    expect(names).toContain("get_node_info");
    expect(names).toContain("rebuild_graph");
    expect(names).toContain("add_task_trace");
  });
});

// ── query_context ─────────────────────────────────────────────────────────────

describe("query_context tool", () => {
  it("returns non-empty context", async () => {
    const result = await client.callTool({
      name: "query_context",
      arguments: { query: "build a code graph for an R project", budget_tokens: 2000 },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain("rrlmgraph context");
    expect(text).toContain("Nodes retrieved");
  });

  it("budget not exceeded", async () => {
    const result = await client.callTool({
      name: "query_context",
      arguments: { query: "query context traversal", budget_tokens: 100 },
    });
    expect(result.isError).toBeFalsy();
  });
});

// ── get_node_info ─────────────────────────────────────────────────────────────

describe("get_node_info tool", () => {
  it("returns info for known node", async () => {
    const result = await client.callTool({
      name: "get_node_info",
      arguments: { node_name: "build_rrlm_graph" },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("build_rrlm_graph");
    expect(text).toContain("graph_build.R");
  });

  it("returns error with suggestions for unknown node", async () => {
    const result = await client.callTool({
      name: "get_node_info",
      arguments: { node_name: "totally_unknown_xyz_function" },
    });
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("not found");
  });
});

// ── add_task_trace ────────────────────────────────────────────────────────────

describe("add_task_trace tool", () => {
  it("records a trace and returns confirmation", async () => {
    const result = await client.callTool({
      name: "add_task_trace",
      arguments: {
        query: "integration test task",
        nodes: ["build_rrlm_graph", "query_context"],
        polarity: 0.9,
        session_id: "integration-test",
      },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Trace ID");
    expect(text).toContain("+0.9");
  });
});

// ── Resources ─────────────────────────────────────────────────────────────────

describe("resources/list", () => {
  it("returns summary and task-history static resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("rrlmgraph://summary");
    expect(uris).toContain("rrlmgraph://task-history");
  });
});

describe("resource reads", () => {
  it("rrlmgraph://summary returns markdown with counts", async () => {
    const result = await client.readResource({ uri: "rrlmgraph://summary" });
    const text = result.contents[0].text as string;
    expect(text).toContain("Graph Summary");
    expect(text).toContain("Nodes");
  });

  it("rrlmgraph://task-history returns content", async () => {
    const result = await client.readResource({ uri: "rrlmgraph://task-history" });
    const text = result.contents[0].text as string;
    expect(text).toContain("Task History");
  });

  it("rrlmgraph://file/{path} returns nodes for known file", async () => {
    const result = await client.readResource({
      uri: "rrlmgraph://file/R/graph_build.R",
    });
    const text = result.contents[0].text as string;
    expect(text).toContain("build_rrlm_graph");
  });
});
