/**
 * rrlmgraph://file/{path} resource — all nodes extracted from a source file.
 *
 * Issue: rrlmgraph-mcp #7
 */

import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { SQLiteGraph } from "../db/sqlite_reader.js";
import type { ResourceDefinition, ResourceTemplateDefinition } from "./types.js";

export function createFileNodesResource(
  graph: SQLiteGraph
): ResourceTemplateDefinition {
  return {
    uriTemplate: "rrlmgraph://file/{path}",
    name: "File Nodes",
    description:
      "All graph nodes (functions, classes) extracted from a specific source file.",
    mimeType: "text/markdown",
    read: async (uri: string): Promise<ReadResourceResult> => {
      // Extract path from URI: rrlmgraph://file/R/cache.R  →  R/cache.R
      const match = uri.match(/^rrlmgraph:\/\/file\/(.+)$/);
      const filePath = match ? match[1] : "";

      const nodes = graph.getFileNodes(filePath);

      const lines: string[] = [
        `# Nodes in \`${filePath}\``,
        ``,
        `**${nodes.length} node${nodes.length !== 1 ? "s" : ""} found.**`,
        ``,
      ];

      if (nodes.length === 0) {
        lines.push(
          `No nodes found for path \`${filePath}\`.\n` +
            `Check file paths via the \`rrlmgraph://summary\` resource.`
        );
      } else {
        for (const node of nodes) {
          lines.push(`## \`${node.name}\``);
          if (node.node_type) lines.push(`**Type**: ${node.node_type}`);
          if (node.signature)
            lines.push(`**Signature**:\n\`\`\`r\n${node.signature}\n\`\`\``);
          if (node.roxygen_text)
            lines.push(`**Documentation**:\n${node.roxygen_text.slice(0, 300)}`);
          lines.push("");
        }
      }

      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: lines.join("\n"),
          },
        ],
      };
    },
  };
}
