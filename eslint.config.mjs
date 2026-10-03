import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

// Service-role guard (docs/02 §4, AGENTS.md hard constraints):
// `@supabase/supabase-js` may only be imported from the worker paths.
// Implemented as per-file overrides — `no-restricted-imports` has no
// conditional predicate, so the "allowed" list is expressed as the
// complement: block everywhere, then un-block the sanctioned files.
const SERVICE_ROLE_ALLOWED = [
  "src/lib/db/admin.ts",
  "src/lib/queue/**",
  "src/app/api/cron/**",
  "src/app/api/webhooks/**",
  "scripts/**",
  "tests/**",
];

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "dist/**",
      "build/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "**/*.config.*",
      "**/*.lock",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // No hex or px literals outside src/styles/tokens.css (DS-001).
      // Enforced as a no-restricted-syntax walk over Literal nodes.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
          message:
            "No hex colour literals outside src/styles/tokens.css. Add a token first (docs/04).",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts", "tests/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@supabase/supabase-js",
              message:
                "Service-role access must go through lib/db/admin.ts. Direct imports are allowed only in lib/queue/**, api/cron/**, api/webhooks/**, scripts/**, and tests/**.",
            },
          ],
        },
      ],
    },
  },
  {
    files: SERVICE_ROLE_ALLOWED,
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: ["scripts/**", "tests/**", "*.config.*", "vitest.config.mts"],
    rules: {
      // Service-role calls and throwaway assertions legitimately use `any`
      // and console output outside the app surface.
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    files: ["*.config.mts", "*.config.mjs", "*.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);