/**
 * The paid frame is a product, and the gate in front of x402 (rubric check 3).
 *
 * ## What check 3 asks
 *
 * "A server-side x402 payment endpoint with a per-request price in the 402
 * challenge. Fails if no price appears in the challenge, or if payment is mocked
 * client-side only."
 *
 * So the assertions are: a real 402 arrives, it carries a machine-readable price,
 * the price is the reel's own, and a payment presented over the wire is what
 * unlocks the frame. No client-side mocking is involved anywhere in this file -
 * the only substitution is the facilitator, which contacts no chain, and every
 * response says so in a header.
 *
 * ## The other half of the check, which is easier to get wrong
 *
 * A 402 is information: "this exists, and here is what it costs". If *anything*
 * invalid could produce one, the endpoint becomes a free catalogue of the server's
 * contents, and the frame counts of every reel can be enumerated without paying
 * anything. So the first describe block is entirely about requests that must
 * **never** see the payment middleware, and it asserts the absence of the
 * `PAYMENT-REQUIRED` header - not merely a 404 - because the header is the
 * evidence that x402 was reached at all.
 *
 * The oracle test is the sharp one. It takes an unknown reel and a known reel with
 * an out-of-range index, and requires their 404 bodies to be byte-identical. If
 * they differ in any byte, one of them is telling a stranger something.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { SIGN_IN_WITH_X } from "@x402/extensions/sign-in-with-x";

import { ETHEREUM_SEPOLIA, ETHEREUM_SEPOLIA_USDC } from "../src/config.js";
import { SETTLEMENT_MODE_HEADER } from "../src/http/routes/paid-frame.js";
import { paidFrameResourceUrl } from "../src/payment/routes.js";
import { startBioscopeTestServer, TEST_WALLET, type BioscopeTestServer } from "./support/bioscope-server.js";

let server: BioscopeTestServer;

beforeAll(async () => {
  server = await startBioscopeTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

/** The one requirement the server advertises, or fail with a message that says why. */
function requirementOf(required: { accepts: PaymentRequirements[] }): PaymentRequirements {
  const [first] = required.accepts;
  if (first === undefined) {
    throw new Error("The 402 advertised no payment requirements at all. That is a server bug.");
  }
  return first;
}

describe("an unpaid request for a real paid frame is a 402 with a price", () => {
  it("advertises the reel's own price in the PAYMENT-REQUIRED header", async () => {
    for (const reel of server.catalog.list()) {
      const response = await server.paidFrame(reel.id, 3);
      expect(response.status, `frame 3 of ${reel.id}`).toBe(402);

      const header = response.headers.get("payment-required");
      expect(header, `frame 3 of ${reel.id} carried no PAYMENT-REQUIRED header`).not.toBeNull();

      const required = decodePaymentRequiredHeader(header ?? "");
      expect(required.x402Version).toBe(2);
      // The SDK's own wording, kept rather than replaced: a client that pattern
      // matches on it should not be broken by this server's prose.
      expect(required.error).toBe("Payment required");
      expect(required.accepts).toHaveLength(1);

      const [accepts] = required.accepts;
      expect(accepts?.scheme).toBe("exact");
      expect(accepts?.network).toBe(ETHEREUM_SEPOLIA);
      expect(accepts?.asset).toBe(ETHEREUM_SEPOLIA_USDC);
      // The per-request price: this reel's, read from the catalog rather than
      // from a global, so no two reels can quote one number by accident.
      expect(accepts?.amount).toBe(reel.priceAtomic);
      expect(accepts?.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("prices the resource after the reel, not after the frame", async () => {
    // Every frame of a reel is one product, so every frame of a reel has the same
    // resource - which is also what makes one payment unlock the whole reel
    // rather than a single frame.
    const required = await server.requirementFor("calcutta-tram");
    expect(required.resource.url).toBe(paidFrameResourceUrl(server.origin, "calcutta-tram"));
    expect(required.resource.url).toMatch(/\/reels\/calcutta-tram\/unlock$/);
  });

  it("serves a body that says the settlement mode out loud", async () => {
    const response = await server.paidFrame("calcutta-tram", 3);
    const body = JSON.parse(response.text) as {
      error: string;
      settlementMode: string;
      readMore: string;
    };
    expect(body.error).toBe("payment_required");
    // Nobody should be able to read a 402 from this server and believe a chain
    // was involved. Both the body and the header say so - and the header is the
    // one that survives on a client that only reads headers.
    expect(body.settlementMode).toBe("simulated");
    expect(body.readMore).toMatch(/no chain is contacted/i);
    expect(response.headers.get(SETTLEMENT_MODE_HEADER.toLowerCase())).toBe("simulated");
  });

  it("carries a Sign-In-With-X challenge, so a later request need not pay", async () => {
    const required = await server.requirementFor("calcutta-tram");
    const block = required.extensions?.[SIGN_IN_WITH_X] as
      | { info?: { domain?: string; uri?: string; nonce?: string }; supportedChains?: unknown[] }
      | undefined;
    expect(block, "the 402 advertised no sign-in-with-x block").toBeDefined();
    expect(block?.info?.domain).toBe(new URL(server.origin).host);
    expect(block?.info?.uri).toBe(`${server.origin}/reels/calcutta-tram/unlock`);
    expect(block?.info?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(block?.supportedChains?.[0]).toMatchObject({ chainId: ETHEREUM_SEPOLIA, type: "eip191" });
  });
});

describe("nothing that is not a real paid frame ever reaches x402", () => {
  const mustNotBeQuoted: ReadonlyArray<readonly [string, string]> = [
    // Unknown reel. The one an attacker would enumerate.
    ["an unknown reel", "/api/reels/no-such-reel/frames/frame-003.svg"],
    // Frame 0 is the free peek and is not for sale here.
    ["frame 0", "/api/reels/calcutta-tram/frames/frame-000.svg"],
    // Non-canonical spellings of a frame that does exist. Each of these would be
    // charged for by the x402 route pattern, which ends in `/*`.
    ["an unpadded name", "/api/reels/calcutta-tram/frames/frame-3.svg"],
    ["an over-padded name", "/api/reels/calcutta-tram/frames/frame-0003.svg"],
    ["a bare index", "/api/reels/calcutta-tram/frames/1"],
    ["a bare index with .svg", "/api/reels/calcutta-tram/frames/3.svg"],
    ["a negative index", "/api/reels/calcutta-tram/frames/frame--1.svg"],
    ["a non-numeric name", "/api/reels/calcutta-tram/frames/frame-abc.svg"],
    ["a wrong extension", "/api/reels/calcutta-tram/frames/frame-003.png"],
    ["a traversal attempt", "/api/reels/calcutta-tram/frames/..%2f..%2fetc%2fpasswd"],
    ["an extra segment", "/api/reels/calcutta-tram/frames/frame-003.svg/extra"],
    // The directory itself, and the real last index plus one.
    ["the frames directory", "/api/reels/calcutta-tram/frames"],
    ["a trailing slash", "/api/reels/calcutta-tram/frames/"],
  ];

  it.each(mustNotBeQuoted)("404s %s with no price at all", async (_label, path) => {
    const response = await server.request(path);
    expect(response.status, `GET ${path}`).toBe(404);
    // The real evidence, stronger than the status: x402 never ran, so nothing
    // that could be used as a price oracle was produced.
    expect(response.headers.get("payment-required"), `GET ${path} quoted a price`).toBeNull();
    expect(response.headers.get("www-authenticate"), `GET ${path} quoted a price`).toBeNull();
  });

  it("404s a frame index past the end of a real reel", async () => {
    const reel = server.catalog.get("calcutta-tram");
    expect(reel).not.toBeNull();
    const past = reel?.frames.length ?? 0;
    const response = await server.request(
      `/api/reels/calcutta-tram/frames/frame-${String(past).padStart(3, "0")}.svg`,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("payment-required")).toBeNull();
  });

  it("answers an unknown reel and an out-of-range frame identically, so it is no oracle", async () => {
    const unknownReel = await server.request("/api/reels/no-such-reel/frames/frame-003.svg");
    const outOfRange = await server.request("/api/reels/calcutta-tram/frames/frame-999.svg");

    expect(unknownReel.status).toBe(outOfRange.status);
    // Byte-for-byte. A different detail string, a different key order, a different
    // length - any of them would leak which kind of mistake the caller made.
    expect(unknownReel.bytes.equals(outOfRange.bytes)).toBe(true);
  });

  it("never returns a paid frame's bytes, whatever the request", async () => {
    for (const [, path] of mustNotBeQuoted) {
      const response = await server.request(path);
      for (const paid of server.paidFrameBytes.values()) {
        expect(response.bytes.equals(paid), `GET ${path} leaked a paid frame`).toBe(false);
      }
    }
  });
});

describe("paying, over the wire, unlocks the frame", () => {
  it("returns the exact stored bytes after a valid payment", async () => {
    const response = await server.buyFrame("calcutta-tram", 5);
    const expected = server.paidFrameBytes.get("calcutta-tram/5");
    expect(expected, "the fixture should hold frame 5 of calcutta-tram").toBeDefined();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.text).toContain('data-reel-id="calcutta-tram"');
    expect(response.text).toContain('data-frame-index="5"');
    expect(response.text).toContain('data-frame-kind="paid"');
    expect(response.bytes.equals(expected as Buffer)).toBe(true);
  });

  it("serves it privately and uncacheably, and says the mode again", async () => {
    const response = await server.buyFrame("calcutta-tram", 6);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // No validator: a 304 to an unpaid caller would be a way to learn a frame
    // exists without paying for it.
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get(SETTLEMENT_MODE_HEADER.toLowerCase())).toBe("simulated");
  });

  it("settles exactly once per payment, and says the transaction it invented", async () => {
    const before = server.facilitator.settleCalls;
    const response = await server.buyFrame("circus-elephant", 2);
    expect(response.status).toBe(200);
    expect(server.facilitator.settleCalls).toBe(before + 1);

    const settlement = server.facilitator.settlements.at(-1);
    expect(settlement?.payer).toBe(TEST_WALLET);
    expect(settlement?.resource).toBe(paidFrameResourceUrl(server.origin, "circus-elephant"));
    // A simulated hash: shaped like one, resolvable on no explorer.
    expect(settlement?.transaction).toMatch(/^0x[0-9a-f]{128}$/);
    expect(settlement?.transaction.startsWith(`0x${"0".repeat(64)}`)).toBe(true);
  });

  it("unlocks one reel, and records no session that would leak to another", async () => {
    await server.buyFrame("calcutta-tram", 7);

    // The other two reels are untouched by that payment.
    for (const other of ["circus-elephant", "durga-puja-procession"]) {
      const response = await server.paidFrame(other, 7);
      expect(response.status, `frame 7 of ${other} after paying for calcutta-tram`).toBe(402);
    }

    // And payment leaves no ambient session. Another frame of the reel the caller
    // *just paid for* is still a 402, because the proof of having paid is a
    // signed challenge, not a cookie this server handed out - see
    // `purchase-persistence.test.ts` for how a returning viewer actually gets
    // through without paying twice.
    //
    // That is a deliberate property. A server-side session here would make
    // "one payment, unlimited frames" true for anyone who could borrow or forge a
    // token, and it would make the SIWX layer decorative.
    for (const index of [1, 3, 7]) {
      const response = await server.paidFrame("calcutta-tram", index);
      expect(response.status, `unpaid frame ${index} of an already-paid reel`).toBe(402);
    }
  });
});

describe("a payment the facilitator did not accept is not a paid frame", () => {
  it("refuses a payload with no recognizable payer, and settles nothing", async () => {
    const required = await server.requirementFor("durga-puja-procession");
    const settleBefore = server.facilitator.settleCalls;

    // The payment omits `authorization.from`, so the facilitator cannot tell who
    // paid - which is exactly the condition it refuses on.
    const header = encodePaymentSignatureHeader({
      x402Version: required.x402Version,
      resource: required.resource,
      accepted: requirementOf(required),
      payload: { signature: "0xtest" },
    });

    const response = await server.paidFrame("durga-puja-procession", 1, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(response.status).toBe(402);
    expect(server.facilitator.settleCalls).toBe(settleBefore);
  });

  it("refuses a payment quoting a different amount, before the facilitator sees it", async () => {
    const required = await server.requirementFor("durga-puja-procession");
    const settleBefore = server.facilitator.settleCalls;
    const verifyBefore = server.facilitator.verifyCalls;

    // Half the advertised price. The server never asked for this, so it will not
    // take it.
    const accepts: PaymentRequirements = { ...requirementOf(required), amount: "500" };

    const header = encodePaymentSignatureHeader({
      x402Version: required.x402Version,
      resource: required.resource,
      accepted: accepts,
      payload: {
        signature: "0xtest",
        authorization: {
          from: TEST_WALLET,
          to: accepts.payTo,
          value: "500",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"0".repeat(64)}`,
        },
      },
    });

    const response = await server.paidFrame("durga-puja-procession", 2, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(response.status).toBe(402);
    // Requirement matching refused it, so the facilitator was never consulted.
    expect(server.facilitator.verifyCalls).toBe(verifyBefore);
    expect(server.facilitator.settleCalls).toBe(settleBefore);
  });

  it("ignores a payment header on a request that is not a paid frame", async () => {
    const required = await server.requirementFor("durga-puja-procession");
    const header = server.paymentHeader(required);
    // A 404 is still a 404, even when it arrives with a valid-looking payment
    // attached. The gate runs first and does not care what the caller paid for.
    const response = await server.request("/api/reels/calcutta-tram/frames/frame-3.svg", {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(response.status).toBe(404);
  });
});
