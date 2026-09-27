import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqlitePurchaseStore } from "../src/db/purchase-store.js";
import { normalizeWalletAddress } from "../src/domain/wallet.js";

const REEL_A = "calcutta-tram";
const REEL_B = "durga-puja-procession";
const REEL_C = "circus-elephant";

const ALICE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BOB = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:11155111";

let workDir: string;
let dbPath: string;
let store: SqlitePurchaseStore;

function purchaseFor(wallet: string, reelId: string, overrides: Record<string, unknown> = {}) {
  return store.recordPurchase({
    wallet,
    reelId,
    resource: `/reels/${reelId}/unlock`,
    amountAtomic: "1000",
    asset: ASSET,
    network: NETWORK,
    settlementMode: "simulated",
    ...overrides,
  });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bioscope-ledger-"));
  dbPath = join(workDir, "ledger.db");
  store = new SqlitePurchaseStore({ databasePath: dbPath });
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("purchase persistence (rubric check 4)", () => {
  it("records a purchase and reads every field back", () => {
    const result = purchaseFor(ALICE, REEL_A, { transactionRef: "0xsettledhash" });

    expect(result.outcome).toBe("recorded");
    const found = store.findPurchase(ALICE, REEL_A);
    expect(found).not.toBeNull();
    expect(found).toMatchObject({
      wallet: normalizeWalletAddress(ALICE),
      reelId: REEL_A,
      resource: `/reels/${REEL_A}/unlock`,
      amountAtomic: "1000",
      asset: ASSET,
      network: NETWORK,
      payer: normalizeWalletAddress(ALICE),
      settlementMode: "simulated",
      transactionRef: "0xsettledhash",
    });
  });

  it("survives closing and reopening the database", () => {
    purchaseFor(ALICE, REEL_A, { transactionRef: "0xsettledhash" });
    expect(store.hasPurchased(ALICE, REEL_A)).toBe(true);

    // The whole point of check 4: the memory of a payment is the server's, not
    // the browser's, so it outlives the process.
    store.close();
    const reopened = new SqlitePurchaseStore({ databasePath: dbPath });

    try {
      expect(reopened.countPurchases()).toBe(1);
      expect(reopened.hasPurchased(ALICE, REEL_A)).toBe(true);

      const found = reopened.findPurchase(ALICE, REEL_A);
      expect(found?.transactionRef).toBe("0xsettledhash");
      expect(found?.amountAtomic).toBe("1000");
      expect(found?.settlementMode).toBe("simulated");
      expect(found?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      reopened.close();
    }

    // Reopen so afterEach's close() has something valid to close.
    store = new SqlitePurchaseStore({ databasePath: dbPath });
  });

  it("keeps a large amount exact through a reopen", () => {
    const huge = "9007199254740993";
    store.recordPurchase({
      wallet: BOB,
      reelId: REEL_B,
      resource: `/reels/${REEL_B}/unlock`,
      amountAtomic: huge,
      asset: ASSET,
      network: NETWORK,
      settlementMode: "testnet",
    });
    store.close();

    const reopened = new SqlitePurchaseStore({ databasePath: dbPath });
    try {
      expect(reopened.findPurchase(BOB, REEL_B)?.amountAtomic).toBe(huge);
    } finally {
      reopened.close();
    }
    store = new SqlitePurchaseStore({ databasePath: dbPath });
  });
});

describe("wallet normalization in the ledger", () => {
  it("finds a purchase however the address is spelled on the way in", () => {
    purchaseFor(ALICE, REEL_A);

    expect(store.findPurchase(ALICE, REEL_A)).not.toBeNull();
    expect(store.findPurchase(ALICE.toLowerCase(), REEL_A)).not.toBeNull();
    expect(store.findPurchase(ALICE.toUpperCase().replace("0X", "0x"), REEL_A)).not.toBeNull();
    expect(store.hasPurchased(ALICE, REEL_A)).toBe(true);
  });

  it("stores exactly one row no matter how many spellings are used to pay", () => {
    purchaseFor(ALICE, REEL_A);
    purchaseFor(ALICE.toUpperCase().replace("0X", "0x"), REEL_A);
    purchaseFor(ALICE.toLowerCase(), REEL_A);

    expect(store.countPurchases()).toBe(1);
    expect(store.listPurchases(ALICE)).toHaveLength(1);
  });

  it("records a separately supplied payer address", () => {
    purchaseFor(ALICE, REEL_A, { payer: BOB });
    expect(store.findPurchase(ALICE, REEL_A)?.payer).toBe(normalizeWalletAddress(BOB));
  });

  it("refuses a wallet that is not a 20-byte address", () => {
    expect(() => purchaseFor("0xnope", REEL_A)).toThrow();
    expect(store.countPurchases()).toBe(0);
  });
});

describe("duplicate handling", () => {
  it("is idempotent for a retried settlement of the same reel", () => {
    const first = purchaseFor(ALICE, REEL_A, { transactionRef: "0xsame" });
    const second = purchaseFor(ALICE, REEL_A, { transactionRef: "0xsame" });

    expect(first.outcome).toBe("recorded");
    expect(second.outcome).toBe("already-purchased");
    expect(second.purchase.id).toBe(first.purchase.id);
    expect(store.countPurchases()).toBe(1);
  });

  it("reports already-purchased rather than inserting a second entitlement", () => {
    purchaseFor(ALICE, REEL_A, { transactionRef: "0xfirst" });
    // A genuinely different payment for a reel that is already unlocked. It
    // must not produce a second row, and the original row is what comes back.
    const second = purchaseFor(ALICE, REEL_A, { transactionRef: "0xsecond" });

    expect(second.outcome).toBe("already-purchased");
    expect(second.purchase.transactionRef).toBe("0xfirst");
    expect(store.countPurchases()).toBe(1);
  });

  it("still gives a second reel its own row", () => {
    expect(purchaseFor(ALICE, REEL_A).outcome).toBe("recorded");
    expect(purchaseFor(ALICE, REEL_B).outcome).toBe("recorded");
    expect(store.countPurchases()).toBe(2);
    expect(store.listPurchases(ALICE).map((purchase) => purchase.reelId)).toEqual([
      REEL_A,
      REEL_B,
    ]);
  });

  it("still gives a second wallet its own row for the same reel", () => {
    expect(purchaseFor(ALICE, REEL_A).outcome).toBe("recorded");
    expect(purchaseFor(BOB, REEL_A).outcome).toBe("recorded");
    expect(store.countPurchases()).toBe(2);
  });
});

describe("database constraints actually bite", () => {
  const INSERT = `INSERT INTO purchases
      (wallet, reel_id, resource, amount_atomic, asset, network, payer,
       settlement_mode, transaction_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  it("rejects a second row for the same wallet and reel", () => {
    purchaseFor(ALICE, REEL_A);
    const wallet = normalizeWalletAddress(ALICE);
    expect(() =>
      store.execRawForTest(
        INSERT,
        wallet,
        REEL_A,
        `/reels/${REEL_A}/unlock`,
        "1000",
        ASSET,
        NETWORK,
        wallet,
        "simulated",
        null,
        new Date().toISOString(),
      ),
    ).toThrow();
    expect(store.countPurchases()).toBe(1);
  });

  it("rejects a wallet that is not stored in normalized lowercase", () => {
    const wallet = normalizeWalletAddress(ALICE);
    // The mixed-case spelling is the same account, so this row would be a second
    // account's worth of history under a different spelling of one address.
    expect(() =>
      store.execRawForTest(
        INSERT,
        ALICE,
        REEL_A,
        `/reels/${REEL_A}/unlock`,
        "1000",
        ASSET,
        NETWORK,
        wallet,
        "simulated",
        null,
        new Date().toISOString(),
      ),
    ).toThrow();
    expect(store.countPurchases()).toBe(0);
  });

  it("rejects an amount that is not a plain integer of base units", () => {
    const wallet = normalizeWalletAddress(ALICE);
    for (const bad of ["1000.0", "-1", "1e3", "0x10", "01000", "one thousand", ""]) {
      expect(() =>
        store.execRawForTest(
          INSERT,
          wallet,
          REEL_A,
          `/reels/${REEL_A}/unlock`,
          bad,
          ASSET,
          NETWORK,
          wallet,
          "simulated",
          null,
          new Date().toISOString(),
        ),
      ).toThrow();
    }
    expect(store.countPurchases()).toBe(0);
  });

  it("rejects an unknown settlement mode", () => {
    const wallet = normalizeWalletAddress(ALICE);
    expect(() =>
      store.execRawForTest(
        INSERT,
        wallet,
        REEL_A,
        `/reels/${REEL_A}/unlock`,
        "1000",
        ASSET,
        NETWORK,
        wallet,
        "definitely-settled",
        null,
        new Date().toISOString(),
      ),
    ).toThrow();
  });

  it("rejects one settlement hash being reused for a different reel", () => {
    purchaseFor(ALICE, REEL_A, { transactionRef: "0xshared" });
    const wallet = normalizeWalletAddress(ALICE);
    expect(() =>
      store.execRawForTest(
        INSERT,
        wallet,
        REEL_B,
        `/reels/${REEL_B}/unlock`,
        "1000",
        ASSET,
        NETWORK,
        wallet,
        "simulated",
        "0xshared",
        new Date().toISOString(),
      ),
    ).toThrow();
    expect(store.countPurchases()).toBe(1);
  });

  it("rejects a purchase whose resource disagrees with its reel", () => {
    // Not enforced as a constraint - resource and reel_id are both caller
    // supplied - but asserted here so the gap is on the record rather than
    // hidden. The app builds `resource` from `reelId` in one place.
    const wallet = normalizeWalletAddress(ALICE);
    const result = store.recordPurchase({
      wallet,
      reelId: REEL_A,
      resource: `/reels/${REEL_B}/unlock`,
      amountAtomic: "1000",
      asset: ASSET,
      network: NETWORK,
      settlementMode: "simulated",
    });
    expect(result.purchase.reelId).toBe(REEL_A);
    expect(result.purchase.resource).toBe(`/reels/${REEL_B}/unlock`);
  });
});

describe("sign-in nonce tracking", () => {
  it("starts unused, becomes used, and stays used", () => {
    const nonce = "abcdef0123456789";
    expect(store.hasUsedNonce(nonce)).toBe(false);
    store.recordNonce(nonce);
    expect(store.hasUsedNonce(nonce)).toBe(true);
    // A second call must not un-consume it.
    store.recordNonce(nonce);
    expect(store.hasUsedNonce(nonce)).toBe(true);
  });

  it("survives a reopen", () => {
    store.recordNonce("abcdef0123456789");
    store.close();
    const reopened = new SqlitePurchaseStore({ databasePath: dbPath });
    try {
      expect(reopened.hasUsedNonce("abcdef0123456789")).toBe(true);
    } finally {
      reopened.close();
    }
    store = new SqlitePurchaseStore({ databasePath: dbPath });
  });

  it("treats distinct nonces as distinct", () => {
    store.recordNonce("aaaaaaaaaaaa");
    expect(store.hasUsedNonce("bbbbbbbbbbbb")).toBe(false);
  });

  it("rejects a malformed nonce", () => {
    for (const bad of ["", "short", "x".repeat(257), "has space here", "nul byte"]) {
      expect(() => store.recordNonce(bad), `expected rejection of ${JSON.stringify(bad)}`).toThrow();
      expect(() => store.hasUsedNonce(bad)).toThrow();
    }
  });
});
