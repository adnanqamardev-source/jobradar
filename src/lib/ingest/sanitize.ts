/**
 * sanitize.ts — HTML sanitization for job descriptions (BE-106, S-02).
 *
 * Implements docs/03 §6.2 S-02:
 * Allowlist of tags: `p`, `ul`, `li`, `strong`, `em`, `a`, `br`, `h3`, `h4`.
 * Strips script tags, event handlers, and dangerous hrefs.
 */

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "p",
  "ul",
  "li",
  "strong",
  "em",
  "a",
  "br",
  "h3",
  "h4",
]);

export function sanitizeDescriptionHtml(html: string | null | undefined): string | null {
  if (typeof html !== "string" || html.length === 0) {
    return null;
  }

  // 1. Remove script, style, iframe, object, embed tags entirely with content
  let cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  cleaned = cleaned.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  cleaned = cleaned.replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "");
  cleaned = cleaned.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, "");

  // 2. Match all HTML tags
  cleaned = cleaned.replace(
    /<\/?([a-zA-Z0-9]+)([^>]*)>/g,
    (match: string, rawTag: string, attrs: string): string => {
      const lowerTag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(lowerTag)) {
        return ""; // Strip disallowed tags
      }

      const isClosing = match.startsWith("</");
      if (isClosing) {
        return `</${lowerTag}>`;
      }

      if (lowerTag === "br") {
        return "<br />";
      }

      if (lowerTag === "a") {
        // Extract href if safe
        const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const href = (hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();

        // Check if href is safe (http, https, mailto, relative starting with /)
        const isSafe = /^(https?:\/\/|mailto:|\/)/i.test(href);
        if (href.length > 0 && isSafe) {
          return `<a href="${href}" rel="noopener noreferrer" target="_blank">`;
        }
        return "<a>";
      }

      return `<${lowerTag}>`;
    },
  );

  return cleaned.trim();
}
