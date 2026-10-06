/**
 * url-guard tests (docs/03 §6.2 S-05 — SSRF).
 *
 * The guard is the only thing between an admin-authored `sources.config.urls` entry and a
 * request to something that should never be reachable, so it is tested adversarially:
 * the cases below are the *bypass* attempts, not the happy path.
 *
 * The obfuscated IPv4 forms matter more than they look. `0177.0.0.1`, `2130706433` and
 * `127.1` are all loopback to a permissive parser; a check that validated "looks numeric"
 * and then fell through would be strictly worse than one that rejects them outright, because
 * it reads as a decision.
 */

import { describe, expect, it } from "vitest";

import { assertScrapeUrl, checkScrapeUrl } from "@/lib/connectors";

describe("checkScrapeUrl — accepted", () => {
  it.each([
    "https://careers.hooli.com/jobs",
    "https://boards.greenhouse.io/acme/jobs/1",
    "https://a.b.c.d.example.co.uk/careers",
    "https://example.com/",
    "https://xn--80ak6aa92e.com/jobs",
    "https://sub.domain.example.io:8443/careers",
    "https://8.8.8.8/jobs",
    "https://[2606:4700:4700::1111]/jobs",
  ])("allows %s", (url) => {
    expect(checkScrapeUrl(url)).toEqual({ ok: true });
  });
});

describe("checkScrapeUrl — refused", () => {
  it.each([
    ["http://careers.example.com/jobs", "scheme-not-https"],
    ["file:///etc/passwd", "scheme-not-https"],
    ["gopher://example.com/", "scheme-not-https"],
    ["ftp://example.com/jobs", "scheme-not-https"],
    ["javascript:alert(1)", "scheme-not-https"],
  ])("refuses %s as %s", (url, reason) => {
    expect(checkScrapeUrl(url)).toEqual({ ok: false, reason });
  });

  it.each([
    ["https://localhost/jobs", "localhost"],
    ["https://LOCALHOST/jobs", "case-insensitive localhost"],
    ["https://api.localhost/jobs", "localhost subdomain"],
    ["https://db.internal/jobs", ".internal suffix"],
    ["https://wiki.local/jobs", ".local suffix"],
    ["https://printer.localhost.localdomain/jobs", "fully-qualified localhost"],
    ["https://intranet/jobs", "single label, no dot"],
    ["https://build-server/jobs", "single label, no dot"],
  ])("refuses %s (%s)", (url) => {
    expect(checkScrapeUrl(url)).toEqual({ ok: false, reason: "private-address" });
  });

  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "10.255.255.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
  ])("refuses the loopback/private address %s", (host) => {
    expect(checkScrapeUrl(`https://${host}/jobs`)).toEqual({
      ok: false,
      reason: "private-address",
    });
  });

  it.each([
    ["100.64.0.1", "CGNAT low edge"],
    ["100.127.255.255", "CGNAT high edge"],
    ["198.18.0.1", "benchmarking range low edge"],
    ["198.19.255.255", "benchmarking range high edge"],
  ])("refuses %s (%s), a /10 or /15 the naive /24 rule would miss", (host) => {
    expect(checkScrapeUrl(`https://${host}/`)).toEqual({ ok: false, reason: "private-address" });
  });

  it.each([
    "100.63.255.255",
    "100.128.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "172.15.255.255",
    "172.32.0.1",
  ])("allows %s — just outside the reserved range", (host) => {
    // The counterpart to the case above: over-blocking is its own bug, and a guard that
    // rejected all of 172/8 or all of 100/8 would be quietly refusing public careers sites.
    expect(checkScrapeUrl(`https://${host}/`)).toEqual({ ok: true });
  });

  it.each([
    "https://0177.0.0.1/",
    "https://2130706433/",
    "https://127.1/",
    "https://0x7f.0.0.1/",
  ])("refuses the obfuscated loopback form %s", (url) => {
    // A parser that accepts these resolves them to 127.0.0.1. A single-label dotted form
    // is refused because it is not a public FQDN.
    expect(checkScrapeUrl(url).ok).toBe(false);
  });

  it.each([
    "https://[::1]/jobs",
    "https://[::]/jobs",
    "https://[fc00::1]/jobs",
    "https://[fd12:3456::1]/jobs",
    "https://[fe80::1]/jobs",
    "https://[::ffff:127.0.0.1]/jobs",
  ])("refuses the IPv6 private/loopback address %s", (url) => {
    expect(checkScrapeUrl(url)).toEqual({ ok: false, reason: "private-address" });
  });

  it("refuses credentials embedded in the URL", () => {
    // Otherwise the credentials land in every structured log line and every redirect.
    expect(checkScrapeUrl("https://user:pass@careers.example.com/jobs")).toEqual({
      ok: false,
      reason: "credentials-in-url",
    });
  });

  it("refuses a trailing-dot localhost", () => {
    // `localhost.` is a distinct hostname string that still resolves to loopback.
    expect(checkScrapeUrl("https://localhost./jobs")).toEqual({
      ok: false,
      reason: "private-address",
    });
  });

  it.each(["not a url", "", "://missing-scheme", "https://"])("refuses %j", (url) => {
    expect(checkScrapeUrl(url).ok).toBe(false);
  });
});

describe("assertScrapeUrl", () => {
  it("returns the URL when it passes", () => {
    expect(assertScrapeUrl("https://careers.example.com/jobs")).toBe(
      "https://careers.example.com/jobs",
    );
  });

  it("throws validation_failed naming the reason, not a raw TypeError", () => {
    // An untyped TypeError from the URL constructor reaches the run log without saying
    // which URL was refused or why, which is the whole diagnostic value of the message.
    expect(() => assertScrapeUrl("http://internal/jobs")).toThrow(/scheme-not-https/);
    try {
      assertScrapeUrl("http://internal/jobs");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toMatchObject({ code: "validation_failed" });
    }
  });
});