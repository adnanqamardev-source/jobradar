export default function Page() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="max-w-2xl text-center">
        <h1 className="text-display-l font-display mb-6">JobRadar</h1>
        <p className="text-body-l text-ink-2 mb-8">
          Automated job finding workflow — scrape, dedupe, rank, track.
        </p>
        <a
          href="/login"
          className="inline-flex items-center justify-center px-6 py-3 text-body-md font-medium text-white bg-brand rounded-control hover:bg-brand-press transition-colors"
        >
          Start free
        </a>
      </div>
    </main>
  );
}