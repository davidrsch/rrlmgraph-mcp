/**
 * Resolve the path to the Rscript executable, with Windows-aware fallbacks.
 *
 * Resolution order:
 *  1. `RSCRIPT_PATH` environment variable (explicit override).
 *  2. `where Rscript` (Windows) / `which Rscript` (Unix) — honours PATH.
 *  3. Windows-only: scan `C:\Program Files\R\*\bin\Rscript.exe` glob.
 *  4. Fallback to bare `"Rscript"` (lets the OS resolve it at spawn time).
 *
 * Issue: rrlmgraph-mcp #15
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/**
 * Find the first existing path among an array of candidates.
 */
function firstExisting(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Enumerate installed R versions under a Windows program-files directory
 * and return paths to their Rscript.exe, newest version first (lexicographic desc).
 */
function windowsProgramFilesRscripts(base: string): string[] {
  if (!existsSync(base)) return [];
  try {
    const versions = readdirSync(base)
      .filter((d) => d.startsWith("R-"))
      .sort()
      .reverse(); // newest first
    return versions.map((v) => join(base, v, "bin", "Rscript.exe"));
  } catch {
    return [];
  }
}

/**
 * Use `where` (Windows) or `which` (Unix) to locate Rscript on PATH.
 * Returns the resolved path, or null if not found.
 */
function findOnPath(): string | null {
  const cmd = IS_WINDOWS ? "where Rscript 2>NUL" : "which Rscript 2>/dev/null";
  try {
    const out = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
    // `where` may return multiple lines — take the first
    const first = out.split(/\r?\n/)[0].trim();
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * Return the Rscript executable path to use for `spawn()`.
 *
 * @returns A valid Rscript path string (never throws).
 */
export function resolveRscript(): string {
  // 1. Explicit env override
  const envOverride = process.env["RSCRIPT_PATH"];
  if (envOverride) return envOverride;

  // 2. PATH search
  const onPath = findOnPath();
  if (onPath) return onPath;

  if (IS_WINDOWS) {
    // 3. Windows: scan common installation directories
    const bases = [
      "C:\\Program Files\\R",
      "C:\\Program Files (x86)\\R",
    ];
    const candidates: string[] = bases.flatMap(windowsProgramFilesRscripts);
    const found = firstExisting(candidates);
    if (found) return found;

    // Also try bare Rscript.exe (shell resolves it)
    return "Rscript.exe";
  }

  // 4. Unix fallback
  return "Rscript";
}
