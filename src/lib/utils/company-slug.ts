/**
 * company-slug.ts — one normaliser for company identity (docs/02 §6.2, §5.3).
 *
 * ## Why this module exists
 *
 * Three places need to agree on what "the same company" means, and each of them
 * used to disagree:
 *
 *  1. `dedupe.ts` (BE-107) builds `dedupe_hash` from `norm_company_domain`.
 *  2. The `blocked_company` gate (SCR-001) matches `profiles.blocked_companies`.
 *  3. `update-dealbreakers` (BE-304) *writes* `profiles.blocked_companies`.
 *
 * docs/02a §5.3 says `blocked_companies` holds "normalised slugs", but the BE-304
 * action only did `trim().toLowerCase()`. So a user who typed "Acme Corp." stored
 * the literal string `acme corp.`, and any gate comparing it to a slugified job
 * would never match — the dealbreaker silently did nothing. Writing and matching
 * have to use the same function or the gate is decorative.
 *
 * ## What a slug is here
 *
 * Lowercase, strip a leading `www.`, keep only `a-z0-9`, collapse everything else
 * to a single hyphen, trim hyphens. `"Acme Corp."` → `acme-corp`, `"ACME  CORP"` →
 * `acme-corp`, `"  acme corp  "` → `acme-corp`.
 *
 * Legal suffixes are deliberately **not** stripped. docs/02b §6.2 strips `Inc` /
 * `Ltd` / `GmbH` when building a dedupe hash, but that is a different job: dedupe
 * wants "the same posting seen twice", whereas a blocklist wants "the company the
 * user named". Collapsing "Acme" and "Acme Inc" into one slug would block a company
 * the user never blocked. The two normalisers are kept apart on purpose.
 */

/** Legal/entity suffixes, matched only as whole trailing words. */
const LEGAL_SUFFIXES = [
  "inc",
  "inc.",
  "llc",
  "l.l.c.",
  "ltd",
  "ltd.",
  "limited",
  "corp",
  "corp.",
  "corporation",
  "co",
  "co.",
  "company",
  "gmbh",
  "ag",
  "plc",
  "llp",
  "lp",
  "sa",
  "sas",
  "bv",
  "nv",
  "pty",
  "pvt",
  "private",
  "limited",
] as const;

/**
 * Strip trailing legal suffixes from an already-slugified token list.
 *
 * `options.stripLegalSuffix` is opt-in and **off by default**. Only dedupe should
 * turn it on — see the module docstring.
 */
export function stripLegalSuffixes(
  tokens: string[],
  options: { stripLegalSuffix?: boolean } = {},
): string[] {
  if (options.stripLegalSuffix !== true) return tokens;

  const out = [...tokens];
  // Loop rather than a single pass: "Acme Holdings Inc" must lose both words, and
  // one pass leaves "holdings" as the new last token.
  while (out.length > 1) {
    const last = out[out.length - 1];
    if (last === undefined || !(LEGAL_SUFFIXES as readonly string[]).includes(last)) break;
    out.pop();
  }
  return out;
}

/** Normalise a company *name* to its slug. */
export function companyNameToSlug(name: string, options = { stripLegalSuffix: false }): string {
  const cleaned = name
    .normalize("NFKD")
    // Strip combining marks so "Café" → "cafe", not "caf".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return stripLegalSuffixes(cleaned.split("-").filter(Boolean), options).join("-");
}

/**
 * Normalise a company *domain* to its slug.
 *
 * Returns `null` for anything that is not a plausible domain — a job whose
 * `company_domain` is a free-text location or an ATS path is common enough that
 * sloughing it into a slug would produce junk that could match a blocklist entry.
 * `null` means "no usable domain", and callers must fall back to the name.
 */
export function companyDomainToSlug(domain: string | null | undefined): string | null {
  if (!domain) return null;

  // Take the host: strip scheme, credentials, port, and any path.
  let host = domain.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split("/")[0] ?? "";
  host = host.split("@").pop() ?? "";
  host = host.split(":")[0] ?? "";
  host = host.replace(/^www\./, "");

  // A domain must have at least one dot and a plausible TLD. Rejecting here keeps
  // "greenhouse.io" style hosts but drops "Acme" / "talent" / "" / "n/a".
  //
  // The TLD is measured from the LAST dot, not the first. Taking the first dot makes
  // every multi-label host look like a bad TLD — "boards.greenhouse.io" yields
  // tld "greenhouse.io", and "acme.co.uk" yields "co.uk" — so real job-board domains
  // were rejected and the blocklist silently stopped matching them.
  const dot = host.lastIndexOf(".");
  if (dot <= 0 || dot === host.length - 1) return null;
  const tld = host.slice(dot + 1);
  if (!/^[a-z]{2,}$/.test(tld)) return null;

  return host.replace(/[^a-z0-9.-]/g, "");
}

/**
 * Every slug a job's company can be identified by.
 *
 * The gate tests membership against this set, so a user who blocked either the
 * name or the domain is honoured. Order is not significant; the list may be empty
 * when both fields are unusable.
 */
export function companySlugCandidates(input: {
  companyName?: string | null;
  companyDomain?: string | null;
}): string[] {
  const out = new Set<string>();

  const fromName = companyNameToSlug(input.companyName ?? "");
  if (fromName) out.add(fromName);

  const domain = companyDomainToSlug(input.companyDomain);
  if (domain) {
    out.add(domain);
    // Also the bare label, so blocking "stripe" matches "stripe.com" without the
    // user having to know whether the source gave a name or a domain.
    const label = domain.split(".")[0];
    if (label) out.add(label);
  }

  return [...out];
}

/**
 * Normalise a user-entered company into the value stored in `blocked_companies` /
 * `preferred_companies`.
 *
 * Accepts a name *or* a domain: "Acme Corp." → `acme-corp`, "acme.com" → `acme.com`.
 * Returns `null` when the input slugifies to nothing, so callers can drop it rather
 * than store `""`.
 *
 * A domain keeps its dots. An earlier revision flattened them to hyphens
 * (`acme.com` → `acme-com`) to make the stored value look slug-like, which broke the
 * round trip: `companySlugCandidates` returns `acme.com` for the matching job, so the
 * blocked entry matched nothing. A stored value no comparison can ever hit is worse
 * than an ugly one — and a user who does not know their target's domain can still
 * block the bare name, because the bare label is one of the candidates.
 */
export function normaliseCompanyInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const domain = companyDomainToSlug(trimmed);
  if (domain) return domain;

  return companyNameToSlug(trimmed) || null;
}