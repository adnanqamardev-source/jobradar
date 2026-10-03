import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors `paths` in tsconfig.json. Vitest does not read tsconfig paths on its own,
  // so without this every `@/lib/...` import in a test fails to resolve.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    globals: true,
    setupFiles: [],
    pool: "threads",
    // Vitest 4 removed `poolOptions`. Serial execution is now top-level
    // `fileParallelism`. See https://v4.vitest.dev/guide/migration#pool-rework
    fileParallelism: false,
  },
});