/**
 * rrlmgraph-mcp — Model Context Protocol server for rrlmgraph.
 *
 * Entry point: registers all tools and resources, connects stdio transport.
 *
 * Environment variables:
 *   RRLMGRAPH_PROJECT_PATH   Path to the R project root (required when not
 *                            auto-detected from cwd)
 *   RRLMGRAPH_DB_PATH        Path to graph.sqlite (default:
 *                            <project_path>/.rrlmgraph/graph.sqlite)
 *   RRLMGRAPH_BUDGET_TOKENS  Default token budget for query_context (default: 6000)
 *   RRLMGRAPH_EMBED_METHOD   Embedding method hint passed to R (default: tfidf)
 *   RRLMGRAPH_CACHE_DIR      Cache directory (default: <project_path>/.rrlmgraph)
 *
 * Issue: rrlmgraph-mcp #8
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { SQLiteGraph } from "./db/sqlite_reader.js";
import { createQueryContextTool } from "./tools/query_context.js";
import { createGetNodeInfoTool } from "./tools/get_node_info.js";
import { createRebuildGraphTool } from "./tools/rebuild_graph.js";
import { createAddTaskTraceTool } from "./tools/add_task_trace.js";
import { createSummaryResource } from "./resources/summary.js";
import { createFileNodesResource } from "./resources/file_nodes.js";
import { createTaskHistoryResource } from "./resources/task_history.js";

// ── CLI args ─────────────────────────────────────────────────────────────────

let cliArgs: { values: Record<string, unknown> };
try {
  cliArgs = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "project-path": { type: "string" },
      "db-path": { type: "string" },
    },
    strict: false,
  });
} catch {
  cliArgs = { values: {} };
}

if (cliArgs.values["help"]) {
  console.log(`
rrlmgraph-mcp — MCP server for rrlmgraph

Usage:
  npx rrlmgraph-mcp [options]

Options:
  --project-path <path>   R project root directory
  --db-path <path>        Path to graph.sqlite file
  --version               Print version and exit
  --help                  Show this help

Environment variables:
  RRLMGRAPH_PROJECT_PATH  R project root (used if --project-path not set)
  RRLMGRAPH_DB_PATH       Path to graph.sqlite
  RRLMGRAPH_BUDGET_TOKENS Default token budget (default: 6000)
  RRLMGRAPH_EMBED_METHOD  Embedding method (default: tfidf)

Example .vscode/mcp.json:
  { "servers": { "rrlmgraph": { "command": "npx",
    "args": ["rrlmgraph-mcp", "--project-path", "\${workspaceFolder}"] } } }
`);
  process.exit(0);
}

if (cliArgs.values["version"]) {
  // package.json is in the dist/../ tree after build; use dynamic import
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const pkg = req("../../package.json") as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

// ── Project path resolution ───────────────────────────────────────────────────

const projectPath = resolve(
  (cliArgs.values["project-path"] as string | undefined) ??
    process.env["RRLMGRAPH_PROJECT_PATH"] ??
    process.cwd()
);

const dbPath =
  (cliArgs.values["db-path"] as string | undefined) ??
  process.env["RRLMGRAPH_DB_PATH"] ??
  join(projectPath, ".rrlmgraph", "graph.sqlite");

if (!existsSync(dbPath)) {
  process.stderr.write(
    `[rrlmgraph-mcp] WARNING: SQLite database not found at ${dbPath}.\n` +
      `Run rrlmgraph::export_to_sqlite() in R to generate it, then restart the server.\n` +
      `Starting in degraded mode (empty graph).\n`
  );
}

// ── Graph initialisation ──────────────────────────────────────────────────────

const graph = new SQLiteGraph(dbPath);

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "rrlmgraph-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ── Register tools ────────────────────────────────────────────────────────────

const tools = [
  createQueryContextTool(graph),
  createGetNodeInfoTool(graph),
  createRebuildGraphTool(graph, projectPath),
  createAddTaskTraceTool(graph),
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      content: [
        { type: "text" as const, text: `Unknown tool: ${req.params.name}` },
      ],
      isError: true,
    };
  }
  try {
    return await tool.execute(req.params.arguments ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Tool error: ${msg}` }],
      isError: true,
    };
  }
});

// ── Register resources ────────────────────────────────────────────────────────

const staticResources = [
  createSummaryResource(graph),
  createTaskHistoryResource(graph),
];

const templateResources = [createFileNodesResource(graph)];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: staticResources.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  })),
}));

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: templateResources.map((r) => ({
    uriTemplate: r.uriTemplate,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;

  // Static resources
  for (const r of staticResources) {
    if (r.uri === uri) return r.read(uri);
  }

  // Template resources (match by prefix pattern)
  for (const r of templateResources) {
    const prefix = r.uriTemplate.split("{")[0];
    if (uri.startsWith(prefix)) return r.read(uri);
  }

  return {
    contents: [
      {
        uri,
        mimeType: "text/plain",
        text: `Unknown resource: ${uri}`,
      },
    ],
  };
});

// ── Connect transport ─────────────────────────────────────────────────────────

process.stderr.write(`[rrlmgraph-mcp] Starting server (db: ${dbPath})\n`);

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("SIGINT", () => {
  graph.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  graph.close();
  process.exit(0);
});
