/**
 * doc-drift.test.ts — structural checks that README and docs/ agree with reality.
 *
 * ## Why this exists
 *
 * README.md was stale in four places at once: it said "five documents" when there were
 * seven, "87 tickets" when there were 59, "OpenAI" when the stack is OpenRouter, and
 * "five specification documents" in the repo layout. Nothing caught it — no lint rule,
 * no type check, no test. The README is the first file an agent reads, so a stale README
 * poisons every session that follows.
 *
 * This file is the gate that was missing. It asserts the three properties that drifted:
 *
 *   1. README's doc table lists every file in `docs/` (no missing, no extra)
 *   2. README's ticket count matches the actual MUST count in docs/05
 *   3. README's stack table matches docs/02 §2 (AI provider, framework, database)
 *
 * The assertions are deliberately narrow — they check the specific claims that drifted,
 * not a full schema. An over-strict test becomes something people delete.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DOCS_DIR = join(ROOT, "docs");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function readDoc(name: string): string {
  return readFileSync(join(DOCS_DIR, name), "utf8");
}

describe("README.md", () => {
  const readme = read("README.md");

  it("lists every doc in docs/ — no missing, no extra", () => {
    // Extract doc filenames from README's markdown links: ./docs/01-prd.md
    const linked = new Set(
      [...readme.matchAll(/\.\/docs\/([a-z0-9-]+\.md)/g)]
        .map((m) => m[1])
        .filter((f): f is string => f !== undefined),
    );

    const actual = readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();

    const missing = actual.filter((f) => !linked.has(f));
    const extra: string[] = Array.from(linked).filter((f) => !actual.includes(f));

    expect(missing, `README is missing docs: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `README links to non-existent docs: ${extra.join(", ")}`).toEqual([]);
  });

  it("ticket count matches the MUST count in docs/05", () => {
    // Count MUST tickets across all docs/05*.md files
    const allDocs = readdirSync(DOCS_DIR)
      .filter((f) => f.startsWith("05") && f.endsWith(".md"))
      .sort();

    let mustCount = 0;
    for (const file of allDocs) {
      const content = readDoc(file);
      // Tickets are marked with **Priority:** MUST
      mustCount += (content.match(/\*\*Priority:\*\*\s*MUST/g) ?? []).length;
    }

    // README claims a specific number — extract it
    const readmeMatch = /(\d+)\s*MUST tickets/.exec(readme);
    expect(readmeMatch, "README must state the MUST ticket count").not.toBeNull();

    const readmeCount = Number(readmeMatch![1]);
    expect(readmeCount, `README says ${readmeCount}, actual is ${mustCount}`).toBe(
      mustCount,
    );
  });

  it("stack table matches docs/02 §2 — AI provider", () => {
    // docs/02 §2 says OpenRouter; README must not say OpenAI
    const arch = readDoc("02-technical-architecture.md");
    const usesOpenRouter = arch.includes("OpenRouter");
    const readmeSaysOpenAI = /\|\s*AI\s*\|\s*OpenAI/.test(readme);

    if (usesOpenRouter) {
      expect(
        readmeSaysOpenAI,
        "README says OpenAI but docs/02 says OpenRouter — update README",
      ).toBe(false);
    }
  });

  it("stack table matches docs/02 §2 — framework version", () => {
    const arch = readDoc("02-technical-architecture.md");
    const usesNext15 = arch.includes("Next.js") && arch.includes("15");
    const readmeSaysNext = /Next\.js\s*15/.test(readme);

    if (usesNext15) {
      expect(
        readmeSaysNext,
        "README must mention Next.js 15 to match docs/02",
      ).toBe(true);
    }
  });

  it("says 'seven documents', not 'five'", () => {
    // The specific drift that shipped: "five" when there are seven
    expect(readme).not.toMatch(/five documents/i);
    expect(readme).toMatch(/seven documents/i);
  });
});

describe("docs/ cross-references", () => {
  it("every doc has a 'Last reviewed' date", () => {
    const docs = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
    const missing: string[] = [];

    for (const doc of docs) {
      const content = readDoc(doc);
      if (!content.includes("Last reviewed") && !content.includes("Last updated")) {
        missing.push(doc);
      }
    }

    expect(missing, `These docs lack a review date: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("docs/07-session-log.md is marked as non-authority", () => {
    const log = readDoc("07-session-log.md");
    expect(log).toMatch(/NOT AUTHORITY|not authority/i);
  });

  it("split docs have a Parent pointer back to their source", () => {
    const splitDocs = [
      "02a-schema.md",
      "02b-subsystems.md",
      "02c-config.md",
      "05a-phase0.md",
      "05b-phase1.md",
      "05c-phase2.md",
      "05d-phase3.md",
    ];

    for (const doc of splitDocs) {
      const content = readDoc(doc);
      expect(
        content.includes("Parent:") || content.includes("parent:"),
        `${doc} must have a Parent pointer`,
      ).toBe(true);
    }
  });
});
