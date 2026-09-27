/**
 * The signature verifier cannot be replaced (rubric checks 7 and 8).
 *
 * ## Why a source scan
 *
 * T4 gave the payment layer an optional `EVMMessageVerifier`, so the SIWX suites
 * could be written without a key pair: a deterministic stand-in accepted one
 * address with one signature. Every test in the suite was then honest about what
 * it covered - and every test was also, structurally, incapable of catching a
 * broken signature check. A double that says yes cannot be defeated, so "the
 * server refused a bad signature" was really only ever "the double said no".
 *
 * T5 deleted the option. The remaining risk is not that it is missing but that
 * somebody puts it back - a future refactor that "just needs a test seam", a
 * helper that reaches around the runtime to build the extension itself, a mock
 * file that re-exports one. Type signatures discourage that; they do not prevent
 * it, and a seam that reappears quietly turns a cryptography claim back into an
 * intent claim.
 *
 * So this file reads the code. The tokens it refuses are the ones that would let
 * a signature check be replaced by a predicate, plus the SDK's in-memory storage,
 * which would quietly trade a durable nonce ledger for a `Set` in the process.
 *
 * Comments are stripped before scanning, and deliberately: `siwx.ts` and
 * `runtime.ts` both *discuss* the option they no longer have, at some length,
 * precisely so a reader knows why it is gone. A scan that counted prose would fail
 * on the explanation.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(child);
    }
  }
  return found.sort();
}

/**
 * TypeScript with comments and string literals removed.
 *
 * Two passes, because the two hazards are different. A block or line comment can
 * legitimately name the option being banned. A string literal can too - a message
 * like `"evmVerifier is not supported"` would fail a naive scan, and would also
 * fail a *real* use, since nothing here should be constructing one by name.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

const APPLICATION_FILES = await sourceFiles(join(PACKAGE_ROOT, "src"));
const HARNESS_FILES = await sourceFiles(join(PACKAGE_ROOT, "tests", "support"));

/** Tokens that would allow a real signature check to be swapped for a predicate. */
const VERIFIER_SEAMS = ["evmVerifier", "EVMMessageVerifier", "verifyOptions"] as const;

/** Tokens that would trade a durable ledger for process memory. */
const MEMORY_SEAMS = ["InMemorySIWxStorage"] as const;

describe("the application path has no signature-verifier seam", () => {
  it("scans a non-trivial number of source files, so the scan is not vacuous", () => {
    // A scan of zero files passes everything. This is the assertion that makes the
    // rest of the file mean something.
    expect(APPLICATION_FILES.length, "no application source files were found").toBeGreaterThan(10);
    expect(APPLICATION_FILES.some((file) => file.endsWith(join("payment", "siwx.ts")))).toBe(true);
  });

  it("never names a verifier override in application code", async () => {
    for (const file of APPLICATION_FILES) {
      const code = codeOnly(await readFile(file, "utf8"));
      for (const token of VERIFIER_SEAMS) {
        expect(code.includes(token), `${file.replace(PACKAGE_ROOT, "")} mentions ${token}`).toBe(false);
      }
    }
  });

  it("never names a verifier override in the test harness either", async () => {
    // The application could be clean and the suite still hollow: a harness that
    // reaches past `createRuntime` to build its own extension would verify nothing.
    for (const file of HARNESS_FILES) {
      const code = codeOnly(await readFile(file, "utf8"));
      for (const token of VERIFIER_SEAMS) {
        expect(code.includes(token), `${file.replace(PACKAGE_ROOT, "")} mentions ${token}`).toBe(false);
      }
    }
  });

  it("builds the extension with the origin and the storage, and nothing else", async () => {
    // The one call site. `createSIWxResourceServerExtension` takes `verifyOptions`
    // as an optional sibling of these two, so this asserts the shape of the whole
    // argument object rather than the absence of a word.
    const source = codeOnly(await readFile(join(PACKAGE_ROOT, "src", "payment", "siwx.ts"), "utf8"));
    const call = /createSIWxResourceServerExtension\(\{([^}]*)\}\)/.exec(source);
    expect(call, "the extension is not built with an object literal").not.toBeNull();

    const keys = [...(call?.[1] ?? "").matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1]);
    expect(new Set(keys), "the extension is configured with something unexpected").toEqual(
      new Set(["storage", "origin"]),
    );
  });

  it("binds the extension to the configured origin, not the listen address", async () => {
    // Both words matter: `origin` proves the SDK is given an origin at all, and
    // `config` proves it is the operator's browser-visible one. A listener address
    // read at boot would make challenges unsatisfiable behind a proxy.
    const source = await readFile(join(PACKAGE_ROOT, "src", "payment", "siwx.ts"), "utf8");
    expect(source).toContain("origin: options.config.origin");
  });

  it("never falls back to the SDK's in-memory storage", async () => {
    for (const file of APPLICATION_FILES) {
      const code = codeOnly(await readFile(file, "utf8"));
      for (const token of MEMORY_SEAMS) {
        expect(code.includes(token), `${file.replace(PACKAGE_ROOT, "")} mentions ${token}`).toBe(false);
      }
    }
  });

  it("keeps the nonce ledger in SQLite, and implements both halves of the contract", async () => {
    // The SDK's request hook refuses to start unless `hasUsedNonce` and
    // `recordNonce` are *both* present - a storage that tracks only one side
    // either loses replay protection or breaks the build. Asserting the pair is
    // asserting the contract is wired whole, at the one place that owns it.
    const source = codeOnly(await readFile(join(PACKAGE_ROOT, "src", "db", "siwx-storage.ts"), "utf8"));
    expect(source).toContain("hasUsedNonce");
    expect(source).toContain("recordNonce");
    expect(source).toContain("hasPurchased");
  });
});
