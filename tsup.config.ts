import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  // Only the library needs published types; the CLI is an executable.
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  // No source maps in the published tarball — they bloat the package and ship the
  // original TS. Debug from src via the test suite instead.
  sourcemap: false,
  splitting: false,
  shims: false,
});
