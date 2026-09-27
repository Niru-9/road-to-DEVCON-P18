/**
 * The after-settle hook: the one place a successful payment becomes a purchase.
 *
 * ## Why this is a manual hook and not only the SIWX extension
 *
 * Two things record the purchase, deliberately, in this order:
 *
 * 1. **This hook**, registered first. It sees the full settlement - the
 *    transaction hash, the amount actually taken, the asset, the network, the
 *    payer - and writes all of it to the ledger.
 * 2. **The SIWX extension's hook**, which runs afterwards and calls
 *    `storage.recordPayment`. That interface carries no transaction reference, so
 *    it writes a thinner row. `recordPurchase` is idempotent on
 *    `(wallet, reelId)`, so the second write finds this hook's row already there
 *    and changes nothing.
 *
 * The ordering matters and is not an accident: the SDK runs manual `onAfterSettle`
 * hooks before extension hooks, and `recordPurchase` returns the existing row
 * rather than overwriting. So the *richest* row is the one that survives, and the
 * extension's write is a harmless no-op that still proves the SDK's storage
 * contract is genuinely wired up.
 *
 * ## What is trusted here, and what is not
 *
 * This hook runs only after the facilitator has reported a successful settlement,
 * and it reads the amount from `result.amount` when present rather than from the
 * requirements the client was asked for. That is the difference between recording
 * what was *charged* and recording what was *requested*, and for a scheme that
 * supports partial settlement they are not the same number.
 *
 * The reel is resolved from the settlement's own resource URL - never from a
 * request parameter, a header, or anything else the caller controls. A resource
 * that resolves to no reel is refused loudly rather than stored, because a row
 * keyed to a reel that does not exist could never be honoured and would quietly
 * widen the ledger's meaning.
 */

import type { AfterSettleHook, SettleResultContext } from "@x402/core/server";

import type { SettlementMode } from "../domain/entitlement.js";
import { reelIdFromResource, reelUnlockResource } from "../domain/reel-resource.js";
import type { ReelCatalog } from "../domain/reels.js";
import { formatAtomicAmount, parseAtomicAmount } from "../domain/amount.js";
import type { SqlitePurchaseStore } from "../db/purchase-store.js";
import { tryNormalizeWalletAddress } from "../domain/wallet.js";
import { payerFromPaymentPayload } from "./simulated-facilitator.js";

export interface PurchaseRecorderOptions {
  readonly ledger: SqlitePurchaseStore;
  readonly catalog: ReelCatalog;
  readonly settlementMode: SettlementMode;
  /**
   * Observability hook, called once per successful settlement.
   *
   * Used by the test suite to assert the hook ran exactly once and saw what it
   * was supposed to see. Never wired to a logger that could print a wallet
   * address alongside anything else.
   */
  readonly onRecorded?: ((summary: RecordedPurchaseSummary) => void) | undefined;
}

export interface RecordedPurchaseSummary {
  readonly wallet: string;
  readonly reelId: string;
  readonly amountAtomic: string;
  readonly asset: string;
  readonly network: string;
  readonly transactionRef: string | null;
  readonly outcome: "recorded" | "already-purchased";
}

/**
 * Build the `onAfterSettle` hook.
 *
 * @throws {Error} if a successful settlement cannot be attributed to exactly one
 * reel. A settlement the server cannot attribute is a payment it took and cannot
 * account for, so it must not pass silently.
 */
export function createPurchaseRecorder(options: PurchaseRecorderOptions): AfterSettleHook {
  return async (context: SettleResultContext): Promise<void> => {
    // The SDK can invoke after-settle with a failure result; only a success is a
    // purchase. The SIWX hook makes the same check, and making it here too means
    // neither depends on the other's ordering.
    if (!context.result.success) {
      return;
    }

    const resourceUrl = context.paymentPayload.resource?.url;
    const reelId = reelIdFromResource(pathnameOf(resourceUrl));
    if (reelId === null) {
      throw new Error(
        `A settlement succeeded for a resource that names no reel (${String(resourceUrl)}). ` +
          `Refusing to record a purchase that could never be honoured.`,
      );
    }
    if (!options.catalog.has(reelId)) {
      throw new Error(
        `A settlement succeeded for reel ${JSON.stringify(reelId)}, which is not in the catalog. ` +
          `Refusing to record it.`,
      );
    }

    // Prefer what the facilitator reported it took. `exact` settles the full
    // amount, but a scheme that supports partial settlement will not, and the
    // ledger should carry the amount that actually moved.
    const reportedAmount = context.result.amount;
    const amountAtomic = formatAtomicAmount(
      parseAtomicAmount(reportedAmount ?? context.requirements.amount),
    );

    const payer = tryNormalizeWalletAddress(context.result.payer);
    if (payer === null) {
      throw new Error(
        `A settlement for reel ${reelId} reported no usable payer address. Refusing to record it, ` +
          `because an entitlement with no owner is not an entitlement.`,
      );
    }

    const result = options.ledger.recordPurchase({
      wallet: payer,
      reelId,
      resource: reelUnlockResource(reelId),
      amountAtomic,
      asset: context.requirements.asset,
      network: context.requirements.network,
      payer,
      settlementMode: options.settlementMode,
      transactionRef: context.result.transaction === "" ? null : context.result.transaction,
    });

    options.onRecorded?.({
      wallet: payer,
      reelId,
      amountAtomic,
      asset: context.requirements.asset,
      network: context.requirements.network,
      transactionRef: result.purchase.transactionRef,
      outcome: result.outcome,
    });
  };
}

/** The pathname of an absolute resource URL, or the string unchanged. */
function pathnameOf(url: string | undefined): string {
  if (typeof url !== "string" || url === "") {
    return "";
  }
  try {
    return new URL(url).pathname;
  } catch {
    // A relative resource is already a path. `reelIdFromResource` will accept it
    // if it is canonical and reject it if not.
    return url;
  }
}

/** Re-exported so tests can build a payload the same way the facilitator reads one. */
export { payerFromPaymentPayload };
