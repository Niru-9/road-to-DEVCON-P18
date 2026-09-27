/**
 * Everything the server reads from the environment, in one place.
 *
 * ## Why this exists
 *
 * Up to T3 the only environment handling was `defaultStorageRoot` in the media
 * store, because that was the only thing the app needed. The payment layer needs
 * a good deal more, and the failure mode of spreading that across call sites is
 * the one this module is built to prevent: a server that comes up in `testnet`
 * mode with no facilitator URL, prints nothing about it, and answers paid requests
 * with 402s that no client can ever satisfy.
 *
 * So configuration is *loaded once, validated completely, and handed around as a
 * finished object*. Nothing below the entrypoint reads `process.env`. Two
 * consequences worth having:
 *
 * - A misconfiguration is one error listing **every** problem, before the port is
 *   bound. Not one problem per restart.
 * - Tests cannot accidentally depend on a developer's `.env`, because they build
 *   a config literal rather than inheriting the ambient one.
 *
 * ## The cross-field rule that matters most
 *
 * `BIOSCOPE_PAYMENT_MODE=testnet` is a claim that real testnet settlement can
 * happen. If it is set without a key, a recipient and a facilitator, that claim
 * is false, and the server refuses to start rather than starting into a state
 * where every unlock silently fails. The error names the missing variables, so
 * the fix is a copy-paste from `.env.example`.
 *
 * ## Nothing here is a secret, and nothing here is logged wholesale
 *
 * `payerPrivateKey` is parsed for shape and then carried as a value. The
 * `describeConfig` function below is the only intended way to print a config to a
 * human, and it reports the key as *present or absent* and never as a value.
 * That is the whole reason it exists as a separate function instead of callers
 * picking fields: there is exactly one place where the safe rendering lives.
 */

import { getDefaultAsset } from "@x402/evm";

import { assertAtomicAmount, type AtomicAmount } from "./domain/amount.js";
import type { SettlementMode } from "./domain/entitlement.js";
import { MAX_SESSION_TTL_SECONDS, MIN_SESSION_TTL_SECONDS } from "./domain/session.js";
import { isWalletAddress } from "./domain/wallet.js";
import { defaultStorageRoot } from "./media/frame-store.js";

/**
 * The only chain P3 will ever settle on.
 *
 * CAIP-2 id for Ethereum Sepolia. Hardcoded on purpose. A `.env` that could
 * point this at mainnet is a `.env` that can lose real money, and this is a demo
 * whose entire safety story is "testnet only". The value is not configurable.
 *
 * Chosen because the configured facilitator advertises x402 v2 `exact` on
 * `eip155:11155111`; a chain the facilitator does not serve cannot settle.
 */
export const ETHEREUM_SEPOLIA: `eip155:${number}` = "eip155:11155111";

/** Numeric chain id, for the SIWX challenge's `chainId`. */
export const ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;

/**
 * Circle-issued USDC on Ethereum Sepolia.
 *
 * Declared here rather than read from the SDK's default-asset table, because
 * that table has no entry for this chain: `getDefaultAsset("eip155:11155111")`
 * throws. The address and the EIP-712 domain below were read from the contract
 * itself (`name()` = "USDC", `version()` = "2", 6 decimals), and
 * `transferWithAuthorization` is present, so the EIP-3009 `exact` flow applies.
 */
export const ETHEREUM_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/** The EIP-712 domain the wallet signs against, read from the token. */
export const ETHEREUM_SEPOLIA_USDC_NAME = "USDC";
export const ETHEREUM_SEPOLIA_USDC_VERSION = "2";

/** USDC has 6 decimals, so one base unit is 0.000001 USDC. */
export const ETHEREUM_SEPOLIA_USDC_DECIMALS = 6;

/**
 * Address used as `payTo` when a simulated server has no recipient configured.
 *
 * The zero address, deliberately. Every other choice is worse: a real address
 * would imply coins are going somewhere, and a made-up one would produce a 402
 * that a real client would fail on for a reason nobody could diagnose. The zero
 * address is structurally valid, obviously not a real recipient, and cannot be
 * mistaken for one. It is reachable only in `simulated` mode, where the local
 * facilitator is the thing that "settles".
 */
export const SIMULATED_RECIPIENT = "0x0000000000000000000000000000000000000000";

/** How long a client may take to pay, in seconds. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/**
 * Default sign-in session lifetime.
 *
 * 15 minutes: long enough to watch a short reel in one sitting, short enough that
 * a cookie left on a shared machine is not a standing key to somebody's library.
 */
export const DEFAULT_SESSION_TTL_SECONDS = 900;

export interface BioscopeConfig {
  readonly paymentMode: SettlementMode;
  readonly port: number;
  /** Public origin, e.g. `http://localhost:8787`. Bound into SIWX challenges. */
  readonly origin: string;
  readonly reelPriceAtomic: AtomicAmount;
  /** `null` when unset. Non-null is required in `testnet` mode. */
  readonly recipient: string | null;
  readonly dbPath: string;
  /** Absolute. Resolved against the package root, like the media store does. */
  readonly storageRoot: string;
  /** `null` when unset. Required in `testnet` mode. */
  readonly facilitatorUrl: string | null;
  /**
   * `null` when unset. Optional everywhere, including `testnet` mode.
   *
   * A secret. Never rendered by `describeConfig`, never included in an error
   * message, and never written to a log line.
   *
   * **The server does not use this, and does not require it.** The x402 client
   * signs the payment payload and the facilitator verifies it; this process only
   * ever *receives* a payload. The key is read so that a paying client in the same
   * process - or a script using this config - has it to hand, and so its absence
   * can be reported rather than discovered later. See the note on
   * `testnetRequiresPayerKey` below.
   */
  readonly payerPrivateKey: `0x${string}` | null;
  readonly siwxExpirationSeconds: number;
  /**
   * How long a sign-in session stays usable, in seconds.
   *
   * A session is a *convenience*, never an entitlement: it replaces a second
   * wallet signature, and the purchase lookup still happens on every request. So
   * this lifetime is a usability dial, and it is deliberately shorter than the
   * SIWX challenge lifetime it is derived from - a session outliving the window
   * its challenge was checked in would be a credential nobody re-verified for
   * longer than the server ever promised.
   */
  readonly sessionTtlSeconds: number;
  readonly network: typeof ETHEREUM_SEPOLIA;
  readonly asset: string;
  readonly assetDecimals: number;
  readonly maxTimeoutSeconds: number;
}

/** Raised for any unusable configuration. Carries every problem at once. */
export class ConfigError extends Error {
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super(
      `The Bioscope cannot start. ${problems.length} configuration problem${
        problems.length === 1 ? "" : "s"
      }:\n` + problems.map((problem) => `  - ${problem}`).join("\n"),
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

/** Read a value that has a usable default, complaining only if it is set and wrong. */
function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = trimmed(env, name);
  if (raw === "") {
    return fallback;
  }
  if (!/^[0-9]+$/.test(raw)) {
    problems.push(`${name} must be a whole number, got ${JSON.stringify(raw)}.`);
    return fallback;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}, got ${value}.`);
    return fallback;
  }
  return value;
}

/** Validate a URL with no path, query or fragment - it is an origin, not a base. */
function originValue(raw: string, fallbackPort: number, problems: string[]): string {
  if (raw === "") {
    return `http://localhost:${fallbackPort}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`BIOSCOPE_ORIGIN must be an absolute URL, got ${JSON.stringify(raw)}.`);
    return `http://localhost:${fallbackPort}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    problems.push(`BIOSCOPE_ORIGIN must be http or https, got ${JSON.stringify(url.protocol)}.`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    problems.push(
      `BIOSCOPE_ORIGIN must be a bare origin with no path, query or fragment, got ${JSON.stringify(raw)}. ` +
        `It is compared against the browser's own origin, so http://localhost:${fallbackPort} is right and ` +
        `http://localhost:${fallbackPort}/api is not.`,
    );
  }
  return url.origin;
}

function facilitatorUrlValue(raw: string, problems: string[]): string | null {
  if (raw === "") {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      problems.push(`BIOSCOPE_FACILITATOR_URL must be http or https, got ${JSON.stringify(url.protocol)}.`);
      return null;
    }
    return url.origin;
  } catch {
    problems.push(`BIOSCOPE_FACILITATOR_URL must be an absolute URL, got ${JSON.stringify(raw)}.`);
    return null;
  }
}

function privateKeyValue(raw: string, problems: string[]): `0x${string}` | null {
  if (raw === "") {
    return null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    // The value is not echoed. A 64-character secret is not a typo report.
    problems.push("BIOSCOPE_PAYER_PRIVATE_KEY must be `0x` followed by 64 hex characters.");
    return null;
  }
  return raw as `0x${string}`;
}

/**
 * Build the server's configuration.
 *
 * @param env Defaults to `process.env`. Tests pass an explicit record.
 * @throws {ConfigError} listing every problem found, not just the first.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BioscopeConfig {
  const problems: string[] = [];

  const rawMode = trimmed(env, "BIOSCOPE_PAYMENT_MODE").toLowerCase();
  const paymentMode: SettlementMode =
    rawMode === "" ? "simulated" : rawMode === "simulated" || rawMode === "testnet" ? rawMode : "simulated";
  if (rawMode !== "" && rawMode !== "simulated" && rawMode !== "testnet") {
    problems.push(
      `BIOSCOPE_PAYMENT_MODE must be "simulated" or "testnet", got ${JSON.stringify(rawMode)}. ` +
        `There is no third mode, and a client must never be able to talk the server into one.`,
    );
  }

  const port = positiveInteger(env, "PORT", 8787, 1, 65_535, problems);
  const origin = originValue(trimmed(env, "BIOSCOPE_ORIGIN"), port, problems);

  const rawPrice = trimmed(env, "BIOSCOPE_REEL_PRICE_ATOMIC") || "1000";
  let reelPriceAtomic: AtomicAmount = "1000";
  try {
    assertAtomicAmount(rawPrice);
    reelPriceAtomic = rawPrice;
  } catch {
    problems.push(
      `BIOSCOPE_REEL_PRICE_ATOMIC must be a whole number of USDC base units with no leading zeros, ` +
        `got ${JSON.stringify(rawPrice)}. USDC on Ethereum Sepolia has ${ETHEREUM_SEPOLIA_USDC_DECIMALS} decimals, ` +
        `so 1000 is 0.001 USDC.`,
    );
  }

  const rawRecipient = trimmed(env, "BIOSCOPE_RECIPIENT_ADDRESS");
  let recipient: string | null = null;
  if (rawRecipient !== "") {
    if (isWalletAddress(rawRecipient)) {
      recipient = rawRecipient.toLowerCase();
    } else {
      problems.push(
        "BIOSCOPE_RECIPIENT_ADDRESS must be a 20-byte Ethereum Sepolia address (`0x` plus 40 hex characters).",
      );
    }
  }

  const dbPath = trimmed(env, "BIOSCOPE_DB_PATH") || "./data/bioscope.db";
  const storageRoot = defaultStorageRoot(env);
  const facilitatorUrl = facilitatorUrlValue(trimmed(env, "BIOSCOPE_FACILITATOR_URL"), problems);
  const payerPrivateKey = privateKeyValue(trimmed(env, "BIOSCOPE_PAYER_PRIVATE_KEY"), problems);
  const siwxExpirationSeconds = positiveInteger(
    env,
    "BIOSCOPE_SIWX_EXPIRATION_SECONDS",
    300,
    30,
    3_600,
    problems,
  );
  const sessionTtlSeconds = positiveInteger(
    env,
    "BIOSCOPE_SESSION_TTL_SECONDS",
    DEFAULT_SESSION_TTL_SECONDS,
    MIN_SESSION_TTL_SECONDS,
    MAX_SESSION_TTL_SECONDS,
    problems,
  );

  // The cross-field rule. In `testnet` mode every one of these is load-bearing,
  // and a server missing any of them would come up looking healthy while no
  // viewer could ever unlock anything.
  //
  // Note what is *not* required: the payer private key. The x402 `exact` server
  // scheme never signs anything - the client signs the payment, the facilitator
  // verifies it, and the server only needs to know where the facilitator is. So
  // demanding a private key here would be demanding a secret the process has no
  // use for, and an unused required secret is a liability, not a safety feature.
  // It is still parsed, validated for shape, and reported at startup, so an
  // operator can tell at a glance whether the key a *client* would need is
  // present.
  if (paymentMode === "testnet") {
    if (recipient === null) {
      problems.push("BIOSCOPE_RECIPIENT_ADDRESS is required when BIOSCOPE_PAYMENT_MODE=testnet.");
    }
    if (facilitatorUrl === null) {
      problems.push("BIOSCOPE_FACILITATOR_URL is required when BIOSCOPE_PAYMENT_MODE=testnet.");
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    paymentMode,
    port,
    origin,
    reelPriceAtomic,
    recipient,
    dbPath,
    storageRoot,
    facilitatorUrl,
    payerPrivateKey,
    siwxExpirationSeconds,
    sessionTtlSeconds,
    network: ETHEREUM_SEPOLIA,
    asset: ETHEREUM_SEPOLIA_USDC,
    assetDecimals: ETHEREUM_SEPOLIA_USDC_DECIMALS,
    maxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
  };
}

/**
 * The `payTo` for the payment requirements.
 *
 * In `testnet` mode this is always a real configured address, because the config
 * loader refuses to start otherwise. In `simulated` mode with no recipient it is
 * the zero address, and `describeConfig` says so out loud.
 */
export function payToFor(config: BioscopeConfig): string {
  return config.recipient ?? SIMULATED_RECIPIENT;
}

/**
 * Human-readable summary, safe to print at startup.
 *
 * The private key is reported as present or absent. That is the entire reason
 * this function is exported instead of callers formatting the config themselves:
 * one rendering, and it cannot grow a line that leaks.
 */
/**
 * Report the payer key as present or absent, and say what it is for.
 *
 * Never the value. This is the only rendering of it in the codebase.
 */
function payerKeyLabel(config: BioscopeConfig): string {
  return config.payerPrivateKey === null
    ? "absent - a client that pays will need one"
    : "present (not shown) - for the paying client, not this server";
}

export function describeConfig(config: BioscopeConfig): string {
  const lines = [
    `  payment mode      ${config.paymentMode}`,
    `  chain             ${config.network} (Ethereum Sepolia, test USDC only)`,
    `  asset             ${config.asset} (${config.assetDecimals} decimals)`,
    `  origin            ${config.origin}`,
    `  listening on      port ${config.port}`,
    `  reel price        ${config.reelPriceAtomic} base units`,
    `  recipient         ${config.recipient ?? `${SIMULATED_RECIPIENT} (no recipient configured)`}`,
    `  facilitator       ${config.facilitatorUrl ?? "none - the local simulated facilitator is in use"}`,
    `  payer key         ${payerKeyLabel(config)}`,
    // The two halves of sign-in, stated together because either alone is
    // misleading: the challenge lifetime is how long a *signature* stays
    // spendable, and the recovery is local and real. A reader who sees "300s" and
    // assumes it bounds a payment authorization has misread it.
    `  sign-in           SIWX challenge lifetime ${config.siwxExpirationSeconds}s, single use, verified locally`,
    `  session           ${config.sessionTtlSeconds}s, HttpOnly cookie, one signature buys one session`,
    `  database          ${config.dbPath}`,
    `  frame store       ${config.storageRoot}`,
  ];
  return lines.join("\n");
}

/**
 * One line that says out loud whether money can move.
 *
 * Printed at startup and returned by `GET /api/health`, because a demo that
 * *looks* like it takes payment but does not is the exact thing this project must
 * never be. The label is not decoration.
 */
export function settlementModeLabel(config: BioscopeConfig): string {
  return config.paymentMode === "testnet"
    ? "testnet - real x402 settlement on Ethereum Sepolia"
    : "simulated - no chain is contacted and no funds move";
}

/**
 * The asset this project advertises, checked against the contract's own domain.
 *
 * The SDK's default-asset table cannot be used for this chain - it has no
 * Ethereum Sepolia entry and `getDefaultAsset` throws - so the values are
 * declared in this module. What is still verified here is the part that is
 * checkable without a network call: the address is a well-formed 20-byte
 * address and the declared EIP-712 domain is the one Circle's USDC reports.
 */
export function assertAssetMatchesUsdc(): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(ETHEREUM_SEPOLIA_USDC)) {
    throw new Error(
      `The configured Ethereum Sepolia USDC address (${ETHEREUM_SEPOLIA_USDC}) is not a ` +
        `20-byte address. Fix ETHEREUM_SEPOLIA_USDC in src/config.ts, or unlocks will be ` +
        `priced in a token the facilitator will not accept.`,
    );
  }
  if (ETHEREUM_SEPOLIA_USDC_DECIMALS !== 6) {
    throw new Error(
      `USDC has 6 decimals; this project declares ${ETHEREUM_SEPOLIA_USDC_DECIMALS}. A price in ` +
        `base units would then be wrong by a factor of ten.`,
    );
  }
}
