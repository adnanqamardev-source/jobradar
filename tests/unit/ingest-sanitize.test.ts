import { describe, it, expect } from "vitest";
import { sanitizeDescriptionHtml } from "@/lib/ingest/sanitize";

describe("sanitizeDescriptionHtml", () => {
  it("allows allowed tags", () => {
    const input = "<p><strong>Strong</strong> <em>Em</em> <a href='/link'>Link</a><ul><li>Item</li></ul><h3>H3</h3><h4>H4</h4><br />Text</p>";
    const output = sanitizeDescriptionHtml(input);
    expect(output).toBe("<p><strong>Strong</strong> <em>Em</em> <a href=\"/link\" rel=\"noopener noreferrer\" target=\"_blank\">Link</a><ul><li>Item</li></ul><h3>H3</h3><h4>H4</h4><br />Text</p>");
  });

  it("strips disallowed tags", () => {
    const input = "<div><span>Disallowed</span> <script>alert(1)</script></div>";
    const output = sanitizeDescriptionHtml(input);
    expect(output).toBe("Disallowed");
  });

  it("strips dangerous hrefs", () => {
    const input = '<a href="javascript:alert(1)">Bad Link</a>';
    const output = sanitizeDescriptionHtml(input);
    expect(output).toBe("<a>Bad Link</a>");
  });

  it("strips event handlers", () => {
    const input = '<p onclick="alert(1)">Text</p>';
    const output = sanitizeDescriptionHtml(input);
    expect(output).toBe("<p>Text</p>");
  });
});
