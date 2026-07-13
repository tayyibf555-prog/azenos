import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // ingest integration tests share one local DB — keep them sequential
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
