import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "node_modules",
      "dist",
      "**/dist/**",
      ".cache/**",
      "**/build/**",
      "**/webview-dist/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx", "**/*.ts"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["plugins/*/*.ts", "plugins/*/*.tsx", "plugins/*/**/*.ts", "plugins/*/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["plugins/**", "@/plugins/**"],
              message:
                "Plugins are sealed: don't import from another plugin. Lift shared code into a @loadout/* workspace package instead.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
