/**
 * The P3 traceability table is not allowed to be wrong.
 *
 * A rubric table is a set of claims about what the repository contains. Left
 * unchecked it drifts: a file is renamed, a test is deleted, a check gets marked
 * verified on the strength of a plan, and the document keeps asserting it. A
 * reviewer who trusts the table is then misled by the one artefact whose entire job
 * is to be trustworthy — and a rubric table that overstates is worse than no table,
 * because it is the artefact a judge is most likely to read first.
 *
 * So the P3 section is verified structurally, on every test run:
 *
 * - all nine checks are present, and their point values total 80;
 * - every path it cites exists;
 * - a row marked verified must cite at least one real test;
 * - every test file in `tests/` must be cited somewhere, so a suite cannot be
 *   written and then quietly used as evidence for nothing;
 * - the status vocabulary is closed, and the rows that admit a gap must actually
 *   admit one in the prose beneath the table.
 *
 * This is P2's `tests/rubric-traceability.test.ts` applied to P3, and it exists
 * because of one specific failure mode this project hit: check 5 was going to be
 * marked "verified" on the strength of a filesystem walk, when the page had never
 * been opened in a browser. The table now says *partial* and says why, and this
 * test is what stops that word being quietly upgraded.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, "..");
const DOC_PATH = resolve(PACKAGE, "..", "docs", "rubric-traceability.md");
const DOC = readFileSync(DOC_PATH, "utf8");

/** The P3 section only: from its heading to the end of the file. */
const P3 = DOC.slice(DOC.indexOf("## P3"));

interface Row {
  readonly check: string;
  readonly points: number;
  readonly status: string;
  readonly cells: readonly string[];
}

/** Table rows: `| 5 | check | 18 | **verified** | code | tests |` */
function rows(): Row[] {
  const found: Row[] = [];
  for (const line of P3.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[0] ?? "")) continue; // header or separator
    found.push({
      check: cells[0] as string,
      points: Number(cells[2]),
      status: (cells[3] ?? "").replace(/\*/g, "").toLowerCase(),
      cells,
    });
  }
  return found;
}

const ROWS = rows();

/** Every `path/like/this` in backticks, across the given cells. */
function citedPaths(cells: readonly string[]): string[] {
  const found: string[] = [];
  for (const cell of cells) {
    for (const match of cell.matchAll(/`([^`]+)`/g)) {
      const value = match[1] as string;
      if (/^(src|tests|scripts|public|docs)\//.test(value)) {
        // Trim a trailing `:12` line reference, which is not part of the path.
        found.push(value.replace(/:\d+$/, ""));
      }
    }
  }
  return found;
}

describe("rubric traceability: P3", () => {
  it("has all nine checks, and the points add up to 80", () => {
    expect(ROWS.length).toBe(9);
    expect(ROWS.map((row) => row.check).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    // 80 points come straight off the code, and the judgment twenty is separate.
    const total = ROWS.reduce((sum, row) => sum + row.points, 0);
    expect(total).toBe(80);
    expect(ROWS.map((row) => row.points)).toEqual([5, 4, 8, 6, 18, 12, 12, 7, 8]);
  });

  it("states the suite size it actually has, so the snapshot cannot rot", () => {
    // The paragraph above the table quotes a dated snapshot. Test *files* can be
    // counted exactly from the filesystem, so that number is verified rather than
    // trusted; the test *count* is a runner statistic and stays prose, with the
    // "rerun `npm run verify` and update" instruction beside it.
    //
    // The nudge is the point: adding a suite fails this until the snapshot names it,
    // which is the same discipline P2 applies to its own README.
    const onDisk = readdirSync(HERE).filter((name) => name.endsWith(".test.ts")).length;
    const stated = /across (\d+) files/.exec(P3)?.[1];
    expect(stated, "the P3 section does not state how many test files it has").toBeTruthy();
    expect(Number(stated), "the stated test-file count is stale").toBe(onDisk);
  });

  it("uses a closed status vocabulary", () => {
    // Three words, and "verified" is the one that has to be earned. A fourth word
    // would mean a status nobody has agreed what it means.
    for (const row of ROWS) {
      expect(["verified", "partial", "not verified"], `check ${row.check} is "${row.status}"`).toContain(row.status);
    }
  });

  it("every path it cites exists", () => {
    const missing: string[] = [];
    for (const row of ROWS) {
      // The Code cell and the Tests cell are the last two.
      for (const path of citedPaths(row.cells.slice(4))) {
        const base = path.startsWith("docs/") ? resolve(PACKAGE, "..") : PACKAGE;
        if (!existsSync(resolve(base, path))) missing.push(`check ${row.check}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("no row claims to be verified without citing a test", () => {
    const unsupported: string[] = [];
    for (const row of ROWS) {
      if (row.status !== "verified" && row.status !== "partial") continue;
      // cells[5] is the Tests cell, a string. Wrapped in an array, or the spread
      // below would iterate its characters and find no backticks.
      if (citedPaths([row.cells[5] ?? ""]).length === 0) unsupported.push(`check ${row.check}`);
    }
    expect(unsupported).toEqual([]);
  });

  it("cites every test file in the repository, so no suite is evidence for nothing", () => {
    const onDisk = readdirSync(HERE)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `tests/${name}`)
      .sort();
    const cited = new Set(ROWS.flatMap((row) => citedPaths(row.cells.slice(4))));
    // Two files are exempt, each for a stated reason rather than by convenience.
    // `rubric-traceability.test.ts` checks the table rather than being evidence for
    // a rubric row, and `setup.test.ts` is the harness smoke test from T1 — it
    // proves `vitest.config.cts` loads and that `node:sqlite` resolves on this
    // drive, which is real but is not a claim about the product.
    const exempt = new Set(["tests/rubric-traceability.test.ts", "tests/setup.test.ts"]);
    const uncited = onDisk.filter((path) => !cited.has(path) && !exempt.has(path));
    expect(uncited, "a test file exists that no row relies on").toEqual([]);
  });

  it("does not claim browser rendering or live settlement anywhere", () => {
    // The two claims that cannot be closed by a test in this repository. If either
    // is ever asserted as done, this fails — which is the point.
    expect(P3).toMatch(/has never been opened in a browser/);
    expect(P3).toMatch(/Live testnet settlement is unverified/);

    // And no row may lean on a browser or a funded key as its evidence.
    for (const row of ROWS) {
      const evidence = (row.cells[5] ?? "").toLowerCase();
      expect(evidence, `check ${row.check} cites a browser or a live key as evidence`).not.toMatch(
        /pichatab|playwright|browser test|funded key|live facilitator/,
      );
    }
  });

  it("keeps check 5 partial, and says which half is missing", () => {
    // The most likely row to be quietly upgraded, because eight of its nine
    // assertions really are green. If someone opens a browser and confirms the
    // rendering, this test is the thing that must be edited *deliberately*.
    const five = ROWS.find((row) => row.check === "5");
    expect(five?.status).toBe("partial");
    expect(five?.cells[5]).toMatch(/browser/i);
    expect(P3).toMatch(/one thing standing between check 5 and a full pass/i);
  });

  it("admits, in prose, every gap its own rows imply", () => {
    // A `partial` row whose prose says nothing partial is a contradiction, and a
    // reviewer reading only the limitations list would never learn about it.
    const limitations = P3.slice(P3.indexOf("### Known limitations")).toLowerCase();
    expect(limitations.length).toBeGreaterThan(0);
    for (const needle of [
      "never been opened in a browser",
      "testnet settlement is unverified",
      "eoa wallets only",
      "stolen session cookie",
    ]) {
      expect(limitations.toLowerCase(), `the limitations list is missing "${needle}"`).toContain(needle);
    }
  });

  it("the code claims it makes about the routes are true of the source", () => {
    // Spot-checked, not trusted. The table says the 402 carries an EIP-712 domain
    // and that there is no `express.static`; both are one grep away from being
    // wrong, and the EIP-712 one was wrong for a whole task before it was fixed.
    const routes = readFileSync(resolve(PACKAGE, "src", "payment", "routes.ts"), "utf8");
    expect(routes).toMatch(/extra: eip712Domain/);
    // The domain must reach the requirement from a named source. Which source
    // changed when the project moved to Ethereum Sepolia: the SDK's
    // default-asset table has no entry for that chain and `getDefaultAsset`
    // throws for it, so the domain now comes from the constants declared in
    // src/config.ts. What this guard protects is unchanged - the name and
    // version a payer signs against are read from one place, not invented here.
    expect(routes).toMatch(/name: ETHEREUM_SEPOLIA_USDC_NAME/);
    expect(routes).toMatch(/version: ETHEREUM_SEPOLIA_USDC_VERSION/);

    const app = readFileSync(resolve(PACKAGE, "src", "http", "app.ts"), "utf8");
    const code = app.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    expect(code).not.toContain("express.static");

    // And the session row really does hold no reel list, which is what makes
    // check 9 a property of the schema rather than of a cache.
    const store = readFileSync(resolve(PACKAGE, "src", "db", "session-store.ts"), "utf8");
    const schema = /CREATE TABLE[\s\S]*?\);/.exec(store)?.[0] ?? "";
    expect(schema).toContain("token_hash");
    expect(schema).toContain("wallet");
    expect(schema).not.toContain("reel");
  });
});
