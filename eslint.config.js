import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".github/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports"
        }
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/require-await": "off",
      eqeqeq: ["error", "always"],
      "no-constant-binary-expression": "error",
      "no-dupe-else-if": "error",
      "no-useless-assignment": "off",
      "object-shorthand": ["error", "always"],
      "prefer-const": "error"
    }
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports"
        }
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/require-await": "off",
      eqeqeq: ["error", "always"],
      "no-constant-binary-expression": "error",
      "no-dupe-else-if": "error",
      "no-useless-assignment": "off",
      "object-shorthand": ["error", "always"],
      "prefer-const": "error"
    }
  }
);
