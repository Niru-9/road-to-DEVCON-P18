/**
 * Test configuration.
 *
 * Note the extension: this file is `.cts`, not `.ts`, and it must stay that
 * way. It is the same workaround P1/P2 use, reproduced here because P3 has its
 * own manifest and must run on its own.
 *
 * Vite loads a config file by bundling it with esbuild and then importing the
 * result. On the ESM path that means writing a temporary `.mjs` file into
 * `node_modules/.vite-temp/`, importing it, and unlinking it. `N:` is a network
 * drive, and that write intermittently fails with `EPERM` (antivirus or the SMB
 * layer holding the file open). The failure happens *before any test runs*:
 *
 *   Error: Vite received EPERM writing its temporary config bundle.
 *
 * The CJS path - which a `.cts` extension selects - uses `require` with an
 * esbuild `_compile` hook and writes no temporary file at all.
 *
 * Renaming this to `vitest.config.ts` will reintroduce the bug. If the suite
 * starts failing on config load, check this first.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live.test.ts", "node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
    server: {
      deps: {
        // Vite's builtin external list predates `node:sqlite`, so it strips the
        // `node:` prefix and tries to resolve a package called "sqlite".
        // Declaring it external keeps the import intact and lets Node load the
        // builtin. The runtime is unaffected - this only affects how the test
        // runner transforms the module.
        external: ["node:sqlite"],
      },
    },
  },
});
