import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    env: { SWITCHBOARD_LOG_LEVEL: "silent" },
    setupFiles: ["tests/helpers/reset.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: "forks",
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
});
