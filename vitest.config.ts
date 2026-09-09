import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    restoreMocks: true,
    server: {
      deps: {
        // node:sqlite is a Node builtin; Vite must not try to bundle it.
        external: [/^node:sqlite$/],
      },
    },
  },
});
