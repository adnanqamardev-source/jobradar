import { defineConfig } from "vitest/config";

export default defineConfig({
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