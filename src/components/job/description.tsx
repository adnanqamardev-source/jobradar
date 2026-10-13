/**
 * description.tsx — the sanitised job description with a `Read more` control (JOB-001).
 *
 * ## No `dangerouslySetInnerHTML`, anywhere
 *
 * `parseJobDescription` (lib/sanitize) turns the untrusted `description_html` into a node
 * tree, and this file renders that tree as React elements. There is no HTML string handed to
 * the browser, so there is no attribute to escape and no parser differential to exploit. S-02
 * asks for the description to be "rendered as text nodes"; this is that, taken literally.
 *
 * ## Why the client
 *
 * `Read more` is state: a button that changes what is rendered. Phase 2 owns behaviour and
 * Phase 3 owns presentation (docs/06 §8.4), so the collapse is implemented as a real
 * expand/collapse here and the visual clamp (gradient, max-height) arrives in Phase 3 with the
 * rest of the styling. Doing it with `<details>` instead would have needed no JavaScript, but
 * it cannot report "how much is hidden" and gives Phase 3 nothing to restyle.
 *
 * ## The cutoff
 *
 * A count of *blocks*, not characters. A posting's first paragraph may be one word; a cutoff in
 * characters would truncate it to nothing and hide the Read more control at the same time.
 * Blocks also line up with what the reader perceives as a screenful. `COLLAPSED_BLOCKS` is 3.
 *
 * When collapsed, the hidden blocks are **not rendered at all** rather than hidden with CSS.
 * That matters for a screen reader: `display: none` content is skipped, but so is content that
 * is merely visually clipped, and a long posting read aloud in full is worse than one that is
 * announced honestly as truncated.
 */

"use client";

import { useId, useState } from "react";

import type { DescriptionNode } from "@/lib/sanitize/job-description";

/** How many top-level blocks are shown before `Read more` appears. */
const COLLAPSED_BLOCKS = 3;

function renderNodes(nodes: DescriptionNode[]): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${node.kind}-${index}`;
    switch (node.kind) {
      case "text":
        return <span key={key}>{node.value}</span>;
      case "break":
        return <br key={key} />;
      case "paragraph":
        return <p key={key}>{renderNodes(node.children)}</p>;
      case "unorderedList":
        return <ul key={key}>{renderNodes(node.children)}</ul>;
      case "listItem":
        return <li key={key}>{renderNodes(node.children)}</li>;
      case "strong":
        return <strong key={key}>{renderNodes(node.children)}</strong>;
      case "emphasis":
        return <em key={key}>{renderNodes(node.children)}</em>;
      case "heading":
        // h3/h4 only, per the allowlist: the page owns h1 (title) and h2 (section headings), so
        // a posting cannot introduce a second h1 and break the document outline.
        return node.level === 3 ? (
          <h3 key={key}>{renderNodes(node.children)}</h3>
        ) : (
          <h4 key={key}>{renderNodes(node.children)}</h4>
        );
      case "link":
        // An empty href means the destination was unsafe or absent. The text is kept and
        // rendered as plain text: a job posting's information matters even when its link does
        // not, and a dead-looking link with `href=""` would reload the current page.
        if (node.href === "") return <span key={key}>{renderNodes(node.children)}</span>;
        return (
          <a key={key} href={node.href} rel="noopener noreferrer" target="_blank">
            {renderNodes(node.children)}
          </a>
        );
      default:
        return null;
    }
  });
}

export interface JobDescriptionProps {
  nodes: DescriptionNode[];
  /** Shown when the posting has no description at all. */
  emptyMessage?: string;
}

export function JobDescription({ nodes, emptyMessage }: JobDescriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const buttonId = useId();

  if (nodes.length === 0) {
    return <p>{emptyMessage ?? "This posting did not include a description."}</p>;
  }

  const collapsible = nodes.length > COLLAPSED_BLOCKS;
  const visible = collapsible && !expanded ? nodes.slice(0, COLLAPSED_BLOCKS) : nodes;

  return (
    <div>
      <div id={bodyId}>{renderNodes(visible)}</div>

      {collapsible && (
        <button
          type="button"
          id={buttonId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
