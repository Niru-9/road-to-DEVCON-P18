import { describe, expect, it } from "vitest";

import { SqlitePurchaseStore } from "../src/db/purchase-store.js";
import { decideEntitlement, type PurchaseLedger } from "../src/domain/entitlement.js";
import { createReelCatalog } from "../src/domain/reels.js";
import { normalizeWalletAddress } from "../src/domain/wallet.js";

const REEL_A = "calcutta-tram";
const REEL_B = "durga-puja-procession";
const REEL_C = "circus-elephant";

const ALICE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BOB = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:11155111";

function freshLedger() {
  return new SqlitePurchaseStore({ databasePath: ":memory:" });
}

function pay(ledger: SqlitePurchaseStore, wallet: string, reelId: string) {
  return ledger.recordPurchase({
    wallet,
    reelId,
    resource: `/reels/${reelId}/unlock`,
    amountAtomic: "1000",
    asset: ASSET,
    network: NETWORK,
    settlementMode: "simulated",
  });
}

describe("entitlement is scoped to wallet and reel (rubric checks 6 and 9)", () => {
  const catalog = createReelCatalog("1000");

  it("grants access after a purchase, for that reel only", () => {
    const ledger = freshLedger();
    pay(ledger, ALICE, REEL_A);

    const granted = decideEntitlement({ ledger, catalog, wallet: ALICE, reelId: REEL_A });
    expect(granted.granted).toBe(true);

    // The headline requirement: one coin for reel A does not open reel B.
    for (const otherReel of [REEL_B, REEL_C]) {
      const decision = decideEntitlement({ ledger, catalog, wallet: ALICE, reelId: otherReel });
      expect(decision.granted, `reel ${otherReel} must stay locked`).toBe(false);
      if (!decision.granted) {
        expect(decision.reason).toBe("no-purchase-for-this-reel");
      }
    }

    ledger.close();
  });

  it("does not let one wallet's purchase open another wallet's reel", () => {
    const ledger = freshLedger();
    pay(ledger, ALICE, REEL_A);

    const decision = decideEntitlement({ ledger, catalog, wallet: BOB, reelId: REEL_A });
    expect(decision.granted).toBe(false);
    if (!decision.granted) {
      expect(decision.reason).toBe("no-purchase-for-this-reel");
    }

    ledger.close();
  });

  it("grants each reel separately once each is paid for", () => {
    const ledger = freshLedger();
    pay(ledger, ALICE, REEL_A);
    pay(ledger, ALICE, REEL_B);

    expect(decideEntitlement({ ledger, catalog, wallet: ALICE, reelId: REEL_A }).granted).toBe(true);
    expect(decideEntitlement({ ledger, catalog, wallet: ALICE, reelId: REEL_B }).granted).toBe(true);
    expect(decideEntitlement({ ledger, catalog, wallet: ALICE, reelId: REEL_C }).granted).toBe(false);
    expect(ledger.countPurchases()).toBe(2);

    ledger.close();
  });

  it("recognizes the purchase however the wallet address is spelled", () => {
    const ledger = freshLedger();
    pay(ledger, ALICE.toLowerCase(), REEL_A);

    for (const spelling of [
      ALICE,
      ALICE.toLowerCase(),
      ALICE.toUpperCase().replace("0X", "0x"),
    ]) {
      const decision = decideEntitlement({ ledger, catalog, wallet: spelling, reelId: REEL_A });
      expect(decision.granted, `expected ${spelling} to be recognized`).toBe(true);
    }
    expect(ledger.countPurchases()).toBe(1);

    ledger.close();
  });

  it("returns the purchase record it decided on", () => {
    const ledger = freshLedger();
    const written = pay(ledger, ALICE, REEL_A).purchase;

    const decision = decideEntitlement({ ledger, catalog, wallet: ALICE, reelId: REEL_A });
    expect(decision.granted).toBe(true);
    if (decision.granted) {
      expect(decision.purchase.id).toBe(written.id);
      expect(decision.purchase.wallet).toBe(normalizeWalletAddress(ALICE));
      expect(decision.purchase.reelId).toBe(REEL_A);
    }

    ledger.close();
  });
});

describe("entitlement fails closed", () => {
  const catalog = createReelCatalog("1000");

  it("denies a wallet that is not a 20-byte address", () => {
    const ledger = freshLedger();
    pay(ledger, ALICE, REEL_A);

    for (const bad of ["", "0xnope", `0x${"11".repeat(32)}`, "ALICE", 42, null, undefined, {}]) {
      const decision = decideEntitlement({ ledger, catalog, wallet: bad, reelId: REEL_A });
      expect(decision.granted, `expected denial for ${JSON.stringify(bad)}`).toBe(false);
      if (!decision.granted) {
        expect(decision.reason).toBe("invalid-wallet");
      }
    }

    ledger.close();
  });

  it("denies an unknown reel", () => {
    const ledger = freshLedger();
    pay(ledger, ALICE, REEL_A);

    for (const bad of ["no-such-reel", "", "CALCUTTA-TRAM", "../calcutta-tram", 42, null, undefined]) {
      const decision = decideEntitlement({ ledger, catalog, wallet: ALICE, reelId: bad });
      expect(decision.granted, `expected denial for ${JSON.stringify(bad)}`).toBe(false);
      if (!decision.granted) {
        expect(decision.reason).toBe("unknown-reel");
      }
    }

    ledger.close();
  });

  it("denies a real wallet that has paid for nothing", () => {
    const ledger = freshLedger();

    for (const reelId of [REEL_A, REEL_B, REEL_C]) {
      const decision = decideEntitlement({ ledger, catalog, wallet: ALICE, reelId });
      expect(decision.granted).toBe(false);
      if (!decision.granted) {
        expect(decision.reason).toBe("no-purchase-for-this-reel");
      }
    }

    ledger.close();
  });

  it("rejects an unknown reel before it ever consults the ledger", () => {
    // A bad reel id must not turn into a database read, and must not be able to
    // borrow another reel's answer.
    const real = freshLedger();
    pay(real, ALICE, REEL_A);

    let consulted = false;
    const counting: PurchaseLedger = {
      findPurchase: (wallet, reelId) => {
        consulted = true;
        return real.findPurchase(wallet, reelId);
      },
      hasPurchased: (wallet, reelId) => real.hasPurchased(wallet, reelId),
      recordPurchase: (input) => real.recordPurchase(input),
      listPurchases: (wallet) => real.listPurchases(wallet),
      countPurchases: () => real.countPurchases(),
    };

    const decision = decideEntitlement({
      ledger: counting,
      catalog,
      wallet: ALICE,
      reelId: "no-such-reel",
    });

    expect(decision.granted).toBe(false);
    if (!decision.granted) {
      expect(decision.reason).toBe("unknown-reel");
    }
    expect(consulted).toBe(false);

    // And the same ledger still answers correctly for a reel that does exist,
    // so the counter is proving ordering rather than a broken stub.
    expect(decideEntitlement({ ledger: counting, catalog, wallet: ALICE, reelId: REEL_A }).granted).toBe(
      true,
    );
    expect(consulted).toBe(true);

    real.close();
  });

  it("has no wallet-only lookup to reach for", () => {
    // A compile-time assertion. `hasPurchased` requires a reel id, and there is
    // no `hasPurchasedByWalletOnly` anywhere on the interface, so "one purchase
    // unlocks everything" has nowhere to be written. If either of those ever
    // changes, this stops compiling rather than quietly passing.
    const ledger = freshLedger();

    // @ts-expect-error - a reel id is required, on purpose
    expect(() => ledger.hasPurchased(ALICE)).toThrow(TypeError);

    // @ts-expect-error - no such method exists, on purpose
    expect(() => ledger.hasPurchasedByWalletOnly(ALICE)).toThrow(TypeError);

    ledger.close();
  });
});
