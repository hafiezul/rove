import type { UserConfig } from "vite-plus";

// Bun's native file reads are not fully captured by Vite's automatic tracking.
// Use a conservative workspace-wide input set, including dependency pins and
// patches, rather than guessing which shared package an import can reach.
export const bunTypecheckTasks = {
  "typecheck:bun": {
    command: "bun check --threads 4",
    cache: true,
    input: [
      "src/**",
      "vite/**",
      "test/**",
      "scripts/**",
      "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc,toml}",
      {
        pattern:
          "{apps,packages,scripts,infra,oxlint-plugin-rove,native}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc}",
        base: "workspace",
      },
      {
        pattern: "*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,jsonc,yaml,yml,toml}",
        base: "workspace",
      },
      { pattern: "patches/**", base: "workspace" },
      { pattern: "!**/node_modules/**", base: "workspace" },
      { pattern: "!**/.vite-plus/**", base: "workspace" },
      { pattern: "!**/*.tsbuildinfo", base: "workspace" },
    ],
    output: [],
  },
} satisfies NonNullable<UserConfig["run"]>["tasks"];
