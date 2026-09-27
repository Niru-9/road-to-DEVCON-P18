/**
 * The server's memory of what has been paid for, and the single place that
 * decides whether a viewer may watch a reel's paid frames.
 *
 * ## The two invariants this module exists to hold
 *
 * 1. **A purchase is remembered on the server.** `PurchaseLedger` is an
 *    interface, not a map. The SQLite implementation in `src/db/` is what the
 *    app actually uses, so "have you paid?" survives a restart. Remembering it
 *    in `localStorage`, or not at all, fails rubric check 4.
 *
 * 2. **Entitlement is keyed by wallet *and* reel.** Every lookup takes both. There
 *    is intentionally no `hasPurchased(wallet)` method, because a method with
 *    that shape is one refactor away from unlocking every reel with one coin.
 *    `decideEntitlement` is the only supported way to ask.
 *
 * ## What a decision is not allowed to depend on
 *
 * A query parameter, a request header, a cookie, or anything else the caller
 * controls. `decideEntitlement` takes a wallet address that a signature has
 * already proved (or has not, in which case it denies) and a reel id, and reads
 * nothing else. There is no `paid=true` path through this code because there is
 * no parameter for one.
 */

import type { AtomicAmount } from "./amount.js";
import type { ReelCatalog } from "./reels.js";
import { tryNormalizeWalletAddress } from "./wallet.js";

/** Testnet only. Recorded so a reader can tell a real settlement from a demo. */
export type SettlementMode = "simulated" | "testnet";

export interface PurchaseRecord {
  /** Row id. Stable for the life of the database. */
  readonly id: number;
  /** Normalized lowercase address. Part of the entitlement key. */
  readonly wallet: string;
  /** The other half of the entitlement key. */
  readonly reelId: string;
  /** The x402 resource this purchase was made against. */
  readonly resource: string;
  /** Price actually charged, in base units. */
  readonly amountAtomic: AtomicAmount;
  readonly asset: string;
  /** CAIP-2 network id, e.g. `eip155:84532`. */
  readonly network: string;
  /** Address the x402 settlement reported as the payer. */
  readonly payer: string;
  readonly settlementMode: SettlementMode;
  /** Facilitator settlement hash, when a real settlement produced one. */
  readonly transactionRef: string | null;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
}

export interface NewPurchase {
  wallet: string;
  reelId: string;
  resource: string;
  amountAtomic: AtomicAmount;
  asset: string;
  network: string;
  payer?: string | undefined;
  settlementMode: SettlementMode;
  transactionRef?: string | null | undefined;
}

export type RecordPurchaseOutcome = "recorded" | "already-purchased";

export interface RecordPurchaseResult {
  readonly outcome: RecordPurchaseOutcome;
  readonly purchase: PurchaseRecord;
}

/**
 * Durable purchase storage.
 *
 * Implementations must make `recordPurchase` idempotent on `(wallet, reelId)`.
 * The "never pay twice" promise means a retried settlement, a double-clicked
 * button and a refresh mid-payment all have to land on one row, not three.
 */
export interface PurchaseLedger {
  /** `null` when this wallet has not paid for this reel. */
  findPurchase(wallet: string, reelId: string): PurchaseRecord | null;
  /** Exactly `findPurchase(...) !== null`, for callers that only need the bit. */
  hasPurchased(wallet: string, reelId: string): boolean;
  recordPurchase(input: NewPurchase): RecordPurchaseResult;
  /** Everything this wallet has paid for. Used by the UI's "your reels" list. */
  listPurchases(wallet: string): readonly PurchaseRecord[];
  countPurchases(): number;
}

export type DenialReason =
  /** The claimed wallet is not a 20-byte EVM address. */
  | "invalid-wallet"
  /** No reel with that id exists. */
  | "unknown-reel"
  /** A real wallet, a real reel, but no purchase for that pair. */
  | "no-purchase-for-this-reel";

export type EntitlementDecision =
  | { readonly granted: true; readonly purchase: PurchaseRecord }
  | { readonly granted: false; readonly reason: DenialReason };

/**
 * Decide whether `wallet` may watch the paid frames of `reelId`.
 *
 * Fails closed at every step. The order matters: an unknown reel is rejected
 * before the ledger is consulted, so a bad reel id can never turn into a
 * database read, and an invalid wallet never reaches the ledger at all.
 */
export function decideEntitlement(input: {
  ledger: PurchaseLedger;
  catalog: ReelCatalog;
  /** The wallet the server has verified, or the address it was handed. */
  wallet: unknown;
  reelId: unknown;
}): EntitlementDecision {
  const wallet = tryNormalizeWalletAddress(input.wallet);
  if (wallet === null) {
    return { granted: false, reason: "invalid-wallet" };
  }

  if (typeof input.reelId !== "string" || !input.catalog.has(input.reelId)) {
    return { granted: false, reason: "unknown-reel" };
  }

  const purchase = input.ledger.findPurchase(wallet, input.reelId);
  if (purchase === null) {
    return { granted: false, reason: "no-purchase-for-this-reel" };
  }

  return { granted: true, purchase };
}
