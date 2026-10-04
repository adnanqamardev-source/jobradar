export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-surface border border-line rounded-card p-8">
          <h1 className="text-h1 font-sans font-semibold mb-2">Sign in to JobRadar</h1>
          <p className="text-body text-ink-2 mb-8">
            Enter your email to receive a magic link, or continue with Google.
          </p>
          
          <form className="space-y-4" action="/api/auth/magic-link" method="POST">
            <div>
              <label htmlFor="email" className="block text-xs font-medium text-ink-2 mb-2 label">
                Email
              </label>
              <input
                type="email"
                id="email"
                name="email"
                required
                className="w-full h-10 px-3 border border-line-strong rounded-control bg-surface text-ink placeholder-ink-3 focus:border-brand focus:ring-2 focus:ring-brand-soft focus:ring-offset-0 transition-colors"
                placeholder="you@example.com"
              />
            </div>
            <button
              type="submit"
              className="w-full h-10 px-4 bg-brand text-white rounded-control font-medium text-sm hover:bg-brand-press transition-colors"
            >
              Send magic link
            </button>
          </form>
          
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-line" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="px-2 bg-surface text-ink-3">Or continue with</span>
            </div>
          </div>
          
          <button
            className="w-full h-10 px-4 border border-line-strong rounded-control bg-surface text-ink font-medium text-sm hover:bg-surface-2 transition-colors flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="currentColor"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="currentColor"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="currentColor"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>
        </div>
      </div>
    </main>
  );
}