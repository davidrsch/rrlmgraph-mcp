/**
 * rrlmgraph://task-history resource — last 20 task traces.
 *
 * Issue: rrlmgraph-mcp #7
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { SQLiteGraph } from "../db/sqlite_reader.js";
import type { ResourceDefinition } from "./types.js";

export function createTaskHistoryResource(
  graph: SQLiteGraph
): ResourceDefinition {
  return {
    uri: "rrlmgraph://task-history",
    name: "Task History",
    description:
      "Last 20 LLM task trace entries with query, nodes, and polarity values.",
    mimeType: "text/markdown",
    read: async (): Promise<ReadResourceResult> => {
      const traces = graph.getTaskHistory(20);

      const lines: string[] = [
        `# Task History`,
        ``,
        `**${traces.length} trace${traces.length !== 1 ? "s" : ""} recorded.**`,
        ``,
      ];

      if (traces.length === 0) {
        lines.push(
          "No task traces recorded yet. " +
            "Call the `add_task_trace` tool after completing coding tasks."
        );
      } else {
        for (const t of traces) {
          const polarityLabel =
            t.polarity > 0.1
              ? "✅ positive"
              : t.polarity < -0.1
                ? "❌ negative"
                : "➖ neutral";
          lines.push(`## Trace #${t.trace_id}`);
          lines.push(`- **Query**: ${t.query ?? "(none)"}`);
          lines.push(`- **Polarity**: ${polarityLabel} (${t.polarity})`);
          lines.push(`- **Nodes**: ${t.nodes.join(", ") || "(none)"}`);
          lines.push(`- **Time**: ${t.created_at ?? "unknown"}`);
          if (t.session_id) lines.push(`- **Session**: ${t.session_id}`);
          lines.push("");
        }
      }

      return {
        contents: [
          {
            uri: "rrlmgraph://task-history",
            mimeType: "text/markdown",
            text: lines.join("\n"),
          },
        ],
      };
    },
  };
}
