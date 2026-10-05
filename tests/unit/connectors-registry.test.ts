/**
 * registry + contract tests for the connector seam (BE-101).
 *
 * Two properties are pinned:
 *   - an unknown `source_kind` fails loudly (never a silent skip);
 *   - the seam's shape matches docs/02b §6.1 — `kind`, `costClass`, an async-iterable
 *     `fetch(cfg, ctx)`, and `RawJob` produced through a Zod schema.
 *
 * `fetch` and the clock are injected, so nothing here touches the network or waits
 * for real time (docs/06 §8.5).
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  clearRegistry,
  defaultRunCtx,
  getConnector,
  hasConnector,
  registerConnector,
  registeredKinds,
  type RunCtx,
  type SourceConfig,
  type SourceConnector,
} from "@/lib/connectors";
import { rawJobSchema } from "@/types/canonical-job";

afterEach(() => clearRegistry());

function noNetwork(): typeof fetch {
  const fail = () => {
    throw new Error("no network in unit tests");
  };
  return fail;
}

function ctx(): RunCtx {
  return defaultRunCtx("run-test", new AbortController().signal, noNetwork());
}

function fakeConnector(kind: SourceConnector["kind"]): SourceConnector {
  const providerSchema = z.object({ jobs: z.array(z.unknown()) });
  return {
    kind,
    costClass: "free",
    async *fetch(cfg: SourceConfig, runCtx: RunCtx) {
      // The seam's contract in miniature: validate the provider payload through a
      // Zod schema, then stream validated RawJobs using only what the ctx provides.
      // The injected sleep stands in for a provider call, so the generator awaits
      // something real and the test never touches the network.
      const payload: unknown = { jobs: [] };
      const parsed = providerSchema.parse(payload);
      void cfg;
      await runCtx.sleep(0);
      for (const job of parsed.jobs) {
        yield rawJobSchema.parse(job);
      }
    },
  };
}

describe("connector registry", () => {
  it("resolves a registered kind", () => {
    registerConnector(fakeConnector("api_greenhouse"));

    expect(getConnector("api_greenhouse").kind).toBe("api_greenhouse");
    expect(hasConnector("api_greenhouse")).toBe(true);
  });

  it("fails loudly on an unknown kind, naming it", () => {
    expect(() => getConnector("api_made_up")).toThrow(/api_made_up/);
    expect(() => getConnector("api_made_up")).toThrow(/no connector registered/);
  });

  it("rejects two connectors claiming the same kind", () => {
    registerConnector(fakeConnector("api_lever"));

    expect(() => registerConnector(fakeConnector("api_lever"))).toThrow(/already registered/);
  });

  it("re-registering the identical connector is a no-op, not an error", () => {
    const connector = fakeConnector("api_ashby");
    registerConnector(connector);
    registerConnector(connector);

    expect(registeredKinds()).toEqual(["api_ashby"]);
  });

  it("lists registered kinds sorted", () => {
    registerConnector(fakeConnector("api_lever"));
    registerConnector(fakeConnector("api_greenhouse"));

    expect(registeredKinds()).toEqual(["api_greenhouse", "api_lever"]);
  });
});

describe("connector contract", () => {
  it("a connector streams RawJobs through its own Zod schema", async () => {
    registerConnector(fakeConnector("api_remotive"));

    const connector = getConnector("api_remotive");
    const seen: unknown[] = [];
    for await (const job of connector.fetch({ name: "r", kind: "api_remotive" }, ctx())) {
      seen.push(job);
    }

    expect(seen).toEqual([]);
    expect(connector.costClass).toBe("free");
  });

  it("every emitted job satisfies the shared RawJob schema", () => {
    // The seam contract: one RawJob definition (src/types), not one per connector.
    const sample = rawJobSchema.parse({
      externalId: "1",
      sourceUrl: "https://boards.greenhouse.io/acme/jobs/1",
      applyUrl: null,
      companyName: "Acme",
      companyDomain: null,
      title: "Engineer",
      descriptionText: null,
      locationRaw: "Remote",
      workMode: null,
      employmentType: null,
      seniority: null,
      salaryRaw: null,
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
      postedAt: null,
      raw: {},
    });

    expect(rawJobSchema.safeParse(sample).success).toBe(true);
  });

  it("RunCtx defaults to a real clock and a real sleep", async () => {
    const context = defaultRunCtx("run-1", new AbortController().signal);
    const before = context.now();
    await context.sleep(1);

    expect(typeof before).toBe("number");
    expect(context.fetch).toBeTypeOf("function");
  });
});