// @vitest-environment jsdom
/**
 * job-detail-components.test.tsx — the FE-109 disclosure, the JOB-001 description, and the
 * JOB-004 sighting picker (FE-108, FE-109, JOB-004).
 *
 * ## What is asserted here and why it is structural
 *
 * Phase 2 owns behaviour and semantics; Phase 3 owns appearance (docs/06 §8.4). So these tests
 * assert what is *true* of a component rather than how it looks: a disclosure that reports its
 * state, a collapsed description that hides content from assistive technology rather than
 * merely clipping it, a link that carries `rel="noopener noreferrer"`.
 *
 * Two of them are the reason this file exists at all rather than a copy of the feed tests:
 *
 *  - **`Read more` must remove the hidden blocks from the DOM**, not hide them with CSS. Content
 *    that is visually truncated is still read aloud in full by a screen reader, so a long
 *    posting announced end-to-end is a worse outcome than one honestly reported as truncated.
 *  - **Selecting an alternate sighting must move the `href` of "View original"** (JOB-004). That
 *    link and the list share state, so a regression here is a silent "two controls disagree"
 *    bug rather than an obvious one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ScoreBreakdown } from "@/components/job/score-breakdown";
import { JobDescription } from "@/components/job/description";
import { OriginalSource } from "@/components/job/original-source";
import { parseJobDescription } from "@/lib/sanitize/job-description";
import type { JobSighting } from "@/lib/db/queries/sightings";

const BREAKDOWN = [
  { key: "skills", weight: 35, raw: 0.71, points: 24.9, known: true },
  { key: "seniority", weight: 15, raw: 0.75, points: 11.3, known: true },
  { key: "recency", weight: 10, raw: 0.6, points: 6, known: false },
];

const SIGHTINGS: JobSighting[] = [
  {
    source_id: "11111111-1111-4111-8111-111111111111",
    source_url: "https://boards.greenhouse.example/acme/1",
    first_seen_at: "2026-10-01T00:00:00.000000+00:00",
    last_seen_at: "2026-10-12T00:00:00.000000+00:00",
    sighting_count: 3,
  },
  {
    source_id: "22222222-2222-4222-8222-222222222222",
    source_url: "https://jobs.lever.example/acme/1",
    first_seen_at: "2026-10-05T00:00:00.000000+00:00",
    last_seen_at: "2026-10-13T00:00:00.000000+00:00",
    sighting_count: 1,
  },
];

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("ScoreBreakdown", () => {
  function setup(overrides: Partial<Parameters<typeof ScoreBreakdown>[0]> = {}) {
    render(
      <ScoreBreakdown
        finalScore={78.4}
        ruleScore={76}
        semanticScore={82}
        breakdown={BREAKDOWN}
        gateReasons={null}
        explanation="Strong skill overlap."
        {...overrides}
      />,
    );
  }

  it("starts collapsed and reports its state", () => {
    setup();
    const toggle = screen.getByRole("button", { name: /Why this score/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls");
  });

  it("is operable by keyboard and flips aria-expanded", async () => {
    setup();
    const toggle = screen.getByRole("button", { name: /Why this score/ });

    toggle.focus();
    expect(toggle).toHaveFocus();
    // A real <button>, so Enter and Space both work without a keydown handler.
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("points aria-controls at the element it actually controls", async () => {
    setup();
    const toggle = screen.getByRole("button", { name: /Why this score/ });
    await userEvent.click(toggle);
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("id", toggle.getAttribute("aria-controls"));
  });

  it("hides its content from assistive technology while collapsed", () => {
    // `hidden` rather than removal from the DOM, which is the canonical mechanism for a
    // disclosure: the content is genuinely collapsed, not truncated, so keeping it in the
    // document is correct and makes reopening free. The assertion is `not.toBeVisible()`
    // rather than `queryBy… === null` — the difference between the two is exactly what this
    // test exists to pin.
    setup();
    expect(screen.queryByText("Strong skill overlap.")).not.toBeVisible();
    expect(screen.getByRole("button", { name: /Why this score/ })).toHaveAttribute(
      "aria-controls",
    );
  });

  it("shows a total, so the rows can be checked against it", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    expect(screen.getByText(/Total:/)).toHaveTextContent("78");
    expect(screen.getByText(/Total:/)).toHaveTextContent("from rules (76)");
    expect(screen.getByText(/Total:/)).toHaveTextContent("and meaning (82)");
  });

  it("names every component rather than printing its key", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    // docs/04 §3.4's labels: "Skills", "Seniority", "Work mode", "Company pref".
    expect(screen.getByRole("rowheader", { name: /^Skills/ })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: /^Seniority/ })).toBeInTheDocument();
    expect(screen.queryByText(/^company-preference$/)).toBeNull();
  });

  it("shows points against the component's maximum", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    expect(screen.getByRole("rowheader", { name: /^Skills/ }).closest("tr")).toHaveTextContent(
      "24.9 / 35",
    );
  });

  it("marks a component that had no data to judge", async () => {
    // `known: false` means `raw` is a neutral default. Printing "6.0 / 10" without this would
    // read as evidence of a weak recency score when nothing was measured.
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    expect(
      screen.getByRole("rowheader", { name: /Recency \(not enough data to judge\)/ }),
    ).toBeInTheDocument();
  });

  it("shows the blend separately, because it is not a seventh component", async () => {
    // SEMANTIC_BLEND is 0.5, so the blend is its own line rather than another weighted row —
    // printing it as a row would double-count it against the total above.
    setup();
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    expect(screen.getByText(/Meaning contributes 50%/)).toBeInTheDocument();
    // Not a table row. `queryBy…`, because `getByRole` throws when nothing matches — asserting
    // "toBeUndefined()" on a `getByRole` call would pass for the wrong reason.
    expect(screen.queryByRole("row", { name: /Meaning contributes/ })).toBeNull();
  });

  it("explains a gated job in plain English, not in stored codes", async () => {
    // JOB-002's fourth done-when. The codes are the data contract and are meaningless here.
    setup({ gateReasons: ["blocked_company", "salary_below_floor"], finalScore: 0 });

    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));

    expect(screen.getByText("Why this job is not in your feed")).toBeInTheDocument();
    expect(screen.getByText("You asked to avoid this company.")).toBeInTheDocument();
    expect(screen.getByText("The salary is below the minimum you set.")).toBeInTheDocument();
    expect(screen.queryByText(/blocked_company/)).toBeNull();
  });

  it("shows no exclusion section when the gate passed", async () => {
    setup({ gateReasons: [] });
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    expect(screen.queryByText("Why this job is not in your feed")).toBeNull();
  });

  it("says so when there is no breakdown rather than rendering an empty table", async () => {
    setup({ breakdown: null });
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    expect(screen.getByText(/No component breakdown was recorded/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("omits the blend when there is no semantic score", async () => {
    // `semanticScore: null` is a supported state (BE-203: the job has no embedding), not an
    // error. A "50% of nothing" line would be a claim about a number that does not exist.
    setup({ semanticScore: null });
    await userEvent.click(screen.getByRole("button", { name: /Why this score/ }));
    expect(screen.queryByText(/Meaning contributes/)).toBeNull();
  });
});

describe("JobDescription", () => {
  const LONG = parseJobDescription(
    "<p>One</p><p>Two</p><p>Three</p><p>Four</p><p>Five</p>",
  );

  it("renders every block when there are few enough", () => {
    render(<JobDescription nodes={parseJobDescription("<p>Only one</p>")} />);
    expect(screen.getByText("Only one")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read more/ })).toBeNull();
  });

  it("collapses a long description and reports its state", () => {
    render(<JobDescription nodes={LONG} />);
    const toggle = screen.getByRole("button", { name: "Read more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Three")).toBeInTheDocument();
  });

  it("removes the hidden blocks from the DOM rather than clipping them", async () => {
    // The point of the test. `display:none` is skipped by screen readers, but content that is
    // only visually truncated is still announced in full — so a long posting would be read
    // end to end by a screen-reader user while the sighted user sees three paragraphs.
    render(<JobDescription nodes={LONG} />);
    expect(screen.queryByText("Five")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Read more" }));

    expect(screen.getByText("Five")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("Five")).toBeNull();
  });

  it("renders the sanitised structure, never raw HTML", () => {
    render(
      <JobDescription
        nodes={parseJobDescription(
          "<h3>About</h3><ul><li>TypeScript</li></ul><script>alert(1)</script>",
        )}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "About" })).toBeInTheDocument();
    // A `listitem` takes its accessible name from the author, not from contents, so it has an
    // empty accessible name — the assertion is on its text, not on `getByRole(name)`.
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("TypeScript")).toBeInTheDocument();
    // The unterminated <script> is dropped with its content, not merely unwrapped.
    expect(document.body.innerHTML).not.toContain("alert(1)");
    expect(document.body.innerHTML).not.toContain("<script");
  });

  it("renders an unsafe link's text without a link", () => {
    render(
      <JobDescription nodes={parseJobDescription('<a href="javascript:alert(1)">Apply here</a>')} />,
    );
    expect(screen.getByText("Apply here")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("marks a real external link with rel=noopener noreferrer", () => {
    render(
      <JobDescription nodes={parseJobDescription('<a href="https://acme.example/x">Posting</a>')} />,
    );
    const link = screen.getByRole("link", { name: "Posting" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows the empty message when there is no description", () => {
    render(<JobDescription nodes={[]} />);
    expect(screen.getByText(/did not include a description/)).toBeInTheDocument();
  });
});

describe("OriginalSource", () => {
  const PRIMARY = "https://boards.greenhouse.example/acme/1";

  function setup(overrides: Partial<Parameters<typeof OriginalSource>[0]> = {}) {
    render(
      <OriginalSource
        primaryUrl={PRIMARY}
        applyUrl={null}
        sightings={SIGHTINGS}
        {...overrides}
      />,
    );
  }

  it("offers View original pointing at the primary posting", () => {
    setup();
    const link = screen.getByRole("link", { name: "View original" });
    expect(link).toHaveAttribute("href", PRIMARY);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("lists every sighting, including the one already selected", () => {
    // N-1 alternates beside a button pointing somewhere else is the confusing arrangement:
    // the reader cannot tell which row the main link goes to.
    setup();
    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("boards.greenhouse.example")).toBeInTheDocument();
    expect(screen.getByText("jobs.lever.example")).toBeInTheDocument();
  });

  it("marks the current sighting instead of offering a redundant button", () => {
    setup();
    expect(screen.getByText(/— view original/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "boards.greenhouse.example" })).toBeNull();
  });

  it("repoints View original when an alternate is selected", async () => {
    // JOB-004's third done-when. If this regresses, the page shows two controls that
    // disagree about which posting is current — silently, because both still render.
    setup();
    await userEvent.click(screen.getByRole("button", { name: "jobs.lever.example" }));

    expect(screen.getByRole("link", { name: "View original" })).toHaveAttribute(
      "href",
      "https://jobs.lever.example/acme/1",
    );
    expect(screen.getByText(/— view original/)).toBeInTheDocument();
  });

  it("reports how many times a source was seen", () => {
    setup();
    expect(screen.getByText(/seen 3 times/)).toBeInTheDocument();
    expect(screen.queryByText(/seen 1 times/)).toBeNull();
  });

  it("omits the Apply link when there is no apply_url", () => {
    // A link that goes nowhere is worse than no link.
    setup({ applyUrl: null });
    expect(screen.queryByRole("link", { name: "Apply" })).toBeNull();
  });

  it("offers Apply with the same rel when one exists", () => {
    setup({ applyUrl: "https://acme.example/apply/1" });
    const apply = screen.getByRole("link", { name: "Apply" });
    expect(apply).toHaveAttribute("href", "https://acme.example/apply/1");
    expect(apply).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("treats no sightings as a normal state, not an error", () => {
    setup({ sightings: [] });
    expect(screen.getByText(/No other sources have recorded this role/)).toBeInTheDocument();
    // The link still works — only the list is absent.
    expect(screen.getByRole("link", { name: "View original" })).toHaveAttribute("href", PRIMARY);
  });
});
