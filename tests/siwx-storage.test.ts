import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The authority for the contract this class implements. Importing the real
// type means the assignment below fails to compile if the SDK's shape changes,
// rather than silently drifting from it.
import type { SIWxStorage } from "@x402/extensions/sign-in-with-x";

import { SqlitePurchaseStore } from "../src/db/purchase-store.js";
import { SqliteSIWxStorage } from "../src/db/siwx-storage.js";
import { reelUnlockResource } from "../src/domain/reel-resource.js";
import { createReelCatalog } from "../src/domain/reels.js";

const REEL_A = "calcutta-tram";
const REEL_B = "durga-puja-procession";

const ALICE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BOB = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:11155111";

const catalog = createReelCatalog("1000");

function makeStorage(ledger: SqlitePurchaseStore): SqliteSIWxStorage {
  return new SqliteSIWxStorage({
    ledger,
    catalog,
    asset: ASSET,
    network: NETWORK,
    settlementMode: "simulated",
  });
}

let workDir: string;
let dbPath: string;
let ledger: SqlitePurchaseStore;
let storage: SqliteSIWxStorage;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "bioscope-siwx-"));
  dbPath = join(workDir, "ledger.db");
  ledger = new SqlitePurchaseStore({ databasePath: dbPath });
  storage = makeStorage(ledger);
});

afterEach(() => {
  ledger.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("SqliteSIWxStorage satisfies the SDK contract", () => {
  it("is assignable to the SDK's SIWxStorage interface", () => {
    // Compile-time proof against the installed @x402/extensions. If the SDK
    // changes the contract, this line stops compiling.
    const asSdkContract: SIWxStorage = storage;
    expect(typeof asSdkContract.hasPaid).toBe("function");
    expect(typeof asSdkContract.recordPayment).toBe("function");
    expect(typeof asSdkContract.hasUsedNonce).toBe("function");
    expect(typeof asSdkContract.recordNonce).toBe("function");
  });

  it("is the reason the SDK's in-memory storage is not used", () => {
    // A purchase recorded here has to still be there after the process is gone,
    // because the whole promise is "you never pay twice".
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);

    ledger.close();
    const reopened = new SqlitePurchaseStore({ databasePath: dbPath });
    try {
      const afterRestart: SIWxStorage = makeStorage(reopened);
      expect(afterRestart.hasPaid(reelUnlockResource(REEL_A), ALICE)).toBe(true);
    } finally {
      reopened.close();
    }
    ledger = new SqlitePurchaseStore({ databasePath: dbPath });
  });
});

describe("hasPaid is scoped to one wallet and one reel (rubric checks 6 and 9)", () => {
  it("is false before any payment", () => {
    expect(storage.hasPaid(reelUnlockResource(REEL_A), ALICE)).toBe(false);
    expect(storage.hasPaid(reelUnlockResource(REEL_B), ALICE)).toBe(false);
  });

  it("is true only for the paid pair after recordPayment", () => {
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);

    expect(storage.hasPaid(reelUnlockResource(REEL_A), ALICE)).toBe(true);
    // Same wallet, other reel: still locked.
    expect(storage.hasPaid(reelUnlockResource(REEL_B), ALICE)).toBe(false);
    // Other wallet, same reel: still locked.
    expect(storage.hasPaid(reelUnlockResource(REEL_A), BOB)).toBe(false);
  });

  it("matches the address however it is spelled", () => {
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE.toLowerCase());

    expect(storage.hasPaid(reelUnlockResource(REEL_A), ALICE)).toBe(true);
    expect(storage.hasPaid(reelUnlockResource(REEL_A), ALICE.toUpperCase().replace("0X", "0x"))).toBe(
      true,
    );
  });

  it("never widens to every reel the wallet has paid for", () => {
    // Pay for one reel, then ask about all three.
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);

    const answers = catalog.list().map((reel) => storage.hasPaid(reelUnlockResource(reel.id), ALICE));
    expect(answers).toEqual([true, false, false]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a resource that is not one of ours", () => {
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);

    for (const resource of [
      "/reels/calcutta-tram",
      "/reels/calcutta-tram/frames",
      "/reels//unlock",
      "/reels/calcutta-tram/unlock/../durga-puja-procession/unlock",
      "/reels/calcutta-tram/unlock?reel=durga-puja-procession",
      "/",
      "",
      "reels/calcutta-tram/unlock",
      "/reels/CALCUTTA-TRAM/unlock",
    ]) {
      expect(storage.hasPaid(resource, ALICE), `expected false for ${resource}`).toBe(false);
    }
  });

  it("refuses a reel that is well-formed but not in the catalog", () => {
    // A path that parses cleanly still has to name a reel that exists.
    expect(storage.hasPaid("/reels/some-other-reel/unlock", ALICE)).toBe(false);
  });

  it("refuses an address that is not a 20-byte address", () => {
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);

    // The SDK types `address` as `string`, so these casts are the point: the
    // runtime has to survive whatever arrives over HTTP, not just what the
    // type system promises.
    for (const bad of ["", "0xnope", `0x${"11".repeat(32)}`, "alice", 42, null, undefined] as unknown[]) {
      expect(
        storage.hasPaid(reelUnlockResource(REEL_A), bad as string),
        `expected false for ${String(bad)}`,
      ).toBe(false);
    }
  });
});

describe("recordPayment writes through to the durable ledger", () => {
  it("records a reel-scoped purchase the app's own store can read back", () => {
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);

    const purchase = ledger.findPurchase(ALICE, REEL_A);
    expect(purchase).not.toBeNull();
    expect(purchase).toMatchObject({
      wallet: ALICE.toLowerCase(),
      reelId: REEL_A,
      resource: reelUnlockResource(REEL_A),
      amountAtomic: catalog.require(REEL_A).priceAtomic,
      asset: ASSET,
      network: NETWORK,
      payer: ALICE.toLowerCase(),
      settlementMode: "simulated",
    });
  });

  it("is idempotent for a retried settle hook", () => {
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);
    storage.recordPayment(reelUnlockResource(REEL_A), ALICE);
    expect(ledger.countPurchases()).toBe(1);
  });

  it("refuses to record a payment for a resource it cannot resolve", () => {
    for (const resource of ["", "/", "/reels//unlock", "/reels/calcutta-tram", "nonsense"]) {
      expect(() => storage.recordPayment(resource, ALICE), `expected refusal for ${resource}`).toThrow();
    }
    expect(ledger.countPurchases()).toBe(0);
  });

  it("refuses to record a payment for a reel that is not in the catalog", () => {
    expect(() => storage.recordPayment("/reels/some-other-reel/unlock", ALICE)).toThrow();
    expect(ledger.countPurchases()).toBe(0);
  });

  it("refuses to record a payment from an address that is not an address", () => {
    expect(() => storage.recordPayment(reelUnlockResource(REEL_A), "0xnope")).toThrow();
    expect(ledger.countPurchases()).toBe(0);
  });
});

describe("nonce tracking through the storage contract", () => {
  it("reports a nonce as used once, and never un-used", () => {
    const nonce = "abcdef0123456789abcdef0123456789";

    expect(storage.hasUsedNonce(nonce)).toBe(false);
    storage.recordNonce(nonce);
    expect(storage.hasUsedNonce(nonce)).toBe(true);
    storage.recordNonce(nonce);
    expect(storage.hasUsedNonce(nonce)).toBe(true);
  });

  it("keeps spent nonces spent across a restart", () => {
    const nonce = "abcdef0123456789abcdef0123456789";
    storage.recordNonce(nonce);

    ledger.close();
    const reopened = new SqlitePurchaseStore({ databasePath: dbPath });
    try {
      expect(makeStorage(reopened).hasUsedNonce(nonce)).toBe(true);
    } finally {
      reopened.close();
    }
    ledger = new SqlitePurchaseStore({ databasePath: dbPath });
  });

  it("rejects a malformed nonce instead of storing it", () => {
    for (const bad of ["", "short", "x".repeat(257), "has space here"]) {
      expect(() => storage.recordNonce(bad), `expected rejection of ${JSON.stringify(bad)}`).toThrow();
    }
  });
});
