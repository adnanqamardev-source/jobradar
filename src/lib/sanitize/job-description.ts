/**
 * job-description.ts — the S-02 allowlist sanitiser for `jobs.description_html`.
 *
 * docs/03 §6.2 S-02: *"description_html sanitised on ingest (allowlist of `p, ul, li,
 * strong, em, a, br, h3, h4`); rendered as text nodes. CSP blocks inline script."*
 *
 * ## Why this parses instead of cleaning
 *
 * The obvious implementation is `sanitize-html` + `dangerouslySetInnerHTML`: scrub the string,
 * then hand it to React. That keeps a live XSS surface in the app and needs a dependency.
 * This module instead **parses the HTML into a node tree and renders React elements from it**.
 * No raw HTML string is ever passed to the browser, so `dangerouslySetInnerHTML` appears
 * nowhere in the codebase and there is nothing for an attacker to break out of. A parser bug
 * can produce the wrong text; it cannot produce script execution.
 *
 * The BE-106 ingest-side sanitiser is still open, so the data in `description_html` is
 * **untrusted** — it arrives from Firecrawl scraping arbitrary pages. Sanitising at render is
 * the only defence that also protects rows ingested before any ingest-side fix ships.
 *
 * ## The rules
 *
 * - Allowlisted tags keep their structure. `p, ul, li, strong, em, a, br, h3, h4`.
 * - Everything else is **unwrapped**: the tag disappears, its text content survives. So
 *   `<div>Hello</div>` renders "Hello", and `<img src=x onerror=…>` renders nothing.
 * - `script`, `style`, `iframe`, `object`, `embed`, `template`, `noscript` and `svg` are
 *   **dropped with their content**. Unwrapping a `<script>` would print `alert(1)` as body
 *   text, which is harmless but alarming; dropping the subtree is the conventional behaviour.
 * - Attributes are discarded except `href` on `a`, and only when `isSafeHref` accepts it.
 *   `onclick`, `style`, `src`, `data-*`, `target` — all gone.
 * - Entities are decoded once here and re-escaped by React on render, so text round-trips
 *   correctly and `&lt;script&gt;` in a posting cannot become a tag.
 *
 * Pure and dependency-free, which is what makes it testable: the dangerous cases are all
 * strings, and `tests/unit/job-description.test.ts` asserts them.
 */

/** Tags whose structure survives, per S-02. */
const ALLOWED_TAGS = new Set(["p", "ul", "li", "strong", "em", "a", "br", "h3", "h4"]);

/** Tags removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "svg",
  "math",
]);

/** Tags with no closing tag in the allowlist. */
const VOID_TAGS = new Set(["br"]);

export type DescriptionNode =
  | { kind: "text"; value: string }
  | { kind: "paragraph"; children: DescriptionNode[] }
  | { kind: "unorderedList"; children: DescriptionNode[] }
  | { kind: "listItem"; children: DescriptionNode[] }
  | { kind: "strong"; children: DescriptionNode[] }
  | { kind: "emphasis"; children: DescriptionNode[] }
  | { kind: "heading"; level: 3 | 4; children: DescriptionNode[] }
  | { kind: "link"; href: string; children: DescriptionNode[] }
  | { kind: "break" };

/**
 * URL schemes a job posting's link may use.
 *
 * An allowlist, not a denylist. `javascript:`, `data:` and `vbscript:` are all rejected by
 * omission, and so is anything unrecognised — a posting that links somewhere exotic loses its
 * href but keeps its text, which is a cosmetic loss rather than a broken page.
 */
const SAFE_SCHEMES = ["http://", "https://", "mailto:"];

/**
 * C0 controls and space, DEL, C1 controls and NBSP.
 *
 * Named so the `normaliseHref` body reads as prose, and so the range lives in exactly one
 * place. Built from a `String.fromCharCode` list rather than a regex literal containing
 * control characters, because a literal NUL in source makes the whole file read as binary.
 */
const CONTROL_AND_SPACE = new RegExp(
  `[${String.fromCharCode(0)}- ${String.fromCharCode(0x7f)}-${String.fromCharCode(0xa0)}]`,
  "g",
);

/**
 * Whether `href` may be rendered.
 *
 * ## The allowlist is the security control
 *
 * `SAFE_SCHEMES` is an allowlist, so `javascript:`, `data:` and `vbscript:` are rejected by
 * omission and no amount of obfuscation gets past it. An earlier draft of this comment claimed
 * the control-character strip was what stopped `java\tscript:alert(1)`; it did not — that
 * string fails the allowlist either way.
 *
 * ## What the strip is actually for
 *
 * Normalising whitespace and control characters, so none can reach the rendered `href` — and
 * so the scheme test sees what a browser would resolve. Per the WHATWG URL spec a browser
 * removes tab and newline from a URL before resolving it, so `"ht<tab>tp://acme.example"`
 * navigates to `https://acme.example`; accepting it and rendering the *cleaned* form is
 * therefore both safe and more faithful than rejecting it.
 *
 * Stripping before the check cannot escalate: the removed characters are C0/DEL/C1 controls,
 * whitespace and NBSP, none of which can synthesise `http`, so no sequence of them turns a
 * disallowed scheme into `https://`. `java<NUL>script:` still fails the allowlist.
 *
 * The range is written with escapes on purpose: a literal NUL byte in a source file is
 * invisible in review and makes the file read as binary to every tool that touches it.
 */
export function normaliseHref(href: string): string | null {
  const cleaned = href.replace(CONTROL_AND_SPACE, "").trim();
  const lowered = cleaned.toLowerCase();
  return SAFE_SCHEMES.some((scheme) => lowered.startsWith(scheme)) ? cleaned : null;
}

/** Whether `href` may be rendered. `true` when {@link normaliseHref} returns a value. */
export function isSafeHref(href: string): boolean {
  return normaliseHref(href) !== null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/**
 * Decode HTML entities, including numeric and hex forms.
 *
 * React escapes text on render, so decoding here is safe and necessary: without it a posting
 * reading "Use &lt;script&gt; carefully" would display the raw entities.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

interface OpenElement {
  tag: string;
  node: Extract<DescriptionNode, { children: DescriptionNode[] }>;
}

/** Read `name="value"`, `name='value'`, `name=value` or a bare `name` up to `>` or whitespace. */
function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  // Deliberately permissive scanner: the value is only ever used for `href`, and `isSafeHref`
  // re-validates it from scratch. Missing a malformed attribute loses a link; it cannot
  // introduce one.
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name && !(name in attributes)) attributes[name] = value;
  }
  return attributes;
}

/**
 * Parse `description_html` into a safe node tree.
 *
 * Never throws: malformed markup from a scraper is normal input, so unclosed tags close at the
 * end of input, a stray `</div>` is ignored, and a bare `<` is literal text. An empty or
 * absent description yields `[]`, which the caller renders as "no description".
 */
export function parseJobDescription(html: string | null | undefined): DescriptionNode[] {
  if (!html) return [];
  // An all-whitespace description is not a description. Rendering a lone space would produce
  // an empty-looking body, so return nothing and let the caller show its "no description".
  if (html.trim() === "") return [];

  const roots: DescriptionNode[] = [];
  // The stack holds only allowlisted elements. Anything else is unwrapped, so its text flows
  // into whichever allowlisted ancestor is currently open.
  const stack: OpenElement[] = [];

  const push = (node: DescriptionNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
  };

  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      const tail = decodeEntities(html.slice(index));
      if (tail.trim() !== "" || tail.includes(" ")) push({ kind: "text", value: tail });
      break;
    }

    if (next > index) {
      const text = decodeEntities(html.slice(index, next));
      if (text !== "") push({ kind: "text", value: text });
    }

    // Comment, doctype, CDATA — skipped wholesale.
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
      const end = html.indexOf(">", next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const closing = html.startsWith("</", next);
    const nameMatch = /^<\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(next));
    if (!nameMatch) {
      // A `<` that does not begin a tag is literal text (e.g. "a < b").
      push({ kind: "text", value: "<" });
      index = next + 1;
      continue;
    }

    const tagEnd = html.indexOf(">", next);
    if (tagEnd === -1) {
      // Unterminated tag: treat the remainder as text rather than losing it.
      push({ kind: "text", value: decodeEntities(html.slice(next)) });
      break;
    }
    const tagSource = html.slice(next + 1, tagEnd);
    const tag = (nameMatch[1] ?? "").toLowerCase();
    index = tagEnd + 1;

    if (closing) {
      if (DROP_WITH_CONTENT.has(tag)) {
        // Stray close for a dropped tag; nothing to do.
        continue;
      }
      const position = stack.findIndex((open) => open.tag === tag);
      // -1 means a close with no matching open (stray `</p>`). Ignoring it is right; popping
      // to the nearest match handles unclosed `<strong>` without swallowing the rest.
      if (position !== -1) stack.length = position;
      continue;
    }

    if (DROP_WITH_CONTENT.has(tag)) {
      // Skip to the matching close tag, or to the end of input when there is none.
      //
      // `=== null`, not `=== -1`: `exec` returns a match array or null, so comparing against
      // -1 is never true and `close.index` threw a TypeError on every unterminated
      // `<script>` — i.e. every truncated scrape. The sanitiser sits on the detail page, so
      // that was a page-breaking crash from exactly the untrusted input it exists to handle.
      const close = new RegExp(`</\\s*${tag}\\s*>`, "i").exec(html.slice(index));
      if (close === null) {
        index = html.length;
      } else {
        index += close.index + close[0].length;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) continue; // unwrap: tag gone, children continue

    if (VOID_TAGS.has(tag)) {
      push({ kind: "break" });
      continue;
    }

    const node = buildElement(tag, tagSource);
    push(node);
    stack.push({ tag, node });
  }

  return roots;
}

function buildElement(
  tag: string,
  tagSource: string,
): Extract<DescriptionNode, { children: DescriptionNode[] }> {
  switch (tag) {
    case "p":
      return { kind: "paragraph", children: [] };
    case "ul":
      return { kind: "unorderedList", children: [] };
    case "li":
      return { kind: "listItem", children: [] };
    case "strong":
      return { kind: "strong", children: [] };
    case "em":
      return { kind: "emphasis", children: [] };
    case "h3":
      return { kind: "heading", level: 3, children: [] };
    case "h4":
      return { kind: "heading", level: 4, children: [] };
    case "a": {
      const attributes = readAttributes(tagSource);
      // One function decides both "is this safe" and "what exactly do we render", so the
      // check and the value cannot drift apart. `null` (unsafe or absent) yields an empty
      // href, and the renderer draws the text without a link — the information survives even
      // when the destination does not.
      const href = normaliseHref(attributes.href ?? "");
      return { kind: "link", href: href === null ? "" : decodeEntities(href), children: [] };
    }
    default:
      // Unreachable: every remaining allowlisted tag is handled above. Kept total so a future
      // tag added to ALLOWED_TAGS cannot produce `undefined` and crash the page.
      return { kind: "paragraph", children: [] };
  }
}

/** Block-level kinds: a boundary between them is worth a space, an inline one is not. */
const BLOCK_KINDS = new Set(["paragraph", "unorderedList", "listItem", "heading"]);

/**
 * Visible text of a node tree, whitespace-collapsed.
 *
 * Used for the `Read more` length check and for tests. The spacing rule is the fiddly part:
 * joining every node with a space turns `with <em>care</em>.` into "with care ." — the
 * punctuation ends up detached — while joining with nothing runs `<p>a</p><p>b</p>` together
 * as "ab". So a space is inserted at **block** boundaries only, and inline elements
 * (`strong`, `em`, `a`, `br`) are transparent.
 */
export function descriptionText(nodes: DescriptionNode[]): string {
  const render = (list: DescriptionNode[]): string => {
    let out = "";
    for (const node of list) {
      if (node.kind === "text") {
        out += node.value;
        continue;
      }
      if (node.kind === "break") {
        out += " ";
        continue;
      }
      const inner = render(node.children);
      if (BLOCK_KINDS.has(node.kind)) {
        if (out !== "" && !out.endsWith(" ")) out += " ";
        out += inner;
        out += " ";
      } else {
        out += inner;
      }
    }
    return out;
  };
  return render(nodes).replace(/\s+/g, " ").trim();
}
