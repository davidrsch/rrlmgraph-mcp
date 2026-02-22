/**
 * rrlmgraph://summary resource — graph overview for LLM hosts.
 *
 * Issue: rrlmgraph-mcp #7
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { SQLiteGraph } from "../db/sqlite_reader.js";
import type { ResourceDefinition } from "./types.js";

export function createSummaryResource(graph: SQLiteGraph): ResourceDefinition {
  return {
    uri: "rrlmgraph://summary",
    name: "Graph Summary",
    description:
      "Overview of the rrlmgraph code graph: node/edge counts, top PageRank hubs, " +
      "build time, and embedding method.",
    mimeType: "text/markdown",
    read: async (): Promise<ReadResourceResult> => {
      const s = graph.getGraphSummary();

      const lines: string[] = [
        `# rrlmgraph Graph Summary`,
        ``,
        `| Property | Value |`,
        `|---|---|`,
        `| Nodes | ${s.node_count} |`,
        `| Edges | ${s.edge_count} |`,
        `| Build time | ${s.build_time ?? "unknown"} |`,
        `| rrlmgraph version | ${s.rrlmgraph_version ?? "unknown"} |`,
        `| Embed method | ${s.embed_method ?? "tfidf"} |`,
        `| Project root | ${s.project_root ?? "unknown"} |`,
        ``,
        `## Node types`,
        ...Object.entries(s.node_types).map(
          ([type, count]) => `- **${type}**: ${count}`
        ),
        ``,
        `## Edge types`,
        ...Object.entries(s.edge_types).map(
          ([type, count]) => `- **${type}**: ${count}`
        ),
        ``,
        `## Top 10 PageRank hubs`,
        ...s.top_hubs.map(
          (h, i) =>
            `${i + 1}. \`${h.name}\` — PageRank ${h.pagerank.toFixed(5)}`
        ),
      ];

      return {
        contents: [
          {
            uri: "rrlmgraph://summary",
            mimeType: "text/markdown",
            text: lines.join("\n"),
          },
        ],
      };
    },
  };
}
