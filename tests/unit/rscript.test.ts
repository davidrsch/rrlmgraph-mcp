/**
 * Unit tests for src/utils/rscript.ts
 *
 * Tests the exported resolveRscript() helper. The function reads
 * process.env at call-time, so we can test different env states by
 * setting/deleting process.env["RSCRIPT_PATH"] before each call.
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolveRscript } from "../../src/utils/rscript.js";

describe("resolveRscript", () => {
  const saved = process.env["RSCRIPT_PATH"];

  afterEach(() => {
    if (saved === undefined) {
      delete process.env["RSCRIPT_PATH"];
    } else {
      process.env["RSCRIPT_PATH"] = saved;
    }
  });

  it("returns RSCRIPT_PATH env override when set", () => {
    process.env["RSCRIPT_PATH"] = "/custom/Rscript";
    expect(resolveRscript()).toBe("/custom/Rscript");
  });

  it("returns RSCRIPT_PATH even when the path looks Windows-style", () => {
    process.env["RSCRIPT_PATH"] = "C:\\Program Files\\R\\R-4.4.0\\bin\\Rscript.exe";
    expect(resolveRscript()).toBe("C:\\Program Files\\R\\R-4.4.0\\bin\\Rscript.exe");
  });

  it("returns a non-empty string when RSCRIPT_PATH is not set", () => {
    delete process.env["RSCRIPT_PATH"];
    const result = resolveRscript();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("fallback string contains 'rscript' (case-insensitive)", () => {
    delete process.env["RSCRIPT_PATH"];
    const result = resolveRscript();
    expect(result.toLowerCase()).toContain("rscript");
  });
});
