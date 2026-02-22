/**
 * query_context MCP tool — expose graph BFS traversal to LLM hosts.
 *
 * Issue: rrlmgraph-mcp #3
 */

import { z } from "zod";
import type { SQLiteGraph } from "../db/sqlite_reader.js";
import type { ToolDefinition } from "./types.js";

export const queryContextSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Natural language description of the coding task"),
  budget_tokens: z
    .number()
    .int()
    .positive()
    .default(6000)
    .describe("Token budget for returned context"),
  seed_node: z
    .string()
    .optional()
    .describe("Function name to anchor the graph traversal"),
});

export type QueryContextInput = z.infer<typeof queryContextSchema>;

export function createQueryContextTool(graph: SQLiteGraph): ToolDefinition {
  return {
    name: "query_context",
    description:
      "Query the RLM-Graph for R project context relevant to a coding task. " +
      "Returns structured context (function signatures, documentation, source) " +
      "within a configurable token budget.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language description of the coding task",
        },
        budget_tokens: {
          type: "number",
          description: "Token budget for returned context (default: 6000)",
          default: 6000,
        },
        seed_node: {
          type: "string",
          description: "Optional function name to anchor the traversal",
        },
      },
      required: ["query"],
    },
    execute: async (raw: unknown) => {
      const { query, budget_tokens, seed_node } =
        queryContextSchema.parse(raw);

      const result = graph.queryContext(query, seed_node, budget_tokens);

      const metaFooter = [
        `---`,
        `**Nodes retrieved**: ${result.node_ids.length}`,
        `**Token estimate**: ~${result.token_estimate}`,
        `**Seed node**: ${result.seed_node ?? "(none)"}`,
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: result.context_string,
          },
          {
            type: "text" as const,
            text: metaFooter,
          },
        ],
      };
    },
  };
}
