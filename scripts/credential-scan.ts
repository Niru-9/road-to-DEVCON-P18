/**
 * `npm run scan:credentials` — look for anything that could be a real secret in
 * the shipped tree, across all three projects and the shared docs.
 *
 * ## Why this exists in P3 as well as P2
 *
 * P2 grew a scanner in its own T8 and it is the better tool for the job, so these
 * rules are the same rules. Two copies is a real smell and it is the lesser evil
 * here: the workspace has no shared package, and a security tool that one project
 * can edit out from under another is worse than a duplicated one. The rule set is
 * pinned from both sides — `tests/credential-scan.test.ts` in P2 asserts on
 * `RULE_COUNT`, and this file's own test asserts the same, so a rule added to one
 * without the other fails a test rather than drifting quietly.
 *
 * What *is* deliberately different, and stricter: **this scanner never prints any
 * part of a value it found.** P2 masks to three characters at each end, which is
 * enough to locate a value and is still three characters of a secret. A finding
 * here is `path:line  rule` and nothing else.
 *
 * ## Scope
 *
 * There is no Git repository in this workspace, so "tracked files" is defined the
 * way a reader would expect: every file a clone of this workspace would contain.
 * That is P3, its siblings P1 and P2, and the shared `docs/`.
 *
 * In scope, and worth naming because it is easy to forget:
 *
 * - **`public/` in all three projects.** P1 and P2 ship browser code there and P3
 *   does too, as three hand-written files with no build step. A secret pasted into
 *   a script is a secret in the repository, and a scanner that only looked at
 *   `src/` would miss it.
 * - **Generated frames**, `p3-bioscope/storage/**`. These are git-ignored, so a
 *   secret cannot be committed there, but they are produced by a script that runs
 *   on a developer's machine and they cost nothing to read. Scanned, and counted
 *   separately in the report, because "the generator emits no secrets" is a claim
 *   worth making rather than assuming.
 * - **A real `.env`, if one exists.** Its *absence* is the finding that matters. A
 *   rule that only works when the file is present is worthless, so `.env` is read
 *   when it is there and reported like anything else.
 *
 * Out of scope, each for a stated reason: `node_modules/` and other dependency
 * trees; `data/` (SQLite ledgers — binary, and they hold wallet addresses that are
 * public by design); dot-directories other than `.env` (`.claude/`, `.agents/` are
 * tooling configuration, not shipped code); and binary files, which are detected by
 * a NUL byte rather than trusted to their extension.
 *
 * ## What it deliberately does not report
 *
 * A scanner that cries wolf on `0x1111…1111`, on the public Ethereum Sepolia USDC
 * address, or on an English test title gets switched off. These rules are built
 * around *what a secret would be used for*, not around entropy: hashes, contract
 * addresses, amounts in base units and prose that happens to contain the word
 * "mnemonic" are all things this repository legitimately contains, and a tool that
 * cannot tell them apart is not evidence of anything.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, "..");

/** Directories that are never in a clone, or that are not ours. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  // Binary ledgers: they hold wallet addresses, which are public by design, and
  // reading them as text produces noise rather than findings.
  "data",
]);

/** Extensions that hold text a secret could hide in. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".css",
  ".html",
  ".svg",
  ".sh",
  ".ps1",
  ".bat",
  ".cmd",
  ".env",
  ".example",
  ".sql",
]);

/** Extensionless files worth reading, all of which appear in this workspace. */
const TEXT_FILENAMES = new Set([".env", ".gitignore", ".npmrc", ".netrc", "Dockerfile", "LICENSE"]);

/** Never scanned: a lockfile's integrity hashes are noise, and it is 300 KiB of it. */
const SKIP_FILES = new Set(["package-lock.json"]);

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
}

/**
 * An identifier that names a secret: `PRIVATE_KEY`, `privateKey`, `apiKey`,
 * `signerToken`, `DB_PASSWORD`.
 *
 * The leading and trailing character classes are both allowed to be empty, so
 * `PRIVATE_KEY` matches itself and `apiKey` matches `APIKEY`. An earlier version
 * required a character before the keyword, which made the catch-all rule below
 * dead code - and a dead rule is how a scan reports a clean tree for the wrong
 * reason.
 */
const SECRET_NAME =
  /([A-Za-z0-9_]*(?:PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|API_?KEY|MNEMONIC|SEED_?PHRASE|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)/i;

/** The literal assigned to `name` on this line, or `null` if there is not one. */
function assignedValue(name: string, line: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`${escaped}\\s*[:=]\\s*["'\`]([^"'\`]{4,})["'\`]`).exec(line);
  return assignment === null ? null : (assignment[1] as string);
}

/**
 * Values that are obviously documentation, not secrets.
 *
 * Two tests, deliberately separate. The first is anchored: it only accepts a value
 * that *is* a conventional placeholder. The second looks for a marker word, but on
 * word boundaries - so `0x0000…0` and `your-key-here` are placeholders while a real
 * key containing "Example" in camel case is still reported. A single substring test
 * would have suppressed the second silently, which is the failure mode of every
 * secret scanner that has never been audited.
 */
const PLACEHOLDER_EXACT = new RegExp(
  [
    "^(?:|x{3,}|_+|-+|\\*{3,}|<[^>]*>|\\$\\{[^}]*\\}|\\$[A-Z_][A-Z0-9_]*|\\{\\{[^}]*\\}\\}|none|null|nil|true|false|undefined|todo|changeme|change-me)$",
    "^0x[0.]+$",
  ].join("|"),
  "i",
);

const PLACEHOLDER_MARKER = new RegExp(
  "\\b(?:fake|stub|stubs|example|examples|placeholder|redacted|dummy|sample|samples|notreal|not-real|dontuse|don-t-use|your|my|replace|insert|unset|todo|fixme|xxx+)\\b",
  "i",
);

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_EXACT.test(value) || PLACEHOLDER_MARKER.test(value);
}

/**
 * A value computed at runtime cannot be a hardcoded credential.
 *
 * ``headers.authorization = `Bearer ${options.apiKey}` `` is the code that *uses* a
 * key, not a copy of one, and reading it as a secret is the difference between a
 * scanner that finds things and one that gets switched off.
 */
function isDynamic(value: string): boolean {
  return value.includes("${") || /\bprocess\s*\.\s*env\b/.test(value);
}

type Rule = { readonly name: string; readonly test: (line: string) => string | null };

/** Each rule returns the matched text (used only by the self-test) or `null`. */
const RULES: readonly Rule[] = [
  {
    name: "PEM private key block",
    test: (line) => /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.exec(line)?.[0] ?? null,
  },
  {
    name: "provider API key with a known prefix",
    test: (line) =>
      /\b(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})/.exec(
        line,
      )?.[0] ?? null,
  },
  {
    name: "Google service account private_key id",
    test: (line) => /"private_key_id"\s*:\s*"([0-9a-f]{40})"/.exec(line)?.[0] ?? null,
  },
  {
    name: "JSON web token",
    test: (line) => /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/.exec(line)?.[0] ?? null,
  },
  {
    name: "bearer token in a header literal",
    test: (line) => /["'`]Authorization["'`]\s*[:=,]\s*["'`]Bearer\s+[A-Za-z0-9._~+/-]{20,}/.exec(line)?.[0] ?? null,
  },
  {
    // A 32-byte hex literal is what a secp256k1 key looks like. Reported only when
    // it is *named* like a key, so hashes and commitments stay quiet.
    name: "32-byte hex literal named as a key or seed",
    test: (line) => {
      const named = SECRET_NAME.exec(line);
      if (named === null) return null;
      const hex = /\b(?:0x)?[0-9a-fA-F]{64}\b/.exec(line);
      if (hex === null || isPlaceholder(hex[0])) return null;
      const value = assignedValue(named[1] ?? "", line);
      if (value !== null && isPlaceholder(value.trim())) return null;
      return hex[0];
    },
  },
  {
    name: "URL with inline credentials",
    test: (line) => /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.exec(line)?.[0] ?? null,
  },
  {
    // The name is load-bearing. A mnemonic and an English sentence are structurally
    // identical, so counting words on any line that mentions "mnemonic" flags this
    // repository's own security prose. Requiring an assignment kills that.
    name: "seed phrase",
    test: (line) =>
      /\b(?:mnemonic|seed[_-]?phrase|seedwords?|bip39)\s*[:=]\s*["'`]([a-z]{3,8}(?: [a-z]{3,8}){11,23})["'`]/.exec(
        line,
      )?.[0] ?? null,
  },
  {
    // Needs both a real checksum and a shape that is not an amount of money: no
    // currency mark in front, no decimal part behind.
    name: "Luhn-valid payment card number",
    test: (line) => {
      for (const candidate of line.match(/(?<![\w$.])\d(?:[ -]?\d){12,18}(?!\d|\.\d)/g) ?? []) {
        const digits = candidate.replace(/\D/g, "");
        if (digits.length < 13 || digits.length > 19) continue;
        let sum = 0;
        let double = false;
        for (let index = digits.length - 1; index >= 0; index -= 1) {
          let digit = Number(digits[index]);
          if (double) {
            digit *= 2;
            if (digit > 9) digit -= 9;
          }
          sum += digit;
          double = !double;
        }
        if (sum % 10 === 0) return candidate;
      }
      return null;
    },
  },
];

/**
 * Marks a line as a deliberate exception. Everything after it is the reason, and
 * the reason is printed in the report.
 *
 * Matched only in comment position. A bare substring test would also fire on this
 * file's own doc comment and on the test that reads this constant, which would put
 * two meaningless entries in the suppression list and teach a reviewer to skim past
 * it - the exact outcome the list exists to prevent.
 */
export const ALLOW_MARKER = "credential-scan:allow";

const ALLOW_DIRECTIVE = new RegExp(String.raw`(?://|#|/\*)\s*${ALLOW_MARKER}\b`);

/** Suppressions for the block currently being scanned, as `line: reason`. */
let suppressed: string[] = [];

/** Every suppression across the run, as workspace-relative `path:line  reason`. */
const suppressions: string[] = [];

function reasonFor(line: string): string {
  return (line.split(ALLOW_MARKER)[1] ?? "").trim() || "(no reason given)";
}

/**
 * Apply every rule to one block of text.
 *
 * Exported so the rules can be tested against known-bad and known-benign input. A
 * credential scanner that is never shown a real secret is not evidence that it would
 * notice one, and one that is never shown a harmless line is not evidence that it
 * would stay quiet.
 */
export function scanText(text: string): readonly Finding[] {
  const found: Finding[] = [];
  suppressed = [];
  text.split(/\r?\n/).forEach((line, index) => {
    // A hostile-input fixture has to contain the hostile string to prove it is
    // refused, so the rule and the test are in direct conflict and one has to give.
    // Requiring the marker to be written out - and counting the lines that carry it
    // in the report - makes the exception a visible, auditable act.
    if (ALLOW_DIRECTIVE.test(line)) {
      suppressed.push(`${index + 1}: ${reasonFor(line)}`);
      return;
    }

    for (const rule of RULES) {
      if (rule.test(line) !== null) {
        found.push({ file: "<text>", line: index + 1, rule: rule.name });
      }
    }

    // The catch-all: a key-shaped *name* with a literal value. Checked separately
    // because the value, not the name, decides whether it is a placeholder.
    const named = SECRET_NAME.exec(line);
    if (named === null) return;
    const name = named[1];
    if (name === undefined) return;
    const value = assignedValue(name, line);
    if (value === null) return;
    if (isDynamic(value)) return;
    if (isPlaceholder(value.trim())) return;
    // A short value under a name like `tokenCount` is a count, not a secret.
    if (value.length < 12) return;
    found.push({ file: "<text>", line: index + 1, rule: `literal assigned to ${name}` });
  });
  return found;
}

/** The number of rules applied, for the report and for the self-test. */
export const RULE_COUNT = RULES.length + 1;

function isScannable(file: string): boolean {
  const name = file.slice(file.lastIndexOf(sep) + 1);
  if (SKIP_FILES.has(name)) return false;
  // Every `.env*` file, whatever it is called: `.env`, `.env.example`,
  // `.env.local`, `.env.test`. These are the files a credential ends up in.
  if (name === ".env" || name.startsWith(".env.")) return true;
  const ext = extname(file).toLowerCase();
  if (TEXT_FILENAMES.has(name)) return true;
  if (ext === "") return true;
  if ([".sqlite", ".db", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".ico", ".woff", ".woff2"].includes(ext)) {
    return false;
  }
  return TEXT_EXTENSIONS.has(ext);
}

function scanFile(file: string, report: (finding: Finding) => void): void {
  const text = readFileSync(file, "utf8");
  // A NUL byte in the first kilobyte means binary wearing a text extension.
  if (text.slice(0, 1024).includes("\0")) return;

  for (const finding of scanText(text)) {
    report({ ...finding, file: relative(WORKSPACE_ROOT, file).split(sep).join("/") });
  }
  const path = relative(WORKSPACE_ROOT, file).split(sep).join("/");
  for (const entry of suppressed.splice(0, suppressed.length)) {
    const [line = "", ...rest] = entry.split(": ");
    suppressions.push(`${path}:${line}  ${rest.join(": ")}`);
  }
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Dot-directories are tooling, not shipped code.
      if (entry.name.startsWith(".")) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walk(full));
      continue;
    }
    // Dot-*files* are a different question, and getting it wrong is expensive: an
    // earlier version skipped every entry beginning with a dot except `.env`, which
    // meant **`.env.example` was never scanned** — the one file a real key is most
    // likely to be pasted into by accident, and the one whose whole job is to prove
    // there are no credentials in tracked files. Everything starting with `.env` is
    // in scope now, and the rest of the dot-files are decided by name below.
    if (entry.isFile() && isScannable(full)) found.push(full);
  }
  return found;
}

/** Every directory a clone of this workspace contains. P3 first, then its siblings. */
export function scanRoots(): string[] {
  const candidates = [
    PROJECT_ROOT,
    join(WORKSPACE_ROOT, "p2-coin-purse"),
    join(WORKSPACE_ROOT, "p1-operators-booth"),
    join(WORKSPACE_ROOT, "docs"),
  ];
  return candidates.filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

export interface ScanReport {
  readonly roots: readonly string[];
  readonly files: readonly string[];
  readonly bytes: number;
  readonly findings: readonly Finding[];
  readonly suppressions: readonly string[];
}

/** Run the whole scan and hand back everything, for the report and for tests. */
export function runScan(): ScanReport {
  // Reset first, so calling this twice - once for the report and once from a test -
  // does not double every suppression in the second result.
  suppressions.length = 0;
  const roots = scanRoots();
  const files = roots.flatMap(walk);
  const findings: Finding[] = [];
  for (const file of files) {
    scanFile(file, (finding) => findings.push(finding));
  }
  return {
    roots: roots.map((root) => relative(WORKSPACE_ROOT, root) || "."),
    files,
    bytes: files.reduce((total, file) => total + readFileSync(file, "utf8").length, 0),
    findings,
    suppressions: [...suppressions],
  };
}

/** How many of the scanned files live under a given relative directory. */
function countUnder(files: readonly string[], prefix: string): number {
  const needle = `${prefix}/`;
  return files.filter((file) => {
    const path = relative(WORKSPACE_ROOT, file).split(sep).join("/");
    return path === prefix || path.startsWith(needle);
  }).length;
}

function main(): void {
  const report = runScan();
  const lines: string[] = [
    "",
    "  Credential scan",
    "  ===============",
    `  roots        ${report.roots.join(", ")}`,
    `  files read   ${report.files.length} (${(report.bytes / 1024).toFixed(0)} KiB)`,
    `  rules        ${RULE_COUNT}`,
    `  browser UI   ${countUnder(report.files, "p3-bioscope/public")} files in p3-bioscope/public, ` +
      `${countUnder(report.files, "p1-operators-booth/public")} in p1, ${countUnder(report.files, "p2-coin-purse/public")} in p2`,
    `  generated    ${countUnder(report.files, "p3-bioscope/storage")} generated frame files under p3-bioscope/storage`,
    "  excluded     node_modules/, data/ (binary ledgers), package-lock.json, dot-directories, binaries",
    "",
  ];

  if (report.findings.length === 0) {
    lines.push(`  PASS - no credential-shaped value in ${report.files.length} shipped files.`, "");
  } else {
    lines.push(`  FAIL - ${report.findings.length} finding(s). Location and rule only; no value is printed:`, "");
    for (const finding of report.findings) {
      lines.push(`    ${finding.file}:${finding.line}  ${finding.rule}`);
    }
    lines.push(
      "",
      "  Treat every one as real. Open the file at that line, move the value into an",
      "  environment variable, and rotate the credential before doing anything else.",
      "",
    );
  }

  if (report.suppressions.length > 0) {
    lines.push(
      `  ${report.suppressions.length} line(s) suppressed by \`${ALLOW_MARKER}\` - each one is an exception, not an oversight:`,
      "",
    );
    for (const entry of report.suppressions) lines.push(`    ${entry}`);
    lines.push("");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  // Non-zero is the point: this has to fail a pipeline, not decorate a log.
  process.exit(report.findings.length === 0 ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
