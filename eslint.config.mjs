import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

// Service-role guard (docs/02 §4, AGENTS.md hard constraints):
// `@supabase/supabase-js` may only be imported from the worker paths.
// Implemented as per-file overrides — `no-restricted-imports` has no
// conditional predicate, so the "allowed" list is expressed as the
// complement: block everywhere, then un-block the sanctioned files.
//
// Both lists are EXPORTED. tests/unit/eslint-guard.test.ts asserts against them rather
// than restating them, which is what makes it an oracle: before, a new entry added here
// was invisible to the test, and a new path added to the test proved nothing about this
// config. One policy, one home. See docs/02 §4 rule 3.
export const SERVICE_ROLE_ALLOWED = [
  "src/lib/db/admin.ts",
  // user-client.ts is the anon-key, user-JWT factory. It imports `@supabase/supabase-js`
  // directly because the ESLint rule would otherwise force every client factory through
  // the service-role module — the exact privilege mixing the rule exists to prevent.
  // It is named `*-client` and reachable from Server Actions on purpose; it holds no
  // service key.
  "src/lib/db/user-client.ts",
  "src/lib/queue/**",
  "src/app/api/cron/**",
  "src/app/api/webhooks/**",
  // Beyond the three paths named in docs/02 §4: neither is reachable from the client
  // bundle, and the integration suite has to be able to drive the queue handlers it is
  // testing. Blocking them would break scripts/queue-drain.ts and the RLS tests.
  "scripts/**",
  "tests/**",
];

// ENG-001 "Done when" #6 / AGENTS.md hard constraint: `src/lib/db/admin.ts` may
// only be imported from the worker paths. This is the rule that was missing —
// the `no-restricted-imports` entry below guards the *other* direction (direct
// `@supabase/supabase-js` imports) and never blocked this one.
export const ADMIN_ALLOWED = [
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
      "tools/**",
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
                "Service-role access must go through lib/db/admin.ts; user-scoped calls must go through lib/db/user-client.ts. Direct imports are allowed only in those two factories, lib/queue/**, api/cron/**, api/webhooks/**, scripts/**, and tests/**.",
            },
          ],
          patterns: [
            {
              group: ["@/lib/db/admin", "@/lib/db/admin.js", "**/lib/db/admin"],
              message:
                "lib/db/admin.ts holds the service-role key and may only be imported from lib/queue/**, api/cron/**, api/webhooks/**, scripts/**, and tests/**. It must never reach a component or any client-reachable module.",
            },
          ],
        },
      ],
    },
  },
  {
    // The rule is switched off for the union of both lists, because
    // `no-restricted-imports` cannot disable one entry and keep another — switching it
    // off is all-or-nothing. The union is exactly right: every path that may import
    // `@supabase/supabase-js` may also import `admin.ts`, and `admin.ts` itself must
    // be able to create the client.
    files: [...new Set([...SERVICE_ROLE_ALLOWED, ...ADMIN_ALLOWED])],
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