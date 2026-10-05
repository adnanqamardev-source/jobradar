/**
 * opencode-config.test.ts — the local OpenCode config must stay valid and non-inert.
 *
 * ## Why this is a test and not a one-off script
 *
 * The check worth keeping is the `instructions` one. It is the most natural mistake a
 * future session could make here: add `"instructions": ["AGENTS.md"]` expecting it to
 * behave like a hook that reloads the rules each iteration. The config schema accepts
 * the field, the file still parses, every other check still passes — and V2 never
 * resolves those entries, so it does nothing at all. A silent no-op that looks
 * configured is precisely the failure class this repo keeps paying for (see `notes.md`
 * on the secret scanner that matched names instead of values, and the duplicated YAML
 * key that five local validations called "verified").
 *
 * ## What this file does NOT claim
 *
 * It does not verify that OpenCode will load the file, that `/rules` works in the TUI, or
 * that the phase rules are correct. It verifies the shape of the config and that the one
 * known-silent field is absent. Runtime behaviour is the user's to observe.
 *
 * Field names and semantics are taken from the V2 docs, not from memory:
 * https://opencode.ai/v2/docs/config, /commands, /instructions, /agents
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(process.cwd(), "opencode.jsonc");

/** Strip `//` line comments that sit outside string literals, leaving strict JSON. */
function stripLineComments(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    // Only `//` outside a string starts a comment. `https://…` inside a string must not,
    // which is why this cannot be a regex replace over the whole file.
    if (char === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    out += char;
  }

  return out;
}

const raw = readFileSync(CONFIG_PATH, "utf8");

describe("opencode.jsonc", () => {
  const config = JSON.parse(stripLineComments(raw)) as Record<string, unknown>;

  it("parses as JSONC (comments and all)", () => {
    expect(() => JSON.parse(stripLineComments(raw))).not.toThrow();
    // A file of only comments would "parse" to nothing, so require real content.
    expect(Object.keys(config).length).toBeGreaterThan(0);
  });

  it("declares the published $schema for editor validation", () => {
    expect(config.$schema).toBe("https://opencode.ai/config.json");
  });

  it("does NOT set an `instructions` array", () => {
    // The trap: V2 accepts `instructions` but never resolves its files, globs, or URLs.
    // Adding it would look configured while doing nothing. AGENTS.md is auto-loaded.
    expect(config.instructions).toBeUndefined();
  });

  describe("/rules command", () => {
    const commands = config.commands as Record<string, { description?: string; template?: string }>;
    const rules = commands?.rules;

    it("exists", () => {
      expect(rules).toBeDefined();
    });

    it("has a description so it is discoverable in the command list", () => {
      expect(rules?.description).toBeTruthy();
    });

    it("requires a template — it is the prompt body", () => {
      expect(rules?.template?.length ?? 0).toBeGreaterThan(0);
    });

    it("reads AGENTS.md before anything else", () => {
      const t = rules?.template ?? "";
      expect(t).toContain("AGENTS.md");
      // "Before anything else" must come before the placeholder, or the read is advisory.
      expect(t.indexOf("AGENTS.md")).toBeLessThan(t.indexOf("$ARGUMENTS"));
    });

    it("reads notes.md too — OpenCode will not, and AGENTS.md requires it", () => {
      // notes.md is not an instruction file, so nothing loads it automatically. This is
      // the gap the command exists to close.
      expect(rules?.template).toContain("notes.md");
    });

    it("carries the repo's load-bearing rules into the prompt", () => {
      const t = rules?.template ?? "";
      // Gate order: the rule this repo has broken most often.
      expect(t).toMatch(/typecheck[\s\S]*lint[\s\S]*test/);
      // Verify-before-assert, and no fake stubs.
      expect(t).toMatch(/verify before asserting/i);
      expect(t).toMatch(/stub/i);
    });

    it("does not use a shell block to inline the docs", () => {
      // Shell blocks run outside the tool-permission flow, so inlining notes.md that
      // way would bypass the approval prompts AGENTS.md depends on.
      expect(rules?.template).not.toContain("!`");
    });
  });
});