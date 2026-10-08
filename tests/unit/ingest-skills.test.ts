/**
 * BE-106 — canonical skill matcher.
 *
 * Two jobs here. The first is ordinary: the matcher finds skills and, just as importantly,
 * does not find skills that are not there. The second is a drift guard — `CANONICAL_SKILLS`
 * is a hand-maintained mirror of the vocabulary in `supabase/seed.sql`, and a mirror that
 * silently drifts is worse than no matcher at all, because it looks authoritative.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CANONICAL_SKILLS, knownSkillSlugs, matchSkills } from "@/lib/ingest/skills";

const SEED_PATH = join(process.cwd(), "supabase", "seed.sql");

/**
 * Pull the skill tuples out of the seed's `insert into skills ... values (...);` block.
 *
 * Parsed rather than hand-copied on purpose: notes.md's "tables and regexes are transcribed
 * programmatically" rule exists because two hand-maintained copies of one list drift, and
 * that is exactly the relationship this file has with the seed.
 */
function readSeededSkills(): { slug: string; aliases: string[] }[] {
  const sql = readFileSync(SEED_PATH, "utf8");
  const start = sql.indexOf("insert into skills");
  expect(start, "supabase/seed.sql must seed the skills table").toBeGreaterThan(-1);

  const end = sql.indexOf("on conflict (slug)", start);
  expect(end, "the skills insert must end with an on-conflict clause").toBeGreaterThan(-1);

  const block = sql.slice(start, end);
  const tuple = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*array\[([^\]]*)\]\s*(?:,\s*'([^']*)'\s*)?\)/g;

  const rows: { slug: string; aliases: string[] }[] = [];
  for (const match of block.matchAll(tuple)) {
    const [, , slug, aliasBlock] = match;
    // The slug group is mandatory in `tuple`, so this cannot fire — but a guard states that,
    // where `as string` would only assert it, and a wrong parse would otherwise be typed
    // into `rows` as if it were a real slug.
    if (slug === undefined) continue;

    const aliases = (aliasBlock ?? "")
      .split(",")
      .map((alias) => alias.trim().replace(/^'|'$/g, ""))
      .filter((alias) => alias.length > 0);
    rows.push({ slug, aliases });
  }

  expect(rows.length, "expected to parse at least one seeded skill").toBeGreaterThan(0);
  return rows;
}

describe("matchSkills — positives", () => {
  it("matches a skill named in the title", () => {
    expect(matchSkills("Senior TypeScript Engineer")).toEqual(["typescript"]);
  });

  it("matches skills named in the description", () => {
    const matched = matchSkills("Backend Engineer", "You will work with PostgreSQL and Docker daily.");
    expect(matched).toEqual(["docker", "postgresql"]);
  });

  it("matches dotted and squashed framework spellings", () => {
    expect(matchSkills("Built with React.js and Next.js")).toEqual(["nextjs", "react"]);
    expect(matchSkills("Built with ReactJS and NextJS")).toEqual(["nextjs", "react"]);
  });

  it("matches an alias rather than the canonical name", () => {
    expect(matchSkills("Orchestration with k8s")).toEqual(["kubernetes"]);
    expect(matchSkills("Managed services on amazon web services")).toEqual(["aws"]);
  });

  it("returns every vocabulary entry when the text names all of them", () => {
    const all = "TypeScript React Next.js PostgreSQL Tailwind Python AWS Docker Kubernetes GraphQL";
    expect(matchSkills(all)).toEqual(knownSkillSlugs());
  });
});

describe("matchSkills — the traps", () => {
  // The reason `next` is excluded from the nextjs patterns. Without this guard the corpus
  // fills with Next.js tags from the English word, and nothing anywhere reports a problem.
  it("does not read the English word 'next' as Next.js", () => {
    expect(matchSkills("What you will do next, and how we decide what comes next")).toEqual([]);
    expect(matchSkills("In your next step you will")).toEqual([]);
  });

  it("still matches Next.js in the same sentence that contains the word 'next'", () => {
    expect(matchSkills("You will ship Next.js features; the next sprint covers them")).toEqual([
      "nextjs",
    ]);
  });

  // notes.md 2026-10-04: `\b` stops at word characters, so a short alias embedded in a longer
  // word is the failure mode to guard. `py` must not fire inside `pytorch`, and the `ts`
  // alias must not fire inside `k8s`.
  it("does not match an alias embedded inside a longer word", () => {
    expect(matchSkills("PyTorch and k8s internals")).toEqual(["kubernetes"]);
    expect(matchSkills("We run tests in CI")).toEqual([]);
    expect(matchSkills("Configuration files")).toEqual([]);
  });

  it("does not let a wildcard leak in through an unescaped dot", () => {
    // `next.js` escaped matches only the literal; an unescaped `.` would match `nextxjs`.
    expect(matchSkills("nextxjs nextXjs")).toEqual([]);
  });

  it("matches a phrase across a line break", () => {
    expect(matchSkills("Tailwind\nCSS throughout")).toEqual(["tailwindcss"]);
  });
});

describe("matchSkills — empty and partial input", () => {
  it("returns an empty array when there is no text at all", () => {
    expect(matchSkills()).toEqual([]);
    expect(matchSkills(null, undefined, "")).toEqual([]);
  });

  it("still matches on the title when the description is absent", () => {
    expect(matchSkills("GraphQL Engineer", null)).toEqual(["graphql"]);
  });

  it("returns each skill once regardless of repetition", () => {
    expect(matchSkills("Python", "python python PYTHON")).toEqual(["python"]);
  });

  it("returns a sorted list so stored arrays are stable", () => {
    const once = matchSkills("Python and Rust, plus Go");
    const twice = matchSkills("Go, Rust, and Python");
    expect(once).toEqual(twice);
  });
});

describe("vocabulary drift guard", () => {
  const seeded = readSeededSkills();
  const seededSlugs = [...new Set(seeded.map((row) => row.slug))].sort();
  const mirrorSlugs = knownSkillSlugs();

  it("covers every slug the database seeds", () => {
    const missing = seededSlugs.filter((slug) => !mirrorSlugs.includes(slug));
    expect(
      missing,
      `supabase/seed.sql seeds skills the matcher cannot produce: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("invents no slug the database does not seed", () => {
    const extra = mirrorSlugs.filter((slug) => !seededSlugs.includes(slug));
    expect(
      extra,
      `the matcher emits slugs absent from the database vocabulary: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("recognises each seeded alias, except the ones deliberately excluded", () => {
    // `next` is the documented exception: an English word, excluded on purpose.
    const EXCLUDED_ALIASES = new Set(["next"]);

    const unrecognised: string[] = [];
    for (const row of seeded) {
      for (const alias of row.aliases) {
        if (EXCLUDED_ALIASES.has(alias.toLowerCase())) continue;
        if (matchSkills(`proficient in ${alias}`).length === 0) {
          unrecognised.push(`${row.slug} (alias "${alias}")`);
        }
      }
    }

    expect(
      unrecognised,
      `seeded aliases the matcher does not detect: ${unrecognised.join(", ")}`,
    ).toEqual([]);
  });

  it("declares a non-empty pattern list for every skill", () => {
    for (const skill of CANONICAL_SKILLS) {
      expect(skill.patterns.length, `${skill.slug} has no patterns`).toBeGreaterThan(0);
    }
  });
});
