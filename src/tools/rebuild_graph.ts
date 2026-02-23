/**
 * rebuild_graph MCP tool — trigger R re-indexing via subprocess.
 *
 * Issue: rrlmgraph-mcp #5
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import type { SQLiteGraph } from "../db/sqlite_reader.js";
import type { ToolDefinition } from "./types.js";
import { resolveRscript } from "../utils/rscript.js";

export const rebuildGraphSchema = z.object({
  incremental: z
    .boolean()
    .default(true)
    .describe(
      "Use incremental rebuild (only changed files). Set false for full rebuild."
    ),
  project_path: z
    .string()
    .optional()
    .describe(
      "Path to the R project root. Defaults to RRLMGRAPH_PROJECT_PATH env var."
    ),
});

export type RebuildGraphInput = z.infer<typeof rebuildGraphSchema>;

export function createRebuildGraphTool(
  graph: SQLiteGraph,
  defaultProjectPath: string
): ToolDefinition {
  return {
    name: "rebuild_graph",
    description:
      "Trigger a rebuild of the R project code graph via an Rscript subprocess. " +
      "Streams build progress. On completion, the in-memory graph is refreshed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        incremental: {
          type: "boolean",
          description:
            "Incremental rebuild (changed files only). Default: true.",
          default: true,
        },
        project_path: {
          type: "string",
          description:
            "R project root directory. Defaults to RRLMGRAPH_PROJECT_PATH.",
        },
      },
      required: [],
    },
    execute: (raw: unknown): Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }> => {
      const { incremental, project_path } = rebuildGraphSchema.parse(raw);
      const projPath = project_path ?? defaultProjectPath;

      return new Promise((resolve) => {
        const rFunc = incremental
          ? "rrlmgraph::update_graph_incremental"
          : "rrlmgraph::build_rrlm_graph";

        const rCode = `${rFunc}('${projPath.replace(/'/g, "\\'")}', cache = TRUE)`;

        const rscript = resolveRscript();
        const proc = spawn(rscript, ["--vanilla", "-e", rCode], {
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 300_000, // 5 min hard timeout
        });

        const lines: string[] = [];

        proc.stdout?.on("data", (chunk: Buffer) => {
          lines.push(chunk.toString().trimEnd());
        });
        proc.stderr?.on("data", (chunk: Buffer) => {
          lines.push(chunk.toString().trimEnd());
        });

        proc.on("error", (err) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            resolve({
              content: [
                {
                  type: "text" as const,
                  text:
                    "**Error**: `Rscript` not found. " +
                    "Please install R and ensure it is on your PATH.\n\n" +
                    (process.platform === "win32"
                      ? "On Windows, set the `RSCRIPT_PATH` environment variable to the full " +
                        "path of `Rscript.exe` (e.g. `C:\\Program Files\\R\\R-4.4.1\\bin\\Rscript.exe`), " +
                        "or add R's `bin` directory to your `PATH`.\n\n"
                      : "") +
                    "Download R from: https://cran.r-project.org/",
                },
              ],
              isError: true,
            });
          } else {
            resolve({
              content: [{ type: "text" as const, text: `**Error**: ${err.message}` }],
              isError: true,
            });
          }
        });

        proc.on("close", (code) => {
          if (code === 0) {
            // Reload vocabulary after rebuild
            graph.reload();
            resolve({
              content: [
                {
                  type: "text" as const,
                  text:
                    `✅ Graph rebuilt successfully (${incremental ? "incremental" : "full"}).\n\n` +
                    `**Output:**\n\`\`\`\n${lines.join("\n")}\n\`\`\``,
                },
              ],
            });
          } else {
            resolve({
              content: [
                {
                  type: "text" as const,
                  text:
                    `❌ R process exited with code ${code}.\n\n` +
                    `**Output:**\n\`\`\`\n${lines.join("\n")}\n\`\`\``,
                },
              ],
              isError: true,
            });
          }
        });
      });
    },
  };
}
