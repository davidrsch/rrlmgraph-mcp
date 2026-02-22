/**
 * add_task_trace MCP tool — record LLM task outcomes as graph feedback.
 *
 * Issue: rrlmgraph-mcp #6
 */

import { z } from "zod";
import type { SQLiteGraph } from "../db/sqlite_reader.js";
import type { ToolDefinition } from "./types.js";

export const addTaskTraceSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("The coding task description that was sent to the LLM"),
  nodes: z
    .array(z.string())
    .describe("Node IDs (function names) that were relevant to the task"),
  polarity: z
    .number()
    .min(-1)
    .max(1)
    .default(0)
    .describe(
      "Outcome polarity: 1.0 = task succeeded (accepted), " +
        "-1.0 = task failed (rejected), 0 = neutral/unknown"
    ),
  session_id: z
    .string()
    .optional()
    .describe("Optional session identifier to group related traces"),
});

export type AddTaskTraceInput = z.infer<typeof addTaskTraceSchema>;

export function createAddTaskTraceTool(graph: SQLiteGraph): ToolDefinition {
  return {
    name: "add_task_trace",
    description:
      "Record the outcome of an LLM coding task as feedback for the graph relevance loop. " +
      "Call this after a task is accepted (+polarity) or rejected (−polarity) " +
      "to improve future context retrieval for similar tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The coding task description sent to the LLM",
        },
        nodes: {
          type: "array",
          items: { type: "string" },
          description: "Node IDs (function names) relevant to this task",
        },
        polarity: {
          type: "number",
          description:
            "Outcome: 1.0 = accepted, -1.0 = rejected, 0 = neutral (default: 0)",
          default: 0,
        },
        session_id: {
          type: "string",
          description: "Optional session ID to group related traces",
        },
      },
      required: ["query", "nodes"],
    },
    execute: async (raw: unknown) => {
      const { query, nodes, polarity, session_id } =
        addTaskTraceSchema.parse(raw);

      const traceId = graph.addTaskTrace(query, nodes, polarity, session_id);

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✅ Task trace recorded.`,
              `**Trace ID**: ${traceId}`,
              `**Polarity**: ${polarity >= 0 ? "+" : ""}${polarity}`,
              `**Nodes**: ${nodes.length} recorded`,
              ``,
              `This feedback will be reflected in the next \`query_context\` ` +
                `call after the graph is rebuilt (\`rebuild_graph\`).`,
            ].join("\n"),
          },
        ],
      };
    },
  };
}
