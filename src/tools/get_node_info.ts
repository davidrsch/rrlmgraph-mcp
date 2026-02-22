/**
 * get_node_info MCP tool — full details for a specific function/node.
 *
 * Issue: rrlmgraph-mcp #4
 */

import { z } from "zod";
import type { SQLiteGraph } from "../db/sqlite_reader.js";
import type { ToolDefinition } from "./types.js";

export const getNodeInfoSchema = z.object({
  node_name: z.string().min(1).describe("Exact name of the function or node"),
  include_source: z
    .boolean()
    .default(false)
    .describe("Include full function body source code"),
});

export type GetNodeInfoInput = z.infer<typeof getNodeInfoSchema>;

export function createGetNodeInfoTool(graph: SQLiteGraph): ToolDefinition {
  return {
    name: "get_node_info",
    description:
      "Retrieve full details for a specific R function or node in the graph: " +
      "signature, documentation, callers, callees, and test coverage. " +
      "Set include_source=true for the full function body.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_name: {
          type: "string",
          description: "Exact name of the function or node",
        },
        include_source: {
          type: "boolean",
          description: "Include full function body (default: false)",
          default: false,
        },
      },
      required: ["node_name"],
    },
    execute: async (raw: unknown) => {
      const { node_name, include_source } = getNodeInfoSchema.parse(raw);

      const info = graph.getNodeInfo(node_name, include_source);

      if (!info) {
        const similar = graph.findSimilarNodes(node_name);
        const hint =
          similar.length > 0
            ? `\n\nDid you mean one of: ${similar.map((n) => `\`${n}\``).join(", ")}?`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Node \`${node_name}\` not found in the graph.${hint}`,
            },
          ],
          isError: true,
        };
      }

      const lines: string[] = [
        `# ${info.name}`,
        `**Type**: ${info.node_type ?? "unknown"}`,
        `**File**: ${info.file ?? "unknown"}`,
      ];

      if (info.pkg_name) {
        lines.push(
          `**Package**: ${info.pkg_name}${info.pkg_version ? ` v${info.pkg_version}` : ""}`
        );
      }
      if (info.signature) {
        lines.push(`\n**Signature**:\n\`\`\`r\n${info.signature}\n\`\`\``);
      }
      if (info.roxygen_text) {
        lines.push(`\n**Documentation**:\n${info.roxygen_text}`);
      }

      if (info.callers.length > 0) {
        lines.push(`\n**Called by**: ${info.callers.map((c) => `\`${c}\``).join(", ")}`);
      }
      if (info.callees.length > 0) {
        lines.push(`\n**Calls**: ${info.callees.map((c) => `\`${c}\``).join(", ")}`);
      }
      if (info.tests.length > 0) {
        lines.push(`\n**Tested by**: ${info.tests.map((t) => `\`${t}\``).join(", ")}`);
      }

      const metrics: string[] = [];
      if (info.pagerank != null)
        metrics.push(`PageRank: ${info.pagerank.toFixed(4)}`);
      if (info.complexity != null)
        metrics.push(`Complexity: ${info.complexity}`);
      if (info.task_weight != null)
        metrics.push(`Task weight: ${info.task_weight.toFixed(3)}`);
      if (metrics.length > 0) {
        lines.push(`\n**Metrics**: ${metrics.join(" | ")}`);
      }

      if (include_source && info.body_text) {
        lines.push(`\n**Source**:\n\`\`\`r\n${info.body_text}\n\`\`\``);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
      };
    },
  };
}
