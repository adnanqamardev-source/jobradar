/**
 * dashboard/loading.tsx — the feed's loading state (FED-001: shape-matched
 * skeletons, never a spinner-only page).
 *
 * Next.js renders this while the page's server component fetches. The blocks
 * mirror the card anatomy (company line, title, meta, chips, score row) so the
 * page does not jump when real cards replace them. `aria-hidden` keeps the
 * blocks out of the accessibility tree; the `role="status"` line is what a
 * screen reader announces.
 */

export default function FeedLoading() {
  return (
    <div aria-busy="true">
      <p role="status">Loading your feed…</p>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true">
          <div />
          <div />
          <div />
          <div />
          <div />
        </div>
      ))}
    </div>
  );
}
