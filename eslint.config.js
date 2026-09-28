// @ts-check
import eslintReact from "@eslint-react/eslint-plugin";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Only these modules may import the service-role (RLS-bypassing) client.
 * See ADR 0001 and ARCHITECTURE.md §6.2. Extend deliberately, with review.
 */
const SYSTEM_CLIENT_ALLOWLIST = [
  "src/server/db/system.ts",
  "src/server/public/**",
  "src/server/audit/**",
];

const systemClientRestriction = {
  group: ["@/server/db/system", "**/server/db/system"],
  message: "The service-role client bypasses RLS. Only allow-listed modules may use it (ADR 0001).",
};

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
      "cloudflare-env.d.ts",
      "src/types/database.ts",
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-restricted-imports": ["error", { patterns: [systemClientRestriction] }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["src/**/*.tsx"],
    ...eslintReact.configs["recommended-typescript"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: SYSTEM_CLIENT_ALLOWLIST,
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Pure domain logic: no I/O, frameworks, or server modules.
    files: ["src/domain/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/server/*", "@/app/*", "@/components/*"], message: "src/domain must stay pure." },
            { group: ["@supabase/*", "next", "next/*", "react", "react-dom", "openai"], message: "src/domain must not depend on frameworks or I/O." },
          ],
        },
      ],
    },
  },
  {
    // Client-reachable code must never import server modules.
    files: ["src/components/**", "src/lib/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@/server/*"], message: "Client-reachable code must not import server modules." }, systemClientRestriction] },
      ],
    },
  },
  {
    files: ["tests/**", "scripts/**", "*.config.{ts,js,mjs}"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
