/**
 * Scaffold smoke test — FND-001.
 *
 * Deliberately tiny: its job is to prove the Vitest harness runs, collects
 * from tests/unit, and can read project files. Real unit coverage for
 * `lib/scoring` and `lib/ingest` arrives with BE-* tickets (docs/06 §8.2).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("project scaffold", () => {
  it("reads package.json and identifies the project", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      name: string;
      scripts: Record<string, string>;
    };

    expect(pkg.name).toBe("jobradar");
    expect(pkg.scripts.typecheck).toContain("tsc");
    expect(pkg.scripts.test).toContain("vitest");
  });

  it("keeps .env.local out of version control", () => {
    const gitignore = readFileSync(".gitignore", "utf8");
    const lines = gitignore.split("\n").map((l) => l.trim());

    expect(lines).toContain(".env.local");
    // .env.example is the only env file that may be committed.
    expect(lines).not.toContain(".env.example");
  });

  it("declares design tokens in the one permitted file", () => {
    const tokens = readFileSync("src/styles/tokens.css", "utf8");
    expect(tokens).toMatch(/--[a-z0-9-]+:/i);
  });
});