import { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Not Found — JobRadar",
};

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-paper p-4">
      <div className="max-w-md text-center">
        <h1 className="text-display-l font-display mb-4">404</h1>
        <p className="text-body text-ink-2 mb-6">
          We couldn't find that page. It might have been moved or doesn't exist.
        </p>
        <Link
          href="/"
          className="inline-flex items-center justify-center px-6 py-3 text-body-md font-medium text-white bg-brand rounded-control hover:bg-brand-press transition-colors"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}