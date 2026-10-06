/**
 * url-guard.ts — SSRF validation for user-supplied scrape targets (docs/03 §6.2 S-05).
 *
 * ## The rule
 *
> S-05 | SSRF via a user-supplied scrape URL | Firecrawl only accepts URLs from
> `sources.config`, which admins authorise; the connector validates scheme (`https` only),
> rejects private IP ranges/localhost, and caps redirects. Free users can't add arbitrary
> URLs at all.
 *
 * Three checks, and all three are load-bearing:
 *
 * 1. **`https` only.** `http://` would let a target on a plaintext link be rewritten
 *    in transit; `file://`, `gopher://`, `ftp://` are schemes a fetch layer may honour and
 *    an attacker controls.
 * 2. **No private or reserved addresses.** `https://169.254.169.254/latest/meta-data/` is
 *    the cloud metadata endpoint. Firecrawl runs the request *from its own network*, so
 *    that is not our problem — but a source whose URL is `https://internal.corp/` reveals
 *    what is reachable, and our own redirect-following would too.
 * 3. **No localhost, in hostnames or in literal IPs.** A name that resolves to
 *    `127.0.0.1` is the same request as the literal address.
 *
 * ## What this cannot do, and why it does not pretend to
 *
 * A hostname check is a *name* check. `https://evil.test/` can resolve to `10.0.0.1` at
 * DNS-resolution time, and nothing in this module can see that. Closing it properly needs
 * resolution plus a check on the resolved address, and — because DNS rebinding can change
 * the answer between the check and the connection — a resolver that pins the address it
 * validated. That is Firecrawl's job, not ours: we hand it a URL, it fetches it.
 *
 * What we can do is refuse the addresses and names that are private *by name or literal*,
 * which is the documented control and covers the realistic case of a mistyped or
 * deliberately-targeted internal host. The limit is stated here rather than left for a
 * reader to assume the module is complete.
 */

import { AppError } from "@/lib/errors";

/** Why a URL was refused. Surfaced so the ops log explains a paused source. */
export type UrlRejection =
  | "not-a-url"
  | "scheme-not-https"
  | "credentials-in-url"
  | "private-address"
  | "no-hostname";

export interface UrlCheck {
  ok: boolean;
  reason?: UrlRejection;
}

/**
 * Hostnames that name the local machine or a local network, regardless of TLD.
 *
 * Compared against the whole hostname *and* its labels, so `localhost`, `LOCALHOST`,
 * `foo.localhost`, `api.localhost` and `localhost.evil.com` are all caught. The
 * `.localhost` and `.local` suffixes are reserved (RFC 6761) precisely because they can
 * never be public.
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".intranet"];

/**
 * IPv4 ranges that must never be reachable from a scrape target, as CIDR.
 *
 * Written as CIDR strings and parsed once, rather than as hand-written octet comparisons.
 * That was the first attempt and it was wrong in a way only a test caught: a table of
 * `[first, second]` pairs reads like a prefix table but matches only an exact `/24` prefix,
 * so `[10, 10]` refused `10.10.x.x` and **allowed `10.0.0.1`**. Same for `127.0.0.1`,
 * `169.254.169.254` and `255.255.255.255` — a private-address filter that permits a
 * private address is worse than none, because it looks like a control.
 */
const PRIVATE_IPV4_CIDR = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // RFC1918
  "100.64.0.0/10", // RFC6598 carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local — 169.254.169.254 is the cloud metadata endpoint
  "172.16.0.0/12", // RFC1918
  "192.0.0.0/24", // IETF protocol assignments
  "192.168.0.0/16", // RFC1918
  "198.18.0.0/15", // benchmarking
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, incl. 255.255.255.255
] as const;

interface Cidr {
  network: number;
  mask: number;
}

/** Parse "a.b.c.d/n" into a 32-bit network address and mask. Runs once at module load. */
function parseCidr(cidr: string): Cidr {
  const [address, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const value = (address ?? "")
    .split(".")
    .reduce((acc, octet) => (acc << 8) | Number(octet), 0);
  // A /0 mask must be 0, not 0xFFFFFFFF — `>>> 0` on that yields -1 in JS.
  return { network: value >>> 0, mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 };
}

const PRIVATE_IPV4_RANGES: readonly Cidr[] = PRIVATE_IPV4_CIDR.map(parseCidr);

/**
 * Check a dotted-quad against the private/reserved ranges.
 *
 * A non-quad form returns false: the WHATWG URL parser has already normalised `0177.0.0.1`,
 * `0x7f.0.0.1`, `127.1` and `2130706433` into dotted quads by the time the hostname reaches
 * here, so anything left in one of those shapes is not an IPv4 address and must not be
 * treated as a public one either.
 */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;

  let value = 0;
  for (const part of parts) {
    // Strictly 1-3 digits and no leading-zero shorthand. Defensive rather than reachable:
    // normalisation upstream should have removed these.
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    value = (value << 8) | octet;
  }
  const address = value >>> 0;

  // `&` is a *signed* 32-bit operation in JS: for any address at or above 2^31 it yields a
  // negative int32, which can never equal the unsigned `network`. Without the `>>> 0` every
  // range whose network has the top bit set — 172.16/12, 192.168/16, 169.254/16, 224/4,
  // 198.18/15, 255.255.255.255 — silently matched nothing. That is the shape of bug a
  // security filter must not have: it reported as working and permitted the address.
  return PRIVATE_IPV4_RANGES.some(({ network, mask }) => ((address & mask) >>> 0) === network);
}

/**
 * IPv6 loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), and the
 * IPv4-mapping prefixes.
 *
 * The mapping prefixes are refused outright rather than decoded. `::ffff:0:0/96` and
 * `64:ff9b::/96` exist only to carry an IPv4 address inside an IPv6 packet, and no public
 * careers page is served over one — so decoding the embedded address and re-checking it
 * would add code to protect a case that cannot occur, while *not* handling it would let a
 * loopback-mapped URL through. Refusing is the conservative reading.
 *
 * The URL parser rewrites `https://[::ffff:127.0.0.1]/` to `[::ffff:7f00:1]`, so the dotted
 * form never arrives here — which is exactly why the prefix is matched textually below
 * rather than by looking for the IPv4 part.
 */
function isPrivateIpv6(host: string): boolean {
  const bare = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!bare.includes(":")) return false;
  // Strip a zone id (`fe80::1%eth0`) before comparing.
  const address = bare.split("%")[0] ?? bare;
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("::ffff:") ||
    address.startsWith("64:ff9b:") ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89ab]/.test(address)
  );
}

/**
 * Validate a scrape target URL.
 *
 * Never throws — the caller decides whether a refusal ends the run or skips one URL.
 */
export function checkScrapeUrl(candidate: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "not-a-url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "scheme-not-https" };

  // `https://user:pass@evil.test/` would put credentials in every log line and redirect.
  if (url.username || url.password) return { ok: false, reason: "credentials-in-url" };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  if (host.startsWith("[")) {
    return isPrivateIpv6(host) ? { ok: false, reason: "private-address" } : { ok: true };
  }
  if (host.length === 0) return { ok: false, reason: "no-hostname" };

  if (isPrivateIpv4(host)) return { ok: false, reason: "private-address" };
  if (isPrivateIpv6(host)) return { ok: false, reason: "private-address" };

  if (LOCAL_HOSTNAMES.has(host)) return { ok: false, reason: "private-address" };
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "private-address" };
  }
  // A bare label with no dot cannot be a public FQDN.
  if (!host.includes(".")) return { ok: false, reason: "private-address" };

  return { ok: true };
}

/**
 * Validate a scrape target, throwing the refusal as a typed error.
 *
 * @throws {AppError} `validation_failed` naming the reason — never an untyped `TypeError`
 *         from the URL constructor, which would reach the run log without saying which
 *         URL was refused or why.
 */
export function assertScrapeUrl(candidate: string): string {
  const check = checkScrapeUrl(candidate);
  if (check.ok) return candidate;
  throw new AppError("validation_failed", {
    message: `refused scrape URL "${candidate}": ${check.reason}`,
  });
}