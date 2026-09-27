/**
 * Sign-In-With-X, wired to the durable ledger.
 *
 * ## What the SDK hands us, and why it needs help
 *
 * `createSIWxResourceServerExtension` is the SDK's own implementation of the
 * SIWX server surface: it publishes a challenge on the 402, records a payment
 * when one settles, and validates a signed challenge on later requests. It talks
 * to us through one small interface, `SIWxStorage`, and in T2 that interface is
 * already implemented by `SqliteSIWxStorage` on top of SQLite.
 *
 * The problem is *which string* the SDK passes. The two hooks disagree, and
 * neither string is the one T2 wrote for:
 *
 * - The settle hook passes `new URL(resource.url).pathname`, i.e.
 *   `/reels/<id>/unlock` - the reel's unlock resource. That is exactly what
 *   `SqliteSIWxStorage` understands.
 * - The request hook passes `context.path`, i.e. the *request* path, which for a
 *   paid frame is `/api/reels/<id>/frames/12.svg`. `reelIdFromResource` does not
 *   recognise that, so T2's storage would answer `false` for a viewer who has
 *   definitely paid.
 *
 * So this module is the small adapter that makes the two agree. It resolves a
 * request path to the reel it belongs to and then delegates to T2's storage with
 * the canonical unlock resource. The ledger lookup itself stays in one place; the
 * path knowledge lives here, next to the routes that define those paths.
 *
 * ## What this buys, concretely
 *
 * A returning viewer, holding a valid signed challenge, gets access to a paid
 * frame **without paying again**. That is the difference between a demo that
 * "remembers" a purchase in a JavaScript variable and one that remembers it on
 * the server: the unlock outlives the tab, the browser, and the process.
 *
 * ## Fails closed, every time
 *
 * A path that resolves to no reel is passed through untouched, and T2's storage
 * denies it. There is no branch anywhere here that returns `true` without a
 * matching `(wallet, reel)` row in SQLite.
 *
 * ## There is no way to swap the signature verifier
 *
 * T4 built this with an option, `evmVerifier`, that tests could set to hand the
 * SDK a deterministic stand-in for ECDSA recovery. T5 deleted it, and the
 * deletion is the point of T5.
 *
 * `createSIWxResourceServerExtension` verifies through viem's `verifyMessage`
 * unless it is given a `verifyOptions.evmVerifier`, which this module no longer
 * passes and no longer accepts. So the only signature check that can run in this
 * process is a real secp256k1 recovery over a real EIP-4361 message. A test
 * cannot substitute a predicate, and a future caller cannot either - the seam
 * that made that possible is gone from the type signature, not merely defaulted
 * away. `tests/siwx-no-double.test.ts` scans `src/` and fails if the option ever
 * comes back.
 *
 * The cost of this is honest and small: tests that need an SIWX grant now need a
 * real key, so the harness generates an ephemeral one per server
 * (`tests/support/test-wallet.ts`). The benefit is that "the signature was
 * verified" stops being a claim about intent and becomes a statement about what
 * the code can do.
 */

import { createSIWxResourceServerExtension, type SIWxStorage } from "@x402/extensions/sign-in-with-x";

import { reelIdFromResource, reelUnlockResource } from "../domain/reel-resource.js";
import type { BioscopeConfig } from "../config.js";
import type { SqlitePurchaseStore } from "../db/purchase-store.js";
import { SqliteSIWxStorage } from "../db/siwx-storage.js";
import type { ReelCatalog } from "../domain/reels.js";
import { PAID_FRAME_FRAMES_SEGMENT, PAID_FRAME_PREFIX } from "./routes.js";

/** `GET /api/reels/<id>/frames/<file>` with exactly one id segment and one file segment. */
const PAID_FRAME_PATH_PATTERN = new RegExp(
  `^${escapeForRegExp(PAID_FRAME_PREFIX)}([^/]+)${escapeForRegExp(PAID_FRAME_FRAMES_SEGMENT)}[^/]+$`,
);

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The reel a SIWX access path belongs to.
 *
 * Accepts either shape the SDK can hand us - a reel unlock resource
 * (`/reels/<id>/unlock`) or a paid frame request path
 * (`/api/reels/<id>/frames/<file>`).
 *
 * @returns the reel id, or `null` when the path names no reel. Callers must deny
 * on `null`; there is no "close enough" fallback that widens the grant.
 */
export function reelIdFromAccessPath(path: unknown): string | null {
  if (typeof path !== "string") {
    return null;
  }
  // The unlock resource is already canonical, and the domain module is the
  // authority on its shape, so it is asked first rather than re-implemented here.
  const asResource = reelIdFromResource(path);
  if (asResource !== null) {
    return asResource;
  }
  return PAID_FRAME_PATH_PATTERN.exec(path)?.[1] ?? null;
}

/**
 * Path-aware `SIWxStorage`.
 *
 * Wraps T2's `SqliteSIWxStorage` rather than replacing it, so the durable
 * ledger, the wallet normalization and the `(wallet, reel)` idempotency all stay
 * in the one class that was written and tested for them.
 */
export class BioscopeSIWxStorage implements SIWxStorage {
  readonly #inner: SqliteSIWxStorage;

  public constructor(inner: SqliteSIWxStorage) {
    this.#inner = inner;
  }

  /**
   * Has this address paid for the reel this path belongs to?
   *
   * A path that resolves to no reel answers `false` without touching the ledger.
   */
  public hasPaid(resource: string, address: string): boolean {
    const reelId = reelIdFromAccessPath(resource);
    if (reelId === null) {
      return false;
    }
    return this.#inner.hasPaid(reelUnlockResource(reelId), address);
  }

  /**
   * Record that this address paid for the reel this path belongs to.
   *
   * Normalized to the canonical unlock resource before delegating, so the settle
   * hook and this method cannot produce two different `resource` strings for the
   * same purchase.
   *
   * @throws when the path names no reel, rather than storing an entitlement that
   * could not be honoured on a later request.
   */
  public recordPayment(resource: string, address: string): void {
    const reelId = reelIdFromAccessPath(resource);
    if (reelId === null) {
      throw new Error(`Refusing to record a payment for an unrecognized resource: ${resource}`);
    }
    this.#inner.recordPayment(reelUnlockResource(reelId), address);
  }

  public hasUsedNonce(nonce: string): boolean {
    return this.#inner.hasUsedNonce(nonce);
  }

  public recordNonce(nonce: string): void {
    this.#inner.recordNonce(nonce);
  }
}

export interface BioscopeSIWxOptions {
  readonly config: BioscopeConfig;
  readonly catalog: ReelCatalog;
  readonly ledger: SqlitePurchaseStore;
}

export interface BioscopeSIWx {
  /** Register with `x402ResourceServer.registerExtension`. */
  readonly extension: ReturnType<typeof createSIWxResourceServerExtension>;
  /** T2's SQLite-backed storage, for assertions. */
  readonly storage: SqliteSIWxStorage;
  /** The path-aware wrapper actually handed to the SDK. */
  readonly adapter: BioscopeSIWxStorage;
}

/**
 * Build the SIWX extension and its storage.
 *
 * The origin is the *browser-visible* origin from configuration, not the
 * listener address. Behind a proxy those differ, and the SDK binds the challenge
 * domain and `uri` to whatever it is given, so getting this wrong produces
 * challenges no browser can satisfy.
 */
export function createBioscopeSIWx(options: BioscopeSIWxOptions): BioscopeSIWx {
  const storage = new SqliteSIWxStorage({
    ledger: options.ledger,
    catalog: options.catalog,
    asset: options.config.asset,
    network: options.config.network,
    settlementMode: options.config.paymentMode,
  });

  const adapter = new BioscopeSIWxStorage(storage);

  const extension = createSIWxResourceServerExtension({
    storage: adapter,
    origin: options.config.origin,
  });

  return { extension, storage, adapter };
}
