import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig's compilerOptions.jsx is "preserve" (Next's SWC owns the real
  // app build); esbuild doesn't understand "preserve" and falls back to the
  // classic transform expecting a global `React`, so DictationMic.tsx (the
  // first component vitest renders directly, via react-dom/server in
  // test/dictation/mic.test.ts) would fail with "React is not defined".
  // This only affects the test bundle, never the Next.js build.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // ingest integration tests share one local DB — keep them sequential
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
