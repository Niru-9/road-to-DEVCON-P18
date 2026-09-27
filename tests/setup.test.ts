import { describe, expect, it } from "vitest";

/**
 * Harness smoke test.
 *
 * P3 has no application code yet - this file exists so that the test runner and
 * the type checker have something real to chew on, and so the two fragile
 * pieces of the local toolchain are proven before any behaviour is written:
 *
 *   1. `vitest.config.cts` loads at all. On the `N:` network drive the ESM
 *      config path intermittently fails with EPERM while Vite writes its
 *      temporary config bundle. If this file runs, the `.cts` workaround holds.
 *
 *   2. `node:sqlite` resolves. Vite's builtin external list predates the
 *      builtin, so without `server.deps.external: ["node:sqlite"]` it strips the
 *      `node:` prefix and hunts for a package called "sqlite". The purchase
 *      ledger will be built on this builtin, so the wiring is verified here
 *      rather than discovered in T2.
 */
describe("test harness", () => {
  it("runs tests on this machine", () => {
    expect(1 + 1).toBe(2);
  });

  it("can open an in-memory sqlite database via the node:sqlite builtin", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE probe (value INTEGER NOT NULL)");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run(1);
    const row = db.prepare("SELECT value FROM probe").get() as { value: number };
    expect(row.value).toBe(1);
    db.close();
  });
});
