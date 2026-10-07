import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
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
  // S08 review P2-5: hook correctness (rules-of-hooks, exhaustive-deps and
  // the compiler-family rules) enforced over the React client code — the
  // flat variant, since `configs['recommended-latest']` is still eslintrc-style.
  reactHooks.configs.flat["recommended-latest"],
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
      // The plugin ships exhaustive-deps as a warning, which `pnpm lint`
      // would not fail on — hook correctness is a merge gate, not a hint.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
    },
  },
);
