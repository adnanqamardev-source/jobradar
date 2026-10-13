import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors `paths` in tsconfig.json. Vitest does not read tsconfig paths on its own,
  // so without this every `@/lib/...` import in a test fails to resolve.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // tsconfig sets `"jsx": "preserve"`, which is what Next expects — it hands JSX to SWC.
  // Vitest has no SWC step, so without this override the `.tsx` test files reach the SSR
  // transform with raw JSX and fail to parse ("Unexpected JSX expression"). Test-only:
  // `pnpm build` must keep the Next behaviour. Vite 8 transforms with oxc, not esbuild, so
  // the option is `oxc.jsx` — an `esbuild.jsx` setting is silently ignored here.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    // `node` by default — this repo is server-first, and jsdom costs ~10x per file.
    // Component tests opt in per file with `// @vitest-environment jsdom` rather than
    // by splitting the suite into projects, so a reader sees the requirement next to the
    // test that needs it instead of in a config file.
    environment: "node",
    // `.tsx` is for component tests (FE-110's dialog). The `@` alias above already makes
    // JSX resolve through vite's import analysis, which is why a `.ts` test cannot import
    // a `.tsx` module — see the `score-band` note in the session log.
    include: [
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/integration/**/*.test.ts",
    ],
    globals: true,
    setupFiles: ["tests/setup/dom-matchers.ts"],
    pool: "threads",
    // Vitest 4 removed `poolOptions`. Serial execution is now top-level
    // `fileParallelism`. See https://v4.vitest.dev/guide/migration#pool-rework
    fileParallelism: false,
  },
});