/**
 * The whole bioscope, on a real ephemeral port, with the payment layer wired for
 * real.
 *
 * ## Why the port is known before the app is built
 *
 * Sign-In-With-X binds every challenge it issues to a configured origin, and the
 * SDK rejects a presented challenge whose `domain` or `uri` origin does not match
 * that. A test on port `0` does not know its own origin until the listen callback
 * fires - but the app, and therefore the SIWX configuration, has to exist first.
 *
 * So the harness reserves a port, releases it, and only then builds the runtime
 * with `http://127.0.0.1:<that port>` as the origin. There is a theoretical race
 * between releasing and re-binding; it is not theoretical enough to matter, because
 * Vitest runs a file's tests serially in one process and the alternative - a
 * guessed origin - would make every SIWX assertion a claim about a fiction.
 *
 * The alternative was considered and rejected: build the app on port `0`, read the
 * real port, and patch the origin afterwards. The SDK captures the origin in a
 * closure at construction time, so there is nothing to patch. The port has to be
 * known first. That is the whole reason this function exists in this shape.
 *
 * ## What is real here, and what is not
 *
 * Real, from the SDK, unmodified: the route table, the 402, the
 * `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` encoding, requirement matching, the
 * settle lifecycle, the after-settle hook ordering, the SIWX challenge and its
 * validation, the signature recovery, and nonce replay protection.
 *
 * Faked, and only this:
 *
 * - **The facilitator.** `SimulatedFacilitator` contacts no chain and checks no
 *   signature. Every response it produces carries
 *   `X-Bioscope-Settlement-Mode: simulated`.
 *
 * The SIWX signature verifier is **not** on that list, and could not be even if it
 * wanted to be. T4 let this harness inject a deterministic `EVMMessageVerifier` so
 * the plumbing could be tested without a key pair. T5 deleted the option from the
 * application and deleted it here too, so every test server - and the real server -
 * verifies with viem's `verifyMessage`, and every SIWX header in the suite is a
 * real secp256k1 signature over a real EIP-4361 message. The key is generated in
 * process by `createEphemeralWallet()` and is thrown away with the process.
 *
 * ## The T3 suites use this too
 *
 * `preview-frame.test.ts` and `private-media.test.ts` used to call
 * `buildApp({ catalog, frames })`. That is no longer expressible - `AppDeps.payment`
 * is required and checked - and the loss is a gain: "a paid frame is not reachable
 * without payment" is now asserted against the real gate rather than against an app
 * that had no gate in it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import {
  encodeSIWxHeader,
  SIGN_IN_WITH_X,
  type CompleteSIWxInfo,
  type SIWxExtensionInfo,
  type SIWxPayload,
  type SignatureType,
} from "@x402/extensions/sign-in-with-x";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";

import { createReelCatalog, type ReelCatalog } from "../../src/domain/reels.js";
import { SESSION_COOKIE_NAME } from "../../src/domain/session.js";
import { frameFileName } from "../../src/media/frame-paths.js";
import type { FrameStore } from "../../src/media/frame-store.js";
import type { SqlitePurchaseStore } from "../../src/db/purchase-store.js";
import type { SqliteSessionStore } from "../../src/db/session-store.js";
import { createRuntime, listen, type BioscopeRuntime } from "../../src/runtime.js";
import { SimulatedFacilitator } from "../../src/payment/simulated-facilitator.js";
import type { BioscopeSIWxStorage } from "../../src/payment/siwx.js";
import type { RecordedPurchaseSummary } from "../../src/payment/settle.js";
import { SESSION_ROUTE } from "../../src/http/routes/session.js";
import { TEST_PRICE } from "./fixtures.js";
import { del, get, post, setCookies, type HttpResult } from "./http-server.js";
import { createEphemeralWallet, type ChallengeOverrides, type EphemeralWallet } from "./test-wallet.js";

/** A wallet address for tests. Holds nothing, has never held anything. */
export const TEST_WALLET = "0x1111111111111111111111111111111111111111";

/** A different wallet, for every "has not paid" case. */
export const OTHER_WALLET = "0x2222222222222222222222222222222222222222";

/**
 * The placeholder in a *payment* payload. Not a signature, and never checked.
 *
 * `SimulatedFacilitator` settles without verifying anything, so the payment half
 * of these tests can carry this. The SIWX half cannot: the real verifier sees it,
 * cannot recover an address from it, and refuses - which is what
 * `tests/siwx-real-signatures.test.ts` asserts.
 */
export const TEST_SIGNATURE = "0xtest";

export interface BioscopeTestServer {
  readonly baseUrl: string;
  /** The origin SIWX challenges are bound to. Equal to `baseUrl`. */
  readonly origin: string;
  /** The temp directory backing this server, for tests that restart it. */
  readonly root: string;
  readonly catalog: ReelCatalog;
  readonly frames: FrameStore;
  readonly runtime: BioscopeRuntime;
  readonly facilitator: SimulatedFacilitator;
  readonly siwxStorage: BioscopeSIWxStorage;
  /**
   * The live ledger, for tests that assert on rows rather than on HTTP.
   *
   * Exposed deliberately. A test that only ever reads status codes cannot tell a
   * server that wrote a correct row from one that wrote a wrong one, and cannot
   * tell "persisted" from "recomputed from a cookie on every request" - so the
   * persistence tests open the database and look.
   */
  readonly ledger: SqlitePurchaseStore;
  /** The session store, for tests that assert on rows rather than on cookies. */
  readonly sessions: SqliteSessionStore;
  /** One entry per successful settlement the recorder saw, in order. */
  readonly settlements: RecordedPurchaseSummary[];
  /** Every paid frame's bytes, by `<reelId>/<index>`. Used to prove no leak. */
  readonly paidFrameBytes: ReadonlyMap<string, Buffer>;
  /** GET the canonical paid-frame URL for a frame. */
  paidFrame(reelId: string, index: number, init?: RequestInit): Promise<HttpResult>;
  /** GET any path on this server. */
  request(path: string, init?: RequestInit): Promise<HttpResult>;
  /**
   * Pay for a reel properly and return the frame.
   *
   * Runs the whole x402 V2 exchange over the wire: 402, decode the
   * `PAYMENT-REQUIRED` header, build a payload, send it back in
   * `PAYMENT-SIGNATURE`, and follow whatever comes next. Fails loudly on
   * anything but a 200, because a test that wanted a 404 has its own helpers.
   *
   * @param wallet defaults to {@link TEST_WALLET}. To get SIWX access afterwards,
   * pay as `server.wallet.address` - the real key the server will recover.
   */
  buyFrame(reelId: string, index: number, wallet?: string): Promise<HttpResult>;
  /** The first (and only) requirement the server advertises for a paid frame. */
  requirementFor(reelId: string): Promise<PaymentRequired>;
  /** A `PAYMENT-SIGNATURE` header value for a real-looking payment. */
  paymentHeader(requirements: PaymentRequired, wallet?: string): string;
  /**
   * A SIWX header carrying `signature`, with nothing having vouched for it.
   *
   * The adversarial primitive, and the only SIWX header builder here that does not
   * sign. A server that accepts this is accepting a signature it never checked, so
   * every test that calls it is asserting a refusal. Never use it to assert a
   * grant - `signChallenge` is the only way to get one.
   */
  unverifiedHeader(requirements: PaymentRequired, signature: string, address?: string): string;
  /**
   * A SIWX header signed by a real ephemeral key, verified by the server's real
   * verifier.
   *
   * With no `overrides` this goes through the SDK's own client helper
   * (`createSIWxPayload`), origin assertion included, i.e. the path a real wallet
   * takes. `overrides` are applied to the server-issued challenge *before*
   * signing, which is how a test produces a cryptographically valid payload for a
   * challenge the honest client path would refuse to sign - bound to another
   * origin, already expired, issued for a different reel. The signature is real
   * either way, so a refusal can only come from the server's validation.
   *
   * @param signer sign with this key instead of the server's own. Defaults to the
   * server's, whose address is `server.wallet.address`.
   */
  signChallenge(
    requirements: PaymentRequired,
    overrides?: ChallengeOverrides,
    signer?: EphemeralWallet,
  ): Promise<string>;
  /**
   * Do the real client flow for signing in: take a 402's challenge, sign it with
   * a real key, and `POST` it to `/api/session`.
   *
   * The 402 is not optional decoration. The server only mints challenges while
   * building a 402, so a test that fabricated one would be testing a challenge
   * the server would never have issued. This walks the same three steps a wallet
   * would: ask, sign, exchange.
   *
   * @returns the raw response, the token from `Set-Cookie` (empty when the
   * request was refused), and a ready-to-send `Cookie` header value.
   */
  signIn(options?: SignInOptions): Promise<SignInResult>;
  /** Read the current session, as a browser would with the cookie attached. */
  whoami(cookie?: string): Promise<HttpResult>;
  /** Revoke the session the cookie names. */
  signOut(cookie?: string): Promise<HttpResult>;
  /** A `Cookie` header value for a token, for tests that present one directly. */
  cookieFor(token: string): string;
  /** The ephemeral wallet whose signature this server accepts. Never `null`. */
  readonly wallet: EphemeralWallet;
  cleanup(): Promise<void>;
}

export interface SignInOptions {
  /** Reel whose 402 carries the challenge. Defaults to the first in the catalog. */
  readonly reelId?: string;
  /** Applied before signing - see `signChallenge`. */
  readonly overrides?: ChallengeOverrides;
  /** Sign with this key rather than the server's own wallet. */
  readonly signer?: EphemeralWallet;
}

export interface SignInResult {
  readonly response: HttpResult;
  /** Parsed JSON body, whatever the status. */
  readonly body: SignInBody;
  /**
   * The exact `sign-in-with-x` header that was posted.
   *
   * Kept so a test can replay it. Replaying a *spent* header is the whole point of
   * one of these tests, and re-deriving it would mean signing a fresh challenge,
   * which is not a replay at all.
   */
  readonly header: string;
  /** The raw `Set-Cookie` line, or `""` when none was set. */
  readonly setCookie: string;
  /** The token, or `""` when the sign-in was refused. */
  readonly token: string;
  /** `Cookie` header value for the token, or `""`. */
  readonly cookie: string;
}

export interface SignInBody {
  readonly ok: boolean;
  readonly signedIn?: boolean;
  readonly wallet?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly reels?: string[];
  readonly error?: string;
  readonly reason?: string;
  readonly revoked?: boolean;
}

export interface BioscopeTestServerOptions {
  /** Overrides the price. Defaults to `TEST_PRICE`. */
  readonly price?: string;
  /** SIWX challenge lifetime. Set low to make expiry testable. */
  readonly siwxExpirationSeconds?: number;
  /**
   * How long a minted session lives. The config loader refuses anything under 60
   * seconds, so an expiry test needs an injectable clock rather than a short
   * value - see `now`.
   */
  readonly sessionTtlSeconds?: number;
  /**
   * Clock handed to the session store only.
   *
   * Lets a test walk past a session's lifetime in one assignment instead of
   * sleeping for it. It does not reach the purchase ledger or the SIWX challenge
   * validation, both of which use real time, so a test that jumps the clock is
   * only ever testing session expiry.
   */
  readonly now?: () => Date;
  /** Reuse a catalogue, e.g. a single-reel one. Defaults to the three seeded reels. */
  readonly catalog?: ReelCatalog;
  /**
   * An existing SQLite file to open instead of a fresh one.
   *
   * The point of the restart test: a second server, on a different port, sharing
   * one ledger. The port differs on purpose - it means the second server has a
   * different SIWX origin, so a challenge from the first cannot be replayed into
   * it. What has to survive is the *purchase*, not the proof.
   */
  readonly dbPath?: string;
  /** An existing media tree to serve instead of seeding a new one. */
  readonly storageRoot?: string;
  /**
   * Sign SIWX headers with this wallet.
   *
   * Defaults to a fresh `createEphemeralWallet()`, i.e. a real secp256k1 key
   * generated in this process. There is no longer a mode in which the harness
   * supplies a deterministic verifier instead: `createRuntime` has no such option,
   * so the server under test and the production server verify signatures through
   * identical code. Supply a key only when the test needs to *know* which address
   * will be recovered - for instance to assert the ledger is keyed on the address
   * that came out of a signature rather than the one a client claimed.
   */
  readonly siwxSigner?: EphemeralWallet;
}

/** Reserve a port, learn its number, give it straight back. */
async function reserveFreePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

/** The `exact`/`eip3009` payload a well-behaved client would send. */
function exactPayload(requirements: PaymentRequirements, wallet: string): Record<string, unknown> {
  return {
    signature: TEST_SIGNATURE,
    authorization: {
      from: wallet,
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"0".repeat(64)}`,
    },
  };
}

function requirementOf(paymentRequired: PaymentRequired): PaymentRequirements {
  const [first] = paymentRequired.accepts;
  if (first === undefined) {
    throw new Error(
      "The 402 advertised no payment requirements at all. That is a server bug, not a test setup problem.",
    );
  }
  return first;
}

/** The `sign-in-with-x` block a 402 carries, or throw naming what was missing. */
function siwxInfoOf(paymentRequired: PaymentRequired): {
  info: CompleteSIWxInfo;
  chainId: string;
  type: SignatureType;
} {
  const block = paymentRequired.extensions?.[SIGN_IN_WITH_X] as
    | { info?: SIWxExtensionInfo; supportedChains?: Array<{ chainId: string; type: string }> }
    | undefined;
  const info = block?.info;
  const chain = block?.supportedChains?.[0];
  if (info === undefined || chain === undefined) {
    throw new Error(
      `The 402 carried no usable "${SIGN_IN_WITH_X}" extension block. A paid frame that cannot be ` +
        `signed into is a paid frame that has to be paid for again every time.`,
    );
  }
  if (chain.type !== "eip191" && chain.type !== "ed25519") {
    throw new Error(`The 402 advertised an unknown signature type ${JSON.stringify(chain.type)}.`);
  }
  return { info: { ...info, chainId: chain.chainId, type: chain.type }, chainId: chain.chainId, type: chain.type };
}

/**
 * Boot the entire server.
 *
 * @throws whatever `loadConfig` throws, if an option is malformed. Deliberately
 * not caught: a harness that quietly defaulted would hide a real configuration bug.
 */
export async function startBioscopeTestServer(
  options: BioscopeTestServerOptions = {},
): Promise<BioscopeTestServer> {
  const root = options.storageRoot ?? (await mkdtemp(join(tmpdir(), "bioscope-t4-")));
  const ownsRoot = options.storageRoot === undefined;
  const port = await reserveFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const price = options.price ?? TEST_PRICE;
  const catalog = options.catalog ?? createReelCatalog(price);

  const settlements: RecordedPurchaseSummary[] = [];
  // Real key, generated here, used by nothing but this server's SIWX grants. It
  // never leaves the process, is never written anywhere, and is not required to
  // be a particular value by any test.
  const signer = options.siwxSigner ?? createEphemeralWallet();

  const runtime = await createRuntime({
    catalog,
    env: {
      BIOSCOPE_PAYMENT_MODE: "simulated",
      BIOSCOPE_ORIGIN: origin,
      BIOSCOPE_REEL_PRICE_ATOMIC: price,
      BIOSCOPE_DB_PATH: options.dbPath ?? join(root, "purchases.db"),
      BIOSCOPE_STORAGE_DIR: root,
      BIOSCOPE_SIWX_EXPIRATION_SECONDS: String(options.siwxExpirationSeconds ?? 300),
      BIOSCOPE_SESSION_TTL_SECONDS: String(options.sessionTtlSeconds ?? 900),
      PORT: String(port),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    onRecorded: (summary) => {
      settlements.push(summary);
    },
  });

  // Seeded after the runtime exists, into the root it was told to use, so the two
  // cannot disagree about `BIOSCOPE_STORAGE_DIR`. Skipped when reusing a tree,
  // which is by definition already seeded.
  if (ownsRoot) {
    await seedInto(runtime.frames, root, catalog);
  }

  const server: Server = await listen(runtime.app, port);

  const facilitator = runtime.payment.simulatedFacilitator;
  if (facilitator === null) {
    throw new Error(
      "The test server was asked for simulated mode but got a real facilitator. Refusing to run a " +
        "test that might contact a chain.",
    );
  }

  const paidFrameBytes = new Map<string, Buffer>();
  for (const reel of catalog.list()) {
    for (const frame of reel.frames) {
      if (frame.index === 0) {
        continue;
      }
      const payload = await runtime.frames.readPaidFrame(reel.id, frame.index);
      paidFrameBytes.set(`${reel.id}/${frame.index}`, payload.bytes);
    }
  }

  const path = (reelId: string, index: number): string =>
    `/api/reels/${reelId}/frames/${frameFileName(index)}`;

  const requirementFor = async (reelId: string): Promise<PaymentRequired> => {
    const response = await get(origin, path(reelId, 1));
    const header = response.headers.get("payment-required");
    if (response.status !== 402 || header === null) {
      throw new Error(
        `Expected a 402 with a PAYMENT-REQUIRED header for frame 1 of ${reelId}, got ${response.status}.`,
      );
    }
    return decodePaymentRequiredHeader(header);
  };

  const paymentHeader = (paymentRequired: PaymentRequired, wallet = TEST_WALLET): string => {
    const payload: PaymentPayload = {
      x402Version: paymentRequired.x402Version,
      resource: paymentRequired.resource,
      accepted: requirementOf(paymentRequired),
      payload: exactPayload(requirementOf(paymentRequired), wallet),
    };
    return encodePaymentSignatureHeader(payload);
  };

  const unverifiedHeader = (
    paymentRequired: PaymentRequired,
    signature: string,
    address: string = TEST_WALLET,
  ): string => {
    const { info, chainId, type } = siwxInfoOf(paymentRequired);
    const payload: SIWxPayload = {
      ...info,
      address: address as SIWxPayload["address"],
      chainId,
      type,
      signature: signature as SIWxPayload["signature"],
    };
    return encodeSIWxHeader(payload);
  };

  const signChallenge = async (
    paymentRequired: PaymentRequired,
    overrides: ChallengeOverrides = {},
    signingKey: EphemeralWallet | undefined = undefined,
  ): Promise<string> => {
    const key = signingKey ?? signer;
    const { info, chainId, type } = siwxInfoOf(paymentRequired);
    const complete = { ...info, chainId, type };
    // Two paths, and the difference matters. With no overrides this is the SDK's
    // own client helper, origin assertion and all, i.e. exactly what a real wallet
    // runs - so the suite fails if the server ever issues a challenge a wallet
    // would refuse. With overrides it is the raw signer, because the honest helper
    // would (correctly) throw on a challenge bound to another origin or minted by
    // a dead server, and refusing to sign those is the whole point of the attack
    // cases.
    const payload =
      Object.keys(overrides).length === 0
        ? await key.signChallenge(complete)
        : await key.signForgedChallenge({ ...complete, ...overrides });
    return encodeSIWxHeader(payload);
  };

  const cookieFor = (token: string): string => `${SESSION_COOKIE_NAME}=${token}`;

  const signIn = async (signInOptions: SignInOptions = {}): Promise<SignInResult> => {
    const reelId = signInOptions.reelId ?? catalog.list()[0]?.id;
    if (reelId === undefined) {
      throw new Error("Cannot sign in: the catalog is empty, so no challenge can be issued.");
    }
    const requirements = await requirementFor(reelId);
    const header = await signChallenge(requirements, signInOptions.overrides ?? {}, signInOptions.signer);
    const response = await post(origin, SESSION_ROUTE, { headers: { [SIGN_IN_WITH_X]: header } });
    const setCookie = setCookies(response).find((line) => line.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
    const token = new RegExp(`^${SESSION_COOKIE_NAME}=([^;]*)`).exec(setCookie)?.[1] ?? "";
    return {
      response,
      body: JSON.parse(response.text) as SignInBody,
      header,
      setCookie,
      token,
      cookie: token === "" ? "" : cookieFor(token),
    };
  };

  const whoami = (cookie = ""): Promise<HttpResult> =>
    get(origin, SESSION_ROUTE, cookie === "" ? undefined : { headers: { Cookie: cookie } });

  const signOut = (cookie = ""): Promise<HttpResult> =>
    del(origin, SESSION_ROUTE, cookie === "" ? undefined : { headers: { Cookie: cookie } });

  return {
    wallet: signer,
    baseUrl: origin,
    origin,
    root,
    catalog,
    frames: runtime.frames,
    ledger: runtime.ledger,
    sessions: runtime.sessions,
    runtime,
    facilitator,
    siwxStorage: runtime.payment.siwxStorage,
    settlements,
    paidFrameBytes,
    paidFrame: (reelId, index, init) => get(origin, path(reelId, index), init),
    request: (requestPath, init) => get(origin, requestPath, init),
    buyFrame: async (reelId, index, wallet = TEST_WALLET) => {
      const paymentRequired = await requirementFor(reelId);
      const response = await get(origin, path(reelId, index), {
        headers: { "PAYMENT-SIGNATURE": paymentHeader(paymentRequired, wallet) },
      });
      if (response.status !== 200) {
        throw new Error(
          `Paying for frame ${index} of ${reelId} returned ${response.status}, not 200: ${response.text.slice(0, 400)}`,
        );
      }
      return response;
    },
    requirementFor,
    paymentHeader,
    unverifiedHeader,
    signChallenge,
    signIn,
    whoami,
    signOut,
    cookieFor,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await runtime.close();
      // Only a directory this harness created is this harness's to delete. The
      // restart test reuses one on purpose, and `rm -rf` on somebody else's
      // directory is how a test suite eats a developer's work.
      if (ownsRoot) {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

/** Seed the runtime's own store, so tests read files this server actually serves. */
async function seedInto(
  frames: FrameStore,
  root: string,
  catalog: ReelCatalog,
): Promise<void> {
  const { seedFrames } = await import("../../src/media/seed-frames.js");
  await seedFrames({ root, catalog });
  // Prove the store is pointed at the tree just seeded, rather than trusting it.
  if (frames.paidFramesDir.startsWith(root) === false) {
    throw new Error(
      `The runtime's paid store (${frames.paidFramesDir}) is not inside the seeded root (${root}). ` +
        `A test comparing those bytes would be comparing two different trees.`,
    );
  }
}
