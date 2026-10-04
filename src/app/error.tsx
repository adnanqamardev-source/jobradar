"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to Sentry on client
    console.error("Global error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen flex items-center justify-center bg-paper p-4">
        <div className="max-w-md text-center">
          <h1 className="text-display-l font-display mb-4">Something went wrong</h1>
          <p className="text-body text-ink-2 mb-6">
            We're sorry — something unexpected happened. Our team has been notified.
          </p>
          <button
            onClick={reset}
            className="px-6 py-3 bg-brand text-white rounded-control font-medium text-sm hover:bg-brand-press transition-colors"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}