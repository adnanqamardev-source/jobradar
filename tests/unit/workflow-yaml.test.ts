/**
 * workflow-yaml.test.ts — structural checks on the GitHub Actions workflows.
 *
 * ## Why this exists
 *
 * A duplicated job key made `ci.yml` invalid. GitHub rejected the file at parse time, so the
 * run finished in **0 seconds with zero jobs** and no log to read. The failure was invisible
 * to every other gate in this repo:
 *
 *   - `pnpm lint` does not parse YAML.
 *   - `pnpm typecheck` does not parse YAML.
 *   - `pnpm test` did not parse YAML — nothing did.
 *   - `python -c "yaml.safe_load(...)"` **passed**, because PyYAML's default loader silently
 *     keeps the last value for a duplicate key rather than complaining.
 *
 * So the duplicate shipped, and CI rejected the push. This file is the gate that was missing.
 *
 * ## Why the check is hand-rolled rather than a YAML library
 *
 * The only property that matters is duplicate-key detection, and PyYAML cannot do it with
 * `safe_load` — it needs a custom constructor. Encoding that in a test keeps the assertion in
 * the same runner as everything else, so a broken workflow fails `pnpm test` before it ever
 * reaches GitHub. (Node has no built-in YAML parser; adding a dependency for this is not
 * worth it, and a workflow-shape test that depends on a new dep has its own supply-chain cost.)
 *
 * Assertions are deliberately narrow: valid YAML, no duplicate keys at any depth, and the jobs
 * the tickets in `docs/06` require. Not a full schema — an over-strict test here becomes
 * something people delete.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const WORKFLOW_DIR = join(process.cwd(), ".github", "workflows");

/**
 * Jobs `docs/06` FND-005 requires: lint, typecheck, test, build, secret-scan, e2e, audit.
 * Kept as an explicit list so deleting a job is a visible test failure rather than a
 * silently weaker pipeline.
 */
const REQUIRED_JOBS = [
  "lint",
  "typecheck",
  "test",
  "build",
  "secret-scan",
  "e2e",
  "audit",
] as const;

/**
 * A deliberately small YAML subset: block mappings, block sequences, plain/quoted scalars,
 * comments. Enough for Actions workflows, and small enough to have no ambiguity.
 *
 * Returns a nested structure where mappings are `Record<string, unknown>` and sequences are
 * arrays. Duplicate keys throw — the whole point of this module.
 */
type Yaml = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface SourceLine {
  indent: number;
  line: string;
  raw: string;
}

function parseYaml(text: string, file: string): Yaml {
  const lines: SourceLine[] = [];

  for (const raw of text.split(/\r?\n/)) {
    // Drop whole-line comments. Block scalars are not used in these workflows.
    const withoutComment = raw.replace(/(^|\s)#.*$/, "$1");
    if (withoutComment.trim() === "") continue;
    lines.push({ indent: withoutComment.length - withoutComment.trimStart().length, line: withoutComment.trim(), raw });
  }

  const duplicate = (key: string): never => {
    throw new Error(
      `${file}: duplicate key "${key}". GitHub rejects the whole workflow at parse time — ` +
        `the run fails in 0s with no jobs and no logs, and no other gate in this repo sees it.`,
    );
  };

  function scalar(token: string): Yaml {
    if (token === "") return "";
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null" || token === "~") return null;
    // Flow sequence, e.g. `needs: [lint, typecheck, test]`. GitHub Actions accepts these and
    // this repo uses them, so the parser has to too — otherwise `needs` arrives as the
    // string "[lint, typecheck, test]" and every ordering assertion silently misbehaves.
    if (token.startsWith("[") && token.endsWith("]")) {
      const inner = token.slice(1, -1).trim();
      return inner === "" ? [] : inner.split(",").map((part) => scalar(part.trim()));
    }
    if (/^-?\d+$/.test(token)) return Number(token);
    if (/^".*"$/.test(token) || /^'.*'$/.test(token)) return token.slice(1, -1);
    return token;
  }

  function parseBlock(start: number, indent: number): [Yaml, number] {
    // Decide sequence vs mapping from the first line at this indent.
    if (lines[start]?.line.startsWith("- ")) {
      const items: unknown[] = [];
      let i = start;
      while (i < lines.length && lines[i]?.indent === indent && lines[i]?.line.startsWith("- ")) {
        const itemIndent = indent + 2;
        const inline = (lines[i]?.line ?? "").slice(2).trim();
        if (inline === "") {
          const [value, next] = parseBlock(i + 1, itemIndent);
          items.push(value);
          i = next;
        } else if (/^[A-Za-z0-9_.$-]+:(\s|$)/.test(inline)) {
          // A mapping whose first key shares the dash line: `- uses: x` then sibling keys
          // indented to itemIndent.
          const synthetic = lines[i]!;
          lines[i] = { indent: itemIndent, line: inline, raw: synthetic.raw };
          const [value, next] = parseBlock(i, itemIndent);
          items.push(value);
          i = next;
        } else {
          items.push(scalar(inline));
          i += 1;
        }
      }
      return [items, i];
    }

    const map: Record<string, unknown> = {};
    let i = start;
    while (i < lines.length && (lines[i]?.indent ?? -1) === indent) {
      const line = lines[i]?.line ?? "";
      if (line.startsWith("- ")) break;
      const colon = line.indexOf(":");
      if (colon === -1) {
        throw new Error(`${file}: cannot parse line ${i + 1}: ${lines[i]?.raw.trim()}`);
      }
      const key = line.slice(0, colon).trim();
      if (Object.hasOwn(map, key)) duplicate(key);
      const rest = line.slice(colon + 1).trim();
      if (rest === "") {
        const childIndent = lines[i + 1]?.indent ?? -1;
        if (i + 1 < lines.length && childIndent > indent) {
          const [value, next] = parseBlock(i + 1, childIndent);
          map[key] = value;
          i = next;
        } else {
          map[key] = null;
          i += 1;
        }
      } else {
        map[key] = scalar(rest);
        i += 1;
      }
    }
    return [map, i];
  }

  const [parsed] = parseBlock(0, lines[0]?.indent ?? 0);
  return parsed;
}

function readWorkflow(name: string): Yaml {
  return parseYaml(readFileSync(join(WORKFLOW_DIR, name), "utf8"), name);
}

describe("GitHub Actions workflows", () => {
  const files: string[] = ["ci.yml"];

  it.each(files)("%s has no duplicate keys at any depth", (name: string) => {
    // The check that would have caught the invalid push. PyYAML's safe_load does not.
    expect(() => readWorkflow(name)).not.toThrow();
  });

  it("ci.yml defines every job docs/06 FND-005 requires", () => {
    const wf = readWorkflow("ci.yml") as Record<string, unknown>;
    const jobs = wf.jobs as Record<string, unknown>;
    const found = Object.keys(jobs).sort();
    expect(found).toEqual([...REQUIRED_JOBS].sort());
  });

  it("runs jobs in the documented order", () => {
    // typecheck before lint before test; the build gates the bundle scan and e2e.
    const wf = readWorkflow("ci.yml") as Record<string, unknown>;
    const jobs = wf.jobs as Record<string, { needs?: string | string[] }>;

    const needsOf = (job: string): string[] => {
      const needs = jobs[job]?.needs;
      if (needs === undefined) return [];
      return Array.isArray(needs) ? needs : [needs];
    };

    expect(needsOf("build")).toEqual(
      expect.arrayContaining(["lint", "typecheck", "test"]),
    );
    expect(needsOf("secret-scan")).toContain("build");
    expect(needsOf("e2e")).toContain("build");
  });

  it("pins Node from a single source, so CI and Vercel cannot drift", () => {
    // A hardcoded `node-version: 20` in one step is how the Node deprecation shipped
    // unnoticed. Every setup-node must read the workflow-level NODE_VERSION.
    const wf = readWorkflow("ci.yml") as Record<string, unknown>;
    expect(wf.env).toMatchObject({ NODE_VERSION: "24" });

    const jobs = wf.jobs as Record<string, { steps?: Record<string, unknown>[] }>;
    const pinned: string[] = [];
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        const uses = typeof step.uses === "string" ? step.uses : "";
        if (!uses.includes("actions/setup-node")) continue;
        const with_ = step.with as Record<string, unknown> | undefined;
        pinned.push(`${name}: ${String(with_?.["node-version"])}`);
      }
    }
    expect(pinned.length).toBeGreaterThan(0);
    for (const entry of pinned) {
      expect(entry, "setup-node must not hardcode a version").toContain(
        "env.NODE_VERSION",
      );
    }
  });

  it("supplies the five required env vars, so the build gate can run", () => {
    // Importing `@/lib/env` makes `next build` evaluate the contract during "collecting page
    // data", so a build without these fails with `Failed to collect page data for /<route>`.
    // CI satisfies the schema with placeholders — never real credentials.
    const wf = readWorkflow("ci.yml") as Record<string, unknown>;
    const env = wf.env as Record<string, unknown>;

    for (const key of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "CRON_SECRET",
      "OPENROUTER_API_KEY",
    ]) {
      expect(env[key], `${key} must be set in ci.yml env`).toBeTruthy();
    }

    expect(String(env.CRON_SECRET).length).toBeGreaterThanOrEqual(32);
  });
});
