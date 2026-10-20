import babelParser from "@babel/eslint-parser";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import simpleImportSort from "eslint-plugin-simple-import-sort";

const declarations = [
  "function",
  "class",
  "interface",
  "type",
  {
    selector:
      "ExportNamedDeclaration[declaration.type=/^(FunctionDeclaration|ClassDeclaration|TSInterfaceDeclaration|TSTypeAliasDeclaration)$/]",
  },
  { selector: "ExportDefaultDeclaration" },
];

const importsFirst = {
  selector: "Program > :not(ImportDeclaration) ~ ImportDeclaration",
  message: "Keep static imports together at the start of the module.",
};

const portableImports = {
  regex: "^(?!\\.|(?:zod|lossless-json)(?:/|$)).+",
  message:
    "Portable modules may import only local contracts, Zod and lossless-json.",
};

function parentImports(allowed) {
  return {
    regex: allowed ? `^\\.\\./(?!${allowed})` : "^\\.\\./",
    message:
      "Import shared contracts directly; concrete implementations are wired by entry points.",
  };
}

// Host recipes live in deploy/; the application never loads them or Neon's SDKs.
const neonImports = {
  regex: "^@neon(?:database)?/|(?:^|/)deploy/",
  message:
    "Only deploy/neon may load Neon SDKs; source modules never import host recipes.",
};

const nodeGlobals = [
  "error",
  "Buffer",
  "process",
  "require",
  "__dirname",
  "__filename",
];

export default defineConfig([
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "coverage/**",
      "src/storage/**/migration.ts",
      "src/storage/**/schema-manifest.ts",
    ],
  },
  {
    files: [
      "src/**/*.ts",
      "tests/**/*.{ts,mjs}",
      "scripts/**/*.{ts,mjs}",
      "deploy/**/*.{ts,mjs}",
      "*.mjs",
      "neon.ts",
    ],
    plugins: {
      "@stylistic": stylistic,
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      curly: ["error", "all"],
      "no-var": "error",
      "prefer-const": "error",
      "one-var": ["error", "never"],
      "no-restricted-syntax": ["error", importsFirst],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "@stylistic/lines-between-class-members": [
        "error",
        {
          enforce: [
            { blankLine: "always", prev: "*", next: "method" },
            { blankLine: "always", prev: "method", next: "*" },
          ],
        },
      ],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        { blankLine: "always", prev: "*", next: declarations },
        { blankLine: "always", prev: declarations, next: "*" },
      ],
    },
  },
  {
    files: [
      "src/**/*.ts",
      "tests/**/*.ts",
      "scripts/**/*.ts",
      "deploy/**/*.ts",
      "neon.ts",
    ],
    languageOptions: {
      // Syntax-only linting: TypeScript 7's compiler owns type/unused checks.
      // typescript-eslint currently requires the TypeScript <6.1 compiler API.
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["typescript"] },
        },
      },
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [portableImports, parentImports("")] },
      ],
      "no-restricted-globals": nodeGlobals,
    },
  },
  {
    files: ["src/domain/plans/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            portableImports,
            {
              regex: "^(?:\\.\\./){2}",
              message: "Financial planners may import only the domain.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [portableImports, parentImports("domain/")] },
      ],
      "no-restricted-globals": nodeGlobals,
    },
  },
  {
    files: ["src/providers/**/*.ts"],
    ignores: ["src/providers/**/node-*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            portableImports,
            parentImports("\\.\\./domain/"),
            {
              regex: "(?:^|/)node-[^/]*\\.js$",
              message:
                "Portable provider code never imports a provider's Node module; runtime composes it.",
            },
          ],
        },
      ],
      "no-restricted-globals": nodeGlobals,
    },
  },
  {
    // A provider's Node-only client (`node-*.ts`) may use Node built-ins, and
    // only Node built-ins beyond the portable set.
    files: ["src/providers/**/node-*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.|node:|(?:zod|lossless-json)(?:/|$)).+",
              message:
                "A provider's Node module may import only Node built-ins, local modules, Zod and lossless-json.",
            },
            parentImports("\\.\\./domain/"),
          ],
        },
      ],
    },
  },
  {
    files: ["src/storage/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            parentImports(
              "\\.\\./(?:application|domain)/|(?:store|run-evidence|sql|migrations|collection-lease)\\.js$",
            ),
            neonImports,
          ],
        },
      ],
    },
  },
  {
    files: ["src/storage/*.ts", "src/transport/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [parentImports("(?:application|domain)/"), neonImports] },
      ],
    },
  },
  {
    files: ["src/*.ts", "src/runtime/**/*.ts", "src/targets/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [neonImports] }],
    },
  },
  {
    files: [
      "src/storage/store.ts",
      "src/storage/migrations.ts",
      "src/storage/collection-lease.ts",
      "src/storage/run-evidence.ts",
      "src/storage/sql.ts",
      "src/storage/statements.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            parentImports("(?:application|domain)/"),
            {
              regex: "^\\./(?:sqlite|postgres)/|^\\./(?:turso|d1)\\.js$",
              message:
                "Shared storage modules must not import concrete adapters.",
            },
            {
              regex: "^(?!\\.|drizzle-orm$).+",
              message:
                "Shared storage code must not load database drivers or runtime modules.",
            },
          ],
        },
      ],
      "no-restricted-globals": nodeGlobals,
    },
  },
  {
    files: ["src/storage/**/*.ts"],
    ignores: [
      "src/storage/sqlite/statements.ts",
      "src/storage/sqlite/d1-statements.ts",
      "src/storage/postgres/statements.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        importsFirst,
        {
          selector:
            "CallExpression[callee.type='MemberExpression']:matches([callee.property.name=/^(select|insert|update|findFirst|findMany)$/], [callee.property.name='delete'][callee.object.name=/^(db|tx|orm)$/], [callee.property.name='delete'][callee.object.property.name='orm'])",
          message:
            "Define Drizzle queries only in the owning dialect's statements.ts module.",
        },
      ],
    },
  },
  {
    files: [
      "src/storage/sqlite/statements.ts",
      "src/storage/sqlite/d1-statements.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.|drizzle-orm(?:/sqlite-core)?$).+",
              message:
                "SQLite statements must remain independent of native drivers.",
            },
            {
              regex: "^\\./(?!(?:schema|statements)\\.js$)",
              message:
                "SQLite statements may import only the driver-free local schema and shared statements.",
            },
            parentImports(
              "\\.\\./(?:application|domain)/|(?:run-evidence|sql)\\.js$",
            ),
          ],
        },
      ],
      "no-restricted-globals": nodeGlobals,
    },
  },
  {
    // libSQL reuses this SQLite-dialect schema without loading the native driver.
    files: ["src/storage/sqlite/schema.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.|drizzle-orm/sqlite-core$).+",
              message:
                "The shared SQLite schema may import only its dialect and domain types.",
            },
            {
              regex: "^\\.(?!\\./\\.\\./domain/)",
              message: "Keep native SQLite modules out of the shared schema.",
            },
          ],
        },
      ],
      "no-restricted-globals": nodeGlobals,
    },
  },
]);
