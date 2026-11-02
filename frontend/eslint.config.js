import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "src/lib/api/schema.gen.ts", "tests/lighthouse.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Только через SafeMarkdown.",
        },
      ],
    },
  },
  {
    // Сквозные тесты читают произвольный JSON ответов API.
    files: ["tests/e2e/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    files: ["src/lib/markdown.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
);
