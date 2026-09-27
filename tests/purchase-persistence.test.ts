/**
 * A payment becomes a purchase, and a purchase survives everything except the
 * database (rubric check 4).
 *
 * ## What check 4 asks
 *
 * "Purchases persist server-side per viewer identity and are restored on revisit
 * without re-payment. Fails if unlocking state lives only in client storage or is
 * lost on server restart."
 *
 * So this file is about one thing: the entitlement outliving the request. Three
 * separate claims, each with a failure mode the other two would hide:
 *
 * 1. **A settlement writes a complete row.** Not a boolean, not a session - a row
 *    with the wallet, the reel, the resource, the amount, the asset, the network,
 *    the payer, the settlement mode and the transaction reference. A row with a
 *    null transaction is not an accounting record.
 * 2. **A second visit does not take a second payment.** This is the actual
 *    requirement, and it is proved by *not paying*: a signed challenge is
 *    presented and the facilitator is asserted never to have been consulted.
 *    Asserting only "the bytes came back" would pass just as well against a
 *    server that quietly charged again.
 * 3. **The row survives a restart.** A second server, a new port, the same
 *    database file.
 *
 * ## Why the restarted server gets a different port on purpose
 *
 * A new port means a new origin, which means a SIWX challenge from the first
 * server is worthless against the second. That is the correct security property,
 * and it is also what makes claim 3 honest: the test cannot satisfy it by carrying
 * a header across, so the only thing that can carry across is the ledger. The test
 * proves both halves - a stale header is refused, and a freshly signed one is
 * accepted with no payment - and the difference between them is the persisted row.
 *
 * ## Cryptography, unlike T4
 *
 * This file used to run against a deterministic signature verifier, so the SIWX
 * half of it proved the *plumbing* and nothing about ECDSA. T5 removed that
 * verifier from the application, so the same requests here are now carried by
 * real signatures from a real throwaway key (`tests/support/test-wallet.ts`).
 * Every SIWX grant in this file is a secp256k1 recovery the server performed
 * itself. `tests/siwx-real-signatures.test.ts` is where the attacks live; this
 * file only needs the honest path to be honest.
 *
 * What is still not tested here: live testnet settlement. Every payment below is
 * settled by the local simulated facilitator, which contacts no chain. See the
 * T5 report and `P3_PLAN.md` for the line between what is verified and what is
 * merely wired.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SIGN_IN_WITH_X } from "@x402/extensions/sign-in-with-x";

import { ETHEREUM_SEPOLIA, ETHEREUM_SEPOLIA_USDC } from "../src/config.js";
import { startBioscopeTestServer, type BioscopeTestServer } from "./support/bioscope-server.js";
import { createEphemeralWallet } from "./support/test-wallet.js";

let server: BioscopeTestServer;

/**
 * The address the server's SIWX verifier will recover from a signature.
 *
 * Payments and sign-ins have to name the *same* address or there is nothing to
 * grant, so this file buys and signs as one wallet throughout.
 */
let buyer: string;

beforeAll(async () => {
  server = await startBioscopeTestServer();
  buyer = server.wallet.address;
});

afterAll(async () => {
  await server.cleanup();
});

/** Pay for a frame as the buying wallet, and hand back the response. */
function buy(reelId: string, index: number): Promise<Awaited<ReturnType<BioscopeTestServer["buyFrame"]>>> {
  return server.buyFrame(reelId, index, buyer);
}

/** A freshly signed challenge, minted by `target` and therefore bound to its origin. */
async function signed(target: BioscopeTestServer, reelId: string): Promise<Record<string, string>> {
  return { [SIGN_IN_WITH_X]: await target.signChallenge(await target.requirementFor(reelId)) };
}

describe("a successful settlement writes a complete row", () => {
  it("records the wallet, the reel, what it cost, and the settlement it came from", async () => {
    const before = server.ledger.countPurchases();
    const response = await buy("calcutta-tram", 4);
    expect(response.status).toBe(200);

    const purchase = server.ledger.findPurchase(buyer, "calcutta-tram");
    expect(purchase, "the purchase was not in the ledger").not.toBeNull();
    expect(server.ledger.countPurchases()).toBe(before + 1);

    // The canonical unlock resource, not the frame URL that was requested. The
    // entitlement is for the reel; remembering the frame would make the row mean
    // something different on every request.
    expect(purchase?.resource).toBe("/reels/calcutta-tram/unlock");
    expect(purchase?.reelId).toBe("calcutta-tram");
    expect(purchase?.amountAtomic).toBe("1000");
    expect(purchase?.asset).toBe(ETHEREUM_SEPOLIA_USDC);
    expect(purchase?.network).toBe(ETHEREUM_SEPOLIA);
    expect(purchase?.settlementMode).toBe("simulated");
    // Normalized, so one wallet cannot end up with two histories. The signing key's
    // address is lowercase from the start; a checksummed spelling of the same
    // address must land in the same row (covered in the SIWX suite).
    expect(purchase?.wallet).toBe(buyer);
    expect(purchase?.payer).toBe(buyer);

    // The transaction the facilitator reported - a real field, not a null standing
    // in for "we did not check".
    const settlement = server.facilitator.settlements.at(-1);
    expect(purchase?.transactionRef).toBe(settlement?.transaction);
    expect(purchase?.transactionRef).toMatch(/^0x[0-9a-f]{128}$/);
  });

  it("tells the recorder exactly one story, once", async () => {
    const reel = "durga-puja-procession";
    const before = server.settlements.length;
    await buy(reel, 2);

    expect(server.settlements.length).toBe(before + 1);
    expect(server.settlements.at(before)).toMatchObject({
      wallet: buyer,
      reelId: reel,
      amountAtomic: "1000",
      asset: ETHEREUM_SEPOLIA_USDC,
      network: ETHEREUM_SEPOLIA,
      outcome: "recorded",
    });
    expect(server.settlements.at(before)?.transactionRef).toMatch(/^0x[0-9a-f]{128}$/);
  });

  it("is idempotent, so paying twice for one reel adds no second row", async () => {
    const reel = "circus-elephant";
    const rowsBefore = server.ledger.countPurchases();

    await buy(reel, 1);
    const rowsAfterFirst = server.ledger.countPurchases();
    expect(rowsAfterFirst).toBe(rowsBefore + 1);
    const firstTransaction = server.ledger.findPurchase(buyer, reel)?.transactionRef;

    // A second, separate payment for a reel already owned. The facilitator settles
    // it again - it has no way to know - so the ledger is what has to hold the
    // line.
    await buy(reel, 2);
    expect(server.ledger.countPurchases()).toBe(rowsAfterFirst);
    expect(server.settlements.at(-1)?.outcome).toBe("already-purchased");

    // And the row still points at the *first* settlement, not the second.
    expect(server.ledger.findPurchase(buyer, reel)?.transactionRef).toBe(firstTransaction);
  });
});

describe("a returning viewer is not charged again", () => {
  it("serves a paid frame on a signed challenge without consulting the facilitator", async () => {
    const reel = "calcutta-tram";
    // Bought by the tests above. A *fresh* challenge: nonces are single-use, so
    // presenting an old one is a replay and is refused by the next test.
    const verifyBefore = server.facilitator.verifyCalls;
    const settleBefore = server.facilitator.settleCalls;
    const rowsBefore = server.ledger.countPurchases();

    const response = await server.paidFrame(reel, 6, { headers: await signed(server, reel) });
    const expected = server.paidFrameBytes.get(`${reel}/6`);

    expect(response.status).toBe(200);
    expect(expected, "the fixture should hold frame 6").toBeDefined();
    expect(response.bytes.equals(expected as Buffer)).toBe(true);
    // The whole point. No verify, no settle, no new row: access was granted by a
    // signature the server verified itself, for a payment already recorded.
    expect(server.facilitator.verifyCalls).toBe(verifyBefore);
    expect(server.facilitator.settleCalls).toBe(settleBefore);
    expect(server.ledger.countPurchases()).toBe(rowsBefore);
  });

  it("carries the settlement mode on a no-charge response too", async () => {
    const response = await server.paidFrame("calcutta-tram", 2, {
      headers: await signed(server, "calcutta-tram"),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-bioscope-settlement-mode")).toBe("simulated");
  });

  it("does not hand the entitlement to a different wallet", async () => {
    // The strongest form of this test, and only reachable now that the double is
    // gone: a *genuine* signature, by a genuine key, over a genuine challenge.
    // Nothing about it is forged except the one thing that matters - the address
    // that signed did not pay. The server verifies the signature, recovers the
    // stranger, finds no row, and refuses.
    const stranger = createEphemeralWallet();
    const header = await server.signChallenge(await server.requirementFor("calcutta-tram"), {}, stranger);

    const response = await server.paidFrame("calcutta-tram", 3, {
      headers: { [SIGN_IN_WITH_X]: header },
    });
    expect(response.status).toBe(402);
    expect(server.ledger.hasPurchased(stranger.address, "calcutta-tram")).toBe(false);
    expect(server.ledger.hasPurchased(buyer, "calcutta-tram"), "the buyer's own row vanished").toBe(true);
  });

  it("does not let a purchased wallet into a reel it did not buy", async () => {
    // A server of its own, so which reels this wallet owns is not decided by what
    // earlier tests happened to buy. Sharing the outer server would make the test
    // an assertion about test order, and it would quietly stop testing anything the
    // day someone reordered the file.
    const fresh = await startBioscopeTestServer();
    try {
      const freshBuyer = fresh.wallet.address;
      await fresh.buyFrame("calcutta-tram", 1, freshBuyer);
      expect(fresh.ledger.hasPurchased(freshBuyer, "calcutta-tram")).toBe(true);
      expect(fresh.ledger.hasPurchased(freshBuyer, "circus-elephant")).toBe(false);

      // The wallet holds a signed, valid, unexpired challenge for this reel. The
      // path resolves to a reel with no row, and the SIWX adapter denies rather
      // than falling back to something close - so the answer is a 402, not a
      // frame.
      const response = await fresh.paidFrame("circus-elephant", 2, {
        headers: await signed(fresh, "circus-elephant"),
      });
      expect(response.status).toBe(402);

      // And the reel it does own, in the same server, is served. Without this the
      // 402 above would be consistent with a wallet whose signature had stopped
      // working for any reason.
      const granted = await fresh.paidFrame("calcutta-tram", 2, {
        headers: await signed(fresh, "calcutta-tram"),
      });
      expect(granted.status).toBe(200);
    } finally {
      await fresh.cleanup();
    }
  });

  it("refuses a replayed challenge, so an intercepted header is worth nothing twice", async () => {
    const header = await server.signChallenge(await server.requirementFor("calcutta-tram"));

    const first = await server.paidFrame("calcutta-tram", 1, { headers: { [SIGN_IN_WITH_X]: header } });
    expect(first.status).toBe(200);

    // Same bytes, second time. The nonce was recorded on the first grant, so this
    // is an attack, not a refresh.
    const replay = await server.paidFrame("calcutta-tram", 5, { headers: { [SIGN_IN_WITH_X]: header } });
    expect(replay.status, "a replayed challenge was accepted").toBe(402);
  });
});

describe("the purchase outlives the process", () => {
  it("is honoured by a new server on a new origin, and no header crosses between them", async () => {
    const root = await mkdtemp(join(tmpdir(), "bioscope-restart-"));
    const dbPath = join(root, "purchases.db");
    const storageRoot = join(root, "frames");
    const price = "1000";

    let first: BioscopeTestServer | null = null;
    let second: BioscopeTestServer | null = null;
    try {
      // One media tree, seeded once and shared by both servers.
      const { seedFrames } = await import("../src/media/seed-frames.js");
      const { createReelCatalog } = await import("../src/domain/reels.js");
      await seedFrames({ root: storageRoot, catalog: createReelCatalog(price) });

      // One key for both servers, and the only reason the second server's verifier
      // accepts the signature it is about to be given. Real, generated, ephemeral.
      const holder = createEphemeralWallet();

      first = await startBioscopeTestServer({ dbPath, storageRoot, price, siwxSigner: holder });
      await first.buyFrame("calcutta-tram", 1, holder.address);
      expect(first.ledger.findPurchase(holder.address, "calcutta-tram")).not.toBeNull();

      // A challenge minted by the first server, to be offered to the second.
      const staleHeader = await first.signChallenge(await first.requirementFor("calcutta-tram"));
      const originBefore = first.origin;

      // Shut the first process down completely: HTTP server closed, SQLite closed.
      await first.cleanup();
      first = null;

      second = await startBioscopeTestServer({ dbPath, storageRoot, price, siwxSigner: holder });
      expect(second.origin, "the restart must land on a different origin").not.toBe(originBefore);
      expect(
        second.ledger.findPurchase(holder.address, "calcutta-tram"),
        "the purchase did not survive the restart",
      ).not.toBeNull();

      // Half one: a challenge bound to the dead origin is refused, even though the
      // purchase is sitting right there in the database. The SDK's origin binding
      // is what does it, and that is why the next assertion is needed to show the
      // refusal was about the origin and not about something incidental.
      const crossed = await second.paidFrame("calcutta-tram", 1, {
        headers: { [SIGN_IN_WITH_X]: staleHeader },
      });
      expect(crossed.status, "a challenge from another origin was accepted").toBe(402);

      // Half two: a challenge signed now, at this origin, for a purchase made by a
      // process that no longer exists. No payment, no settlement, and the bytes
      // are the paid frame's.
      const fresh = await second.signChallenge(await second.requirementFor("calcutta-tram"));
      const settleBefore = second.facilitator.settleCalls;
      const response = await second.paidFrame("calcutta-tram", 1, {
        headers: { [SIGN_IN_WITH_X]: fresh },
      });
      const expected = second.paidFrameBytes.get("calcutta-tram/1");

      expect(response.status).toBe(200);
      expect(expected, "the fixture should hold frame 1").toBeDefined();
      expect(response.bytes.equals(expected as Buffer)).toBe(true);
      expect(second.facilitator.settleCalls, "the restart charged again").toBe(settleBefore);
    } finally {
      await first?.cleanup();
      await second?.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
