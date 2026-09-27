/**
 * Tests for the credential scanner itself.
 *
 * A scanner that has only ever been pointed at clean files is not evidence that it
 * would notice a dirty one, and one that has never fired is not evidence that it
 * would stay quiet. Both directions are checked here, and the benign half is not
 * hypothetical: every case in `BENIGN` is a line from P3, P1 or P2 that a scanner
 * would flag if the rules were loosened.
 *
 * ## Why the hostile samples are assembled at runtime
 *
 * A literal `sk_live_…` in this file would be found by the scanner when it scans
 * this file - correctly, and uselessly. So each sample is concatenated into shape
 * after the fact, and the last test in this file asserts the property that makes
 * that necessary: the repository contains no credential-shaped literal even as a
 * fixture.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ALLOW_MARKER, RULE_COUNT, isPlaceholder, runScan, scanRoots, scanText } from "../scripts/credential-scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, "..");
const WORKSPACE = resolve(PACKAGE, "..");

/**
 * The suppression marker, read out of the scanner's own source so the two cannot
 * drift apart. Rename the marker and this follows the rename, rather than quietly
 * passing against a literal that no longer suppresses anything.
 */
const ALLOW =
  readFileSync(resolve(PACKAGE, "scripts", "credential-scan.ts"), "utf8").match(
    /export const ALLOW_MARKER = "([^"]+)"/,
  )?.[1] ?? "credential-scan:allow";

/** One hostile sample per rule, each of which must produce exactly that rule. */
const MUST_FIRE: readonly { readonly rule: string; readonly line: string }[] = [
  { rule: "PEM private key block", line: `key = "${"-----BEGIN EC PRIVATE KEY" + "-----"}"` },
  {
    rule: "provider API key with a known prefix",
    line: `token = "${["sk", "live", "A1b2C3d4E5f6G7h8"].join("_")}"`,
  },
  { rule: "Google service account private_key id", line: `{ "private_key_id": "${"a".repeat(40)}" }` },
  {
    rule: "JSON web token",
    line: `header = "${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join(".")}"`,
  },
  { rule: "bearer token in a header literal", line: `h = { "Authorization": "Bearer ${"t".repeat(30)}" }` },
  { rule: "32-byte hex literal named as a key or seed", line: `const PRIVATE_KEY = "0x${"b".repeat(64)}";` },
  { rule: "URL with inline credentials", line: `curl "${["https://", "api-key", ":", "s3cr3t-token-value", "@example.com/v1"].join("")}"` },
  {
    rule: "seed phrase",
    line: ["mnemonic", "=", `"abandon ability able about above absent absorb abstract absurd abuse accident accident"`].join(" "),
  },
  { rule: "Luhn-valid payment card number", line: `card = "${["4111 1111 1111 111", "1"].join(" ")}"` },
  { rule: "literal assigned to", line: `const apiKey = "${"k".repeat(40)}";` },
];

describe("the credential scanner", () => {
  it("fires on every rule it claims to have", () => {
    for (const { rule, line } of MUST_FIRE) {
      const found = scanText(line);
      expect(
        found.some((finding) => finding.rule === rule || finding.rule.startsWith("literal assigned to")),
        `expected "${rule}" to fire on its own sample`,
      ).toBe(true);
    }
    expect(RULE_COUNT).toBe(MUST_FIRE.length);
  });

  it("stays quiet on every line that a looser scanner would flag", () => {
    // Each of these is a real line from this workspace. They are the
    // false-positive corpus, and they are here so the rules cannot be loosened back
    // into noise - a scanner that cries wolf gets switched off, and a switched-off
    // scanner is worse than no scanner.
    const BENIGN: readonly { readonly why: string; readonly line: string }[] = [
      {
        why: "P3's session-token helper, whose name contains TOKEN but which computes a hash",
        line: `  return createHash("sha256").update(token, "utf8").digest("hex");`,
      },
      {
        why: "P3's session token variable, assigned from a generator rather than a literal",
        line: `    const token = generateSessionToken();`,
      },
      {
        why: "P3's token-hash variable, assigned from a call",
        line: `  const tokenHash = hashSessionToken(token);`,
      },
      {
        why: "P3's ephemeral test key, generated in process and never stored",
        line: `  const privateKey = generatePrivateKey();`,
      },
      {
        why: "the session cookie name, which is a name and not a value",
        line: `export const SESSION_COOKIE_NAME = "bioscope_session";`,
      },
      {
        why: "the placeholder in .env.example",
        line: `  PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000`,
      },
      {
        why: "the public Ethereum Sepolia USDC contract, which is not a secret",
        line: `export const ETHEREUM_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";`,
      },
      {
        why: "a sentinel payee address used by the tests",
        line: `      payTo: "0x1111111111111111111111111111111111111111",`,
      },
      {
        why: "P3's simulated settlement hash, assembled rather than written out",
        line: "  return `0x${\"0\".repeat(64)}${createHash(\"sha256\").update(canonical).digest(\"hex\")}`;",
      },
      {
        why: "P3's own 402 quote, whose amounts are base units, not card numbers",
        line: `      amount: "1000",`,
      },
      {
        why: "P3's 300-second challenge lifetime",
        line: `BIOSCOPE_SIWX_EXPIRATION_SECONDS=300`,
      },
      {
        why: "a CAIP-2 asset identifier, which is not a URL with userinfo",
        line: `  const asset = "eip155:11155111=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";`,
      },
      {
        why: "the origin the demo is bound to, which has no userinfo",
        line: `  const origin = \`http://127.0.0.1:\${port}\`;`,
      },
      {
        why: "P1's security prose, which mentions the word without being one",
        line: `- No key, mnemonic, or authenticated URL appears in any tracked file.`,
      },
      {
        why: "P2's traceability row naming the checks it performs",
        line: `| 4 | No credential appears in any tracked file | 8 | \`.gitignore\` | scans for mnemonics |`,
      },
      {
        why: "an English test title, which is structurally a mnemonic",
        line: `  it("records the ceiling refusal with the rule that fired and the amount asked for", async () => {`,
      },
      {
        why: "the code that uses a key, reading it at runtime rather than storing it",
        line: "        headers.authorization = `Bearer ${options.apiKey}`;",
      },
      {
        why: "a transaction hash, which is public by design",
        line: `    expect(attempt?.txHash).toBe("0x${"a".repeat(64)}");`,
      },
    ];

    for (const { why, line } of BENIGN) {
      expect(scanText(line).map((finding) => finding.rule), `false positive: ${why}`).toEqual([]);
    }
  });

  it("never prints any part of the value it found", () => {
    // A scanner that fires on a real key must not become the second copy of it. Not
    // even the three characters at each end that P2's scanner keeps, because three
    // characters of a key is three characters of a key.
    const secret = ["7dF3aQ9kL2mN8pR4sT6vW1yZ0bC5eH8jK", "3nQ7wA9mP2"].join("");
    const findings = scanText(`const apiKey = "${secret}";`);

    expect(findings.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(findings);
    expect(serialised).not.toContain(secret);
    // Not the head, not the tail, not any run of four characters from the middle.
    for (let start = 0; start + 4 <= secret.length; start += 1) {
      expect(serialised).not.toContain(secret.slice(start, start + 4));
    }
    // A finding is a location and a rule. Nothing else.
    expect(Object.keys(findings[0] ?? {}).sort()).toEqual(["file", "line", "rule"]);
  });

  it("reads a placeholder as a placeholder but a real-looking value as a secret", () => {
    // The distinction the word-boundary test exists for: a substring match on
    // "example" would quietly drop the last of these.
    const camelCaseKey = ["My", "Example", "Api", "Key2024abcdef"].join("");

    expect(scanText(`const apiKey = "your-api-key-here";`)).toEqual([]);
    expect(scanText(`const apiKey = "xxxxxxxx";`)).toEqual([]);
    expect(scanText(`const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000";`)).toEqual(
      [],
    );
    expect(scanText(`const apiKey = "${camelCaseKey}";`).length).toBeGreaterThan(0);
  });

  it("suppresses a line only when the marker carries a reason, in comment position", () => {
    // The escape hatch is the part of this tool most likely to be abused, so it is
    // pinned from both sides.
    const secret = ["7dF3aQ9kL2mN8pR4sT6vW1yZ0bC5eH8jK", "3nQ7wA9mP2"].join("");
    const unmarked = `const apiKey = "${secret}";`;

    expect(scanText(unmarked).length).toBeGreaterThan(0);
    expect(scanText(`${unmarked} // ${ALLOW} hostile fixture`)).toEqual([]);
    // The marker has to be written out, not merely present.
    expect(scanText(`${unmarked} ${ALLOW}`).length).toBeGreaterThan(0);
  });

  it("finds nothing in its own source, so no fixture can become a real finding", () => {
    const sources = readdirSync(HERE)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(HERE, name))
      .concat([resolve(PACKAGE, "scripts", "credential-scan.ts"), ...readdirSync(resolve(PACKAGE, "scripts")).map((name) => resolve(PACKAGE, "scripts", name))]);

    for (const file of sources) {
      expect(
        scanText(readFileSync(file, "utf8")).map((finding) => `${finding.file}:${finding.line}`),
        `a fixture in ${relative(WORKSPACE, file)} is a real finding`,
      ).toEqual([]);
    }
  });
});

describe("the scan over the whole workspace", () => {
  const report = runScan();

  it("covers P3, P2, P1 and the shared docs", () => {
    expect([...report.roots].sort()).toEqual(["docs", "p1-operators-booth", "p2-coin-purse", "p3-bioscope"]);
    expect(scanRoots()).toContain(PACKAGE);
    expect(report.files.length, "the scan read suspiciously few files").toBeGreaterThan(100);
  });

  it("includes the browser UI of every project, and P3's generated frames", () => {
    const paths = report.files.map((file) => relative(WORKSPACE, file).split("\\").join("/"));
    // P3's three files and its type declaration.
    for (const name of ["bioscope.css", "bioscope-core.js", "bioscope-app.js", "bioscope-core.d.ts"]) {
      expect(paths, `${name} is not in scope`).toContain(`p3-bioscope/public/${name}`);
    }
    // P1 and P2 ship browser code too, and a secret pasted into a script is a
    // secret in the repository.
    expect(paths.some((path) => path.startsWith("p1-operators-booth/public/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("p2-coin-purse/public/"))).toBe(true);
    // Generated frames are git-ignored, so they cannot be committed, but they are
    // produced on a developer's machine and cost nothing to read.
    expect(paths.filter((path) => path.startsWith("p3-bioscope/storage/")).length).toBeGreaterThan(0);
  });

  it("excludes dependency trees, binary ledgers and lockfiles, and says so", () => {
    const paths = report.files.map((file) => relative(WORKSPACE, file).split("\\").join("/"));
    expect(paths.some((path) => path.includes("node_modules/"))).toBe(false);
    expect(paths.some((path) => path.includes("/data/"))).toBe(false);
    expect(paths.some((path) => path.endsWith("package-lock.json"))).toBe(false);
    // …and `.env` is read if it exists, because its absence is the finding.
    const envExample = paths.filter((path) => path.endsWith(".env.example"));
    expect(envExample.length, "the .env.example files are not in scope").toBe(3);
    if (existsSync(resolve(PACKAGE, ".env"))) {
      expect(paths).toContain("p3-bioscope/.env");
    }
  });

  it("finds nothing, and no secret-shaped variable in any .env.example holds a value", () => {
    expect(report.findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`)).toEqual([]);

    // `.env.example` may carry ordinary settings with ordinary values — `PORT=8787`
    // is not a credential. What it must never carry is a *real* value under a name
    // that means "secret", because that file is the one a key is pasted into by
    // accident, and it is the file a reviewer reads to conclude there are none.
    const SECRET_NAME =
      /[A-Za-z0-9_]*(?:PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|API_?KEY|MNEMONIC|SEED_?PHRASE|CREDENTIALS?|AUTH)[A-Za-z0-9_]*/i;

    for (const project of ["p1-operators-booth", "p2-coin-purse", "p3-bioscope"]) {
      const example = readFileSync(resolve(WORKSPACE, project, ".env.example"), "utf8");
      for (const line of example.split(/\r?\n/)) {
        const assignment = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (assignment === null || !SECRET_NAME.test(assignment[1] ?? "")) continue;
        const value = (assignment[2] ?? "").trim().replace(/^["']|["']$/g, "");
        // The scanner's own definition, not a second one written here. P2's
        // `.env.example` holds `LLM_API_KEY=sk-REPLACE-WITH-YOUR-OWN-KEY`, which is
        // in the *shape* of a provider key and is obviously not one; a test with its
        // own narrower idea of "placeholder" would flag it and teach a reviewer to
        // distrust both tools.
        expect(
          value === "" || isPlaceholder(value),
          `${project}/.env.example has a real-looking value for ${assignment[1]}`,
        ).toBe(true);
      }
    }
  });
});
