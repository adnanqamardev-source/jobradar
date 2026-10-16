/**
 * application-stages.test.ts — the TS transition map must match the SQL that enforces it.
 *
 * ## Why this test exists
 *
 * `move_application` (0001, replaced by 0015) is the authority on which stage moves are legal.
 * `src/lib/tracker/stages.ts` duplicates that knowledge so the UI can offer only legal moves
 * instead of offering controls the server refuses.
 *
 * Two copies of a rule is a duplication that will drift, and the drift is **silent**: the board
 * keeps rendering a move, the user clicks it, and the server rejects it. No test anywhere goes
 * red, because each copy is internally consistent.
 *
 * So this file parses the rules out of the SQL and fails when the two disagree. The same
 * technique `queue-kind-vocabulary.test.ts` uses to keep `taskKindSchema` in step with the
 * `task_kind` enum — and the reason that file exists is a kind the database rejected at runtime.
 *
 * The parser reads the `raise exception` guards, in the form:
 *
 *   if v_from = 'applied' and to_stage not in ('screening','rejected','withdrawn') then
 *
 * It asserts each transition the SQL permits, each transition it does not, and the terminal-stage
 * rule. It deliberately does **not** import the SQL, so a reformatting that changes the parse
 * fails loudly here rather than silently matching nothing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APPLICATION_STAGES,
  BOARD_STAGES,
  STAGE_LABELS,
  STAGE_TRANSITIONS,
  TERMINAL_STAGES,
  isLegalMove,
  legalMoves,
  type ApplicationStage,
} from "@/lib/tracker/stages";

const SQL_PATH = fileURLToPath(new URL("../../supabase/migrations/0015_secure_move_application.sql", import.meta.url));

const sql = readFileSync(SQL_PATH, "utf8");

/** `v_from = 'X' and to_stage not in ('a','b','c')` -> `{ from: 'X', not: ['a','b','c'] }` */
function parseGuards(source: string): { from: ApplicationStage; not: ApplicationStage[] }[] {
  const pattern = /v_from\s*=\s*'(\w+)'\s+and\s+to_stage\s+not\s+in\s*\(([^)]*)\)/g;
  const guards: { from: ApplicationStage; not: ApplicationStage[] }[] = [];

  for (const match of source.matchAll(pattern)) {
    const not = (match[2] ?? "")
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""))
      .filter((value) => value.length > 0) as ApplicationStage[];
    guards.push({ from: match[1] as ApplicationStage, not });
  }

  return guards;
}

const guards = parseGuards(sql);

describe("move_application transitions — SQL is the authority", () => {
  it("parses the guards out of the migration", () => {
    // A parser that matches nothing would make every assertion below vacuously true, which is
    // worse than no test. Six non-terminal stages, so six guards.
    expect(guards).toHaveLength(6);
    expect(guards.map((g) => g.from).sort()).toEqual(
      ["applied", "discovered", "interview", "offer", "saved", "screening"].sort(),
    );
  });

  it("grants exactly the transitions the SQL permits", () => {
    for (const guard of guards) {
      // Read the SQL semantics carefully, because an earlier draft of this test had them
      // backwards. The guard is:
      //
      //     if v_from = 'applied' and to_stage not in ('screening','rejected','withdrawn') then
      //       raise exception 'Invalid transition from applied';
      //
      // It **raises** when the target is NOT in the list — so the listed values are precisely
      // the permitted ones. Treating the list as the *rejected* set produced "SQL allows
      // discovered -> everything except saved", which is nonsense, and failed against a map that
      // was right all along.
      expect(
        [...STAGE_TRANSITIONS[guard.from]].sort(),
        `SQL permits ${guard.from} -> ${guard.not.join(", ")} but stages.ts says otherwise`,
      ).toEqual([...guard.not].sort());
    }
  });

  it("offers nothing the SQL rejects", () => {
    // The direction that matters at runtime: anything this file would let a user click must be
    // in the SQL's permitted list. `guard.not` *is* the permitted list, as above.
    for (const [from, targets] of Object.entries(STAGE_TRANSITIONS) as [
      ApplicationStage,
      readonly ApplicationStage[],
    ][]) {
      const guard = guards.find((g) => g.from === from);
      if (guard === undefined) continue; // terminal stages covered separately

      for (const to of targets) {
        expect(
          guard.not.includes(to),
          `stages.ts offers ${from} -> ${to}, which move_application rejects`,
        ).toBe(true);
      }
    }
  });

  it("rejects a same-stage move, matching the SQL's 'Already in target stage'", () => {
    // The SQL has an explicit guard for this before the transition table is consulted. Offering
    // a no-op control would produce an error toast for doing nothing.
    expect(sql).toMatch(/if v_from = to_stage then\s+raise exception 'Already in target stage'/);
    expect(isLegalMove("saved", "saved")).toBe(false);
    expect(isLegalMove("interview", "interview")).toBe(false);
  });

  it("agrees with the SQL that terminal stages are terminal", () => {
    // The SQL raises unconditionally for rejected/withdrawn; there is no `not in (...)` guard for
    // them, so they appear in no guard's permitted set and must have no outgoing edges here.
    expect(sql).toMatch(/v_from in \('rejected','withdrawn'\) then/);
    for (const stage of TERMINAL_STAGES) {
      expect(STAGE_TRANSITIONS[stage], `${stage} must be terminal`).toEqual([]);
      expect(legalMoves(stage)).toEqual([]);
    }
  });

  it("names every stage the database can hold", () => {
    // A stage in the enum but missing from the label map renders as `undefined` in the UI, which
    // is a blank dropdown option rather than an error.
    for (const stage of APPLICATION_STAGES) {
      expect(STAGE_LABELS[stage], `no label for ${stage}`).toBeTruthy();
    }
    expect(Object.keys(STAGE_LABELS).sort()).toEqual([...APPLICATION_STAGES].sort());
  });

  it("declares the SQL enum in the same order it does", () => {
    // Order is the pipeline the board renders left-to-right, so it is a contract, not cosmetics.
    const sqlEnum = (/create type\s+public\.app_stage[^;]*as enum \(([^)]*)\)/i.exec(sql))?.[1] ?? "";
    const fromSql = sqlEnum
      .split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    // 0015 replaces the function, not the enum, so read the enum from 0001 where it is declared.
    const enumSql = readFileSync(
      fileURLToPath(new URL("../../supabase/migrations/0001_init.sql", import.meta.url)),
      "utf8",
    );
    const declared = (/create type\s+app_stage\s+as enum \(([^)]*)\)/i.exec(enumSql))?.[1] ?? "";

    expect(declared).not.toBe("");
    expect([...APPLICATION_STAGES]).toEqual(
      declared
        .split(",")
        .map((value) => value.trim().replace(/^'|'$/g, ""))
        .filter(Boolean),
    );
    expect(fromSql).toBeDefined();
  });
});

describe("legalMoves / isLegalMove", () => {
  it("excludes the current stage", () => {
    expect(legalMoves("saved")).not.toContain("saved");
    expect(legalMoves("saved")).toEqual(["applied", "discovered"]);
  });

  it("returns nothing for a terminal stage, so the control can disappear", () => {
    for (const stage of TERMINAL_STAGES) {
      expect(legalMoves(stage)).toEqual([]);
    }
  });

  it("renders every board column as a known stage", () => {
    for (const stage of BOARD_STAGES) {
      expect(APPLICATION_STAGES).toContain(stage);
    }
    // `discovered` and `saved` are pre-application states owned by the feed, not the tracker.
    expect(BOARD_STAGES).not.toContain("discovered");
    expect(BOARD_STAGES).not.toContain("saved");
  });
});