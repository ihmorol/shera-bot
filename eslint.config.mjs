import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // mockup/ is reference evidence (never code to copy) and business-landing-portfolio/
    // is a separate repository; both keep their own style. docs/ is prose. artifacts/ is
    // generated CI output. The dot-directories hold agent tooling and local session
    // archives, not project code.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "artifacts/**",
      "docs/**",
      "mockup/**",
      "business-landing-portfolio/**",
      ".agents/**",
      ".codegraph/**",
      ".gstack/**",
      ".omo/**",
      ".session-archive/**",
      ".zcode/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // TypeScript resolves identifiers itself; no-undef only produces false positives
      // on typed globals.
      "no-undef": "off",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
);
