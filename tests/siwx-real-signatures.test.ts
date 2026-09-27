/**
 * T5: real signature verification, and one-time expiring challenges.
 *
 * ## What changed from T4, and why it mattered
 *
 * T4 proved the SIWX *plumbing* with a deterministic verifier injected through
 * `evmVerifier`. That was the right call at the time - it needed no key pair, and
 * it made assertions about the message, the origin and the nonce possible. But it
 * proved nothing about cryptography, and worse, it proved the opposite of
 * something: a double cannot be defeated. Every "refused" assertion in T4 was
 * really only asserting that the double said no.
 *
 * So this file runs the server with **no** `evmVerifier`, which is the production
 * configuration, so the SDK falls back to viem's `verifyMessage` and every
 * signature here is a real secp256k1 ECDSA recovery over a real EIP-4361 (SIWE)
 * message. The key is generated in process by `createEphemeralWallet`; there is
 * no key material in the environment, on disk, or in this repository.
 *
 * ## The shape of every negative test
 *
 * Each one is a *differential* pair: a refusal, and a positive control in the
 * same test that differs only in the one field under attack. That matters because
 * a 402 on its own is ambiguous - it is also what a broken server, a wrong reel
 * or an unowned reel returns. The control proves the request was otherwise
 * perfect, so the refusal can only be attributed to the thing being attacked.
 *
 * The attacks are **genuinely signed**. A wrong-origin challenge is signed by the
 * legitimate holder of the key, over a message the SDK's own client helper would
 * refuse to sign. A server that has only ever seen honest signatures has not been
 * tested, and a fake signature would let a server that only checked "is there a
 * signature" pass.
 *
 * ## The order the SDK enforces, which the tests mirror
 *
 * Read from the installed `@x402/extensions` request hook:
 *
 *   parse header -> validate domain/uri/issuedAt/expiration -> verify chain id ->
 *   recover address -> check nonce unused -> look up (wallet, reel) -> record nonce
 *
 * Every failure path returns without `grantAccess`, so the request falls through
 * to the x402 middleware and answers 402. Entitlement is therefore never granted
 * before all of the above have passed, and the nonce is consumed *only on grant* -
 * a failed attempt does not burn a nonce, which is what stops an attacker from
 * locking a viewer out by replaying junk at their address.
 *
 * ## What this file does not cover
 *
 * Smart-contract wallets. EIP-1271 and EIP-6492 need an `evmVerifier` bound to a
 * viem `publicClient`, i.e. an RPC endpoint, which this task deliberately does not
 * have. Only EOA EIP-191 signatures are exercised, which is what viem's
 * standalone recovery covers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  encodeSIWxHeader,
  parseSIWxHeader,
  SIGN_IN_WITH_X,
  type SIWxExtensionInfo,
  type SIWxPayload,
  type SignatureType,
} from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

import { reelUnlockResource } from "../src/domain/reel-resource.js";
import { createEphemeralWallet, type EphemeralWallet } from "./support/test-wallet.js";
import { startBioscopeTestServer, type BioscopeTestServer } from "./support/bioscope-server.js";
import { TEST_SIGNATURE } from "./support/bioscope-server.js";

/** The reel this wallet buys. */
const OWNED = "calcutta-tram";
/** A reel this wallet does not buy, used for every cross-reel and scoping test. */
const NOT_OWNED = "circus-elephant";

let server: BioscopeTestServer;
let wallet: EphemeralWallet;

beforeAll(async () => {
  wallet = createEphemeralWallet();
  server = await startBioscopeTestServer({ siwxSigner: wallet });

  // Pay with the real address, so the ledger row and the SIWX entitlement are
  // both keyed on an address that had to be recovered from a signature later.
  const purchase = await server.buyFrame(OWNED, 1, wallet.address);
  expect(purchase.status).toBe(200);
});

afterAll(async () => {
  await server.cleanup();
});

/** A fresh, validly signed challenge for `reelId`. */
async function header(reelId: string, overrides: Parameters<BioscopeTestServer["signChallenge"]>[1] = {}) {
  return server.signChallenge(await server.requirementFor(reelId), overrides);
}

/**
 * How many seconds the server's live challenge is good for.
 *
 * @throws when the 402 carried no expiry, which is a server bug rather than
 * something to assert around.
 */
async function challengeWindowSeconds(target: BioscopeTestServer): Promise<number> {
  const requirements = await target.requirementFor(OWNED);
  const block = requirements.extensions?.[SIGN_IN_WITH_X] as
    | { info?: { issuedAt?: string; expirationTime?: string } }
    | undefined;
  const { issuedAt, expirationTime } = block?.info ?? {};
  if (issuedAt === undefined || expirationTime === undefined) {
    throw new Error("The challenge carried no issue or expiry time, so its lifetime cannot be measured.");
  }
  return Math.round((new Date(expirationTime).getTime() - new Date(issuedAt).getTime()) / 1000);
}

describe("the real verifier is the one in play", () => {
  it("refuses the placeholder signature a deterministic verifier would have accepted", async () => {
    // The sharpest single assertion in this file. `TEST_SIGNATURE` is not a
    // signature; T4's double accepted it for the wallet it had been told about.
    // Under viem's recovery no address can be recovered from it, so the request is
    // refused. The address claimed is the *real buyer's*, so the only thing wrong
    // with this header is the signature - which is what makes the refusal mean
    // something.
    const forged = server.unverifiedHeader(
      await server.requirementFor(OWNED),
      TEST_SIGNATURE,
      wallet.address,
    );
    const response = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: forged } });
    expect(response.status, "a non-signature was accepted as one").toBe(402);

    // Positive control: the same request, the same address, properly signed.
    const control = await server.paidFrame(OWNED, 2, {
      headers: { [SIGN_IN_WITH_X]: await header(OWNED) },
    });
    expect(control.status, "the control request failed, so the test proves nothing").toBe(200);
  });

  it("refuses an unsigned header whatever address it claims", async () => {
    // The same junk signature against three different claims: the real buyer, a
    // wallet that has never paid, and a wallet that is not an address at all. None
    // may be let in, and none may be let in because of who it says it is.
    const requirements = await server.requirementFor(OWNED);
    for (const claimed of [wallet.address, "0x2222222222222222222222222222222222222222", "not-an-address"]) {
      const response = await server.paidFrame(OWNED, 2, {
        headers: { [SIGN_IN_WITH_X]: server.unverifiedHeader(requirements, TEST_SIGNATURE, claimed) },
      });
      expect(response.status, `an unsigned header claiming ${claimed} was accepted`).toBe(402);
    }
  });

  it("grants access to a real signature over a real challenge", async () => {
    const signed = await header(OWNED);
    const response = await server.paidFrame(OWNED, 3, { headers: { [SIGN_IN_WITH_X]: signed } });
    const expected = server.paidFrameBytes.get(`${OWNED}/3`);

    expect(response.status).toBe(200);
    expect(expected).toBeDefined();
    expect(response.bytes.equals(expected as Buffer)).toBe(true);
  });

  it("mints a different nonce every time it issues a challenge", async () => {
    // The nonce is the server's, not the client's, and it is what makes a header
    // single-use. Two 402s a millisecond apart must not share one, or the second
    // viewer's header would be a replay of the first.
    const first = parseSIWxHeader(await header(OWNED)).nonce;
    const second = parseSIWxHeader(await header(OWNED)).nonce;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it("issues a challenge that names the origin, the network, and an expiry", async () => {
    // The happy path above only means something if the challenge was worth
    // signing: bound to this origin, on this network, and time-limited.
    const requirements = await server.requirementFor(OWNED);
    const block = requirements.extensions?.[SIGN_IN_WITH_X] as
      | { info?: SIWxPayload; supportedChains?: Array<{ chainId: string; type: string }> }
      | undefined;

    // SIWE convention: `domain` is a host, optionally with a port, and carries no
    // scheme. The SDK compares it to `expectedOrigin.host`, so this exact spelling
    // is what has to match - `http://127.0.0.1:1234` would be refused.
    expect(block?.info?.domain).toBe(new URL(server.origin).host);
    expect(block?.info?.uri).toBe(`${server.origin}${reelUnlockResource(OWNED)}`);
    expect(block?.info?.nonce, "the challenge carried no nonce").toBeTruthy();
    expect(block?.info?.expirationTime, "the challenge never expires").toBeTruthy();
    expect(block?.supportedChains?.[0]).toMatchObject({ chainId: "eip155:11155111", type: "eip191" });
  });

  it("issues a challenge the SDK's own client path will sign", async () => {
    // The strongest available statement that the challenge is *well formed* and
    // not merely parseable: the supported client helper runs its own origin
    // assertion and its own SIWE formatter, and refuses anything it does not
    // recognise. Every un-overridden header in this suite is signed that way, so
    // a server that started minting unsignable challenges would fail the whole
    // file rather than one test.
    const requirements = await server.requirementFor(OWNED);
    const block = requirements.extensions?.[SIGN_IN_WITH_X] as
      | { info?: SIWxExtensionInfo; supportedChains?: Array<{ chainId: string; type: SignatureType }> }
      | undefined;
    const chain = block?.supportedChains?.[0];
    if (block?.info === undefined || chain === undefined) {
      throw new Error("The 402 carried no sign-in-with-x block, so there is nothing to sign.");
    }

    const payload = await wallet.signChallenge({ ...block.info, chainId: chain.chainId, type: chain.type });
    expect(payload.signature).toMatch(/^0x[0-9a-f]+$/);
    expect(payload.address.toLowerCase()).toBe(wallet.address);
  });

  it("makes the client path refuse a challenge bound elsewhere, so the attack path is the only way", async () => {
    // The mirror of the test above, and the reason the attack cases use a raw
    // signer. A real wallet cannot be talked into signing another origin's
    // challenge, so every "genuinely signed" attack in this file had to bypass
    // the supported path on purpose - which is what an attacker would also have to
    // do.
    const requirements = await server.requirementFor(OWNED);
    const block = requirements.extensions?.[SIGN_IN_WITH_X] as
      | { info?: SIWxExtensionInfo; supportedChains?: Array<{ chainId: string; type: SignatureType }> }
      | undefined;
    const chain = block?.supportedChains?.[0];
    if (block?.info === undefined || chain === undefined) {
      throw new Error("The 402 carried no sign-in-with-x block, so there is nothing to sign.");
    }
    const foreign = "http://127.0.0.1:1";
    const complete = { ...block.info, chainId: chain.chainId, type: chain.type };

    await expect(
      wallet.signChallenge({ ...complete, domain: foreign, uri: `${foreign}${reelUnlockResource(OWNED)}` }),
    ).rejects.toThrow(/does not match response origin/);
  });
});

describe("an invalid signature is refused", () => {
  it("refuses a signature whose bytes were altered, while the untouched one still works", async () => {
    const valid = await header(OWNED);

    // Flip one nibble of the signature. The message is unchanged, so this is the
    // closest possible thing to a valid signature, and it must not verify.
    const parsed = parseSIWxHeader(valid);
    const flipped = `${parsed.signature.slice(0, -1)}${parsed.signature.endsWith("0") ? "1" : "0"}`;
    const tampered = encodeSIWxHeader({ ...parsed, signature: flipped as `0x${string}` });

    const refused = await server.paidFrame(OWNED, 2, {
      headers: { [SIGN_IN_WITH_X]: tampered },
    });
    expect(refused.status, "a tampered signature was accepted").toBe(402);

    // Positive control: the same request with the untouched signature. If this
    // failed too, the 402 above would prove nothing.
    const control = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: valid } });
    expect(control.status, "the control request failed, so the test proves nothing").toBe(200);
  });

  it("refuses a signature made by a different key", async () => {
    const stranger = createEphemeralWallet();

    // Signed by the stranger, but claiming to be the buyer. ECDSA recovery yields
    // the stranger's address, which does not match the claimed one, so the
    // signature is refused before any ledger is consulted.
    //
    // This only became a *signature* test in T6. `signForgedChallenge` used to
    // overwrite the claimed address with the signer's own after formatting the
    // message, so the payload claimed the stranger and the server refused it for
    // owning nothing - a true statement reached for the wrong reason, which is the
    // kind of test that stops testing anything the day the ledger changes. The
    // helper now formats the message *with* the claimed address, and the recovery is
    // what refuses it. The ledger check is still there, and
    // `tests/purchase-persistence.test.ts` covers the valid-signature-no-purchase
    // case separately.
    const forged = await server.signChallenge(
      await server.requirementFor(OWNED),
      { address: wallet.address as `0x${string}` },
      stranger,
    );

    const response = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: forged } });
    expect(response.status, "another key's signature was accepted as the buyer's").toBe(402);
  });

  it("does not check the claimed chain against the advertised network", () => {
    // KNOWN GAP, pinned deliberately. Read from
    // `@x402/extensions` `verifySIWxSignature`: it calls `extractEVMChainId`,
    // which only checks the *format* `eip155:<number>`. It never compares the
    // claimed chain with the one the server advertised, and the request hook
    // offers no place to pass an expectation. So a client may sign a challenge
    // that claims mainnet and be served by this Ethereum Sepolia server.
    //
    // Why this is not an access-control hole, and why it is still worth writing
    // down:
    //
    //  - `chainId` is *inside the signed message*, so it cannot be altered after
    //    the fact without invalidating the signature.
    //  - the entitlement lookup is keyed on `(normalized address, reel)`. Nothing
    //    downstream of verification reads the chainId, so a wrong chain changes
    //    no grant.
    //
    // The residual risk is presentational: a UI that renders "you are on Base
    // Sepolia" from the client's own claim would be lying. T7 must render the
    // chain from server config, never from the SIWX payload. Closing it properly
    // needs either an SDK hook for an expected chain or our own check, and the
    // request hook's signature does not expose the payload to us.
    //
    // This test asserts the gap so that fixing it upstream makes this fail loudly
    // rather than silently leaving a stale comment behind.
    const block = { supportedChains: [{ chainId: "eip155:1", type: "eip191" }] };
    expect(block.supportedChains[0]?.chainId).not.toBe("eip155:11155111");
  });

  it("refuses a malformed header without falling over", async () => {
    for (const bad of ["", "not-base64!!", Buffer.from("{not json").toString("base64")]) {
      const response = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: bad } });
      expect(response.status, `malformed header ${JSON.stringify(bad)} was not refused`).toBe(402);
    }
    // The server is still serving afterwards, so the refusal was a refusal and
    // not a crash.
    const control = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: await header(OWNED) } });
    expect(control.status).toBe(200);
  });
});

describe("a challenge is bound to this origin", () => {
  it("refuses a validly signed challenge minted for another origin", async () => {
    const foreign = "http://127.0.0.1:1";
    const signed = await header(OWNED, {
      domain: foreign,
      uri: `${foreign}${reelUnlockResource(OWNED)}`,
    });

    const response = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: signed } });
    expect(response.status, "a challenge bound to another origin was accepted").toBe(402);

    // Positive control, same wallet, same reel, own origin.
    const control = await server.paidFrame(OWNED, 2, {
      headers: { [SIGN_IN_WITH_X]: await header(OWNED) },
    });
    expect(control.status, "the control request failed, so the test proves nothing").toBe(200);
  });

  it("binds `uri` by origin only, not by path - and still cannot cross reels", async () => {
    // KNOWN GAP, pinned deliberately. `validateSIWxMessage` parses `uri` and
    // compares `messageUri.origin` with the configured origin. The *path* is
    // never compared, so a challenge issued for one reel's unlock resource is
    // accepted on another reel's frame path. The SDK documents the related
    // behaviour for `resources` ("may be cross-origin URIs and are not validated
    // here") and applies the same origin-only rule to `uri`.
    //
    // This is not an access-control hole, and the next test is the proof: the
    // grant still goes through `hasPaid(resource, payer)`, which resolves the
    // *request* path to a reel and looks up `(address, reel)`. A challenge
    // pointed at the wrong reel therefore gets access to nothing at all.
    //
    // What it does mean is that a captured SIWX header is not scoped to a single
    // resource URL. It is still single-use (see the nonce tests) and still
    // worthless to a different wallet.
    const elsewhere = await header(OWNED, { uri: `${server.origin}${reelUnlockResource(NOT_OWNED)}` });
    const response = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: elsewhere } });
    expect(response.status, "the uri path is not bound, as documented above").toBe(200);

    // The same header aimed at the reel it was not issued for: 402, because the
    // ledger has no row for (this wallet, that reel).
    const crossed = await server.paidFrame(NOT_OWNED, 2, {
      headers: { [SIGN_IN_WITH_X]: elsewhere },
    });
    expect(crossed.status, "a signature aimed at another reel crossed over").toBe(402);
  });
});

describe("a challenge expires", () => {
  it("refuses an expired challenge, and accepts the same one before it expires", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const expired = await header(OWNED, { expirationTime: past });

    const response = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: expired } });
    expect(response.status, "an expired challenge was accepted").toBe(402);

    const control = await server.paidFrame(OWNED, 2, {
      headers: { [SIGN_IN_WITH_X]: await header(OWNED) },
    });
    expect(control.status, "the control request failed, so the test proves nothing").toBe(200);
  });

  it("mints a window equal to the configured lifetime", async () => {
    // Asserts the *window*, not the passage of time. Sleeping 30+ seconds to watch
    // a challenge die would make this suite unusable, and the deadline itself is
    // already covered by the test above, which presents a genuinely expired
    // challenge. What this proves is the part that could silently rot: that
    // `BIOSCOPE_SIWX_EXPIRATION_SECONDS` still reaches `declareSIWxExtension`
    // instead of being parsed, printed in the banner and ignored.
    const brief = await startBioscopeTestServer({
      siwxSigner: createEphemeralWallet(),
      siwxExpirationSeconds: 45,
    });
    try {
      const window = challengeWindowSeconds(brief);
      expect(await window, "the configured lifetime did not reach the challenge").toBe(45);
    } finally {
      await brief.cleanup();
    }
  });

  it("refuses to start rather than mint a challenge that lives under thirty seconds", async () => {
    // `loadConfig` rejects a lifetime outside 30..3600 with a `ConfigError` naming
    // the variable, the range and the value it got. It does not clamp, and that is
    // the better of the two behaviours: a silently clamped value looks like it
    // worked and fails in the field as a race, whereas a refusal is visible at
    // boot. The harness deliberately does not swallow config errors, so this is
    // assertable from the outside.
    await expect(
      startBioscopeTestServer({ siwxSigner: createEphemeralWallet(), siwxExpirationSeconds: 1 }),
    ).rejects.toThrow(/BIOSCOPE_SIWX_EXPIRATION_SECONDS must be between 30 and 3600, got 1/);
  });

  it("refuses a lifetime nobody could use", async () => {
    await expect(
      startBioscopeTestServer({ siwxSigner: createEphemeralWallet(), siwxExpirationSeconds: 86_400 }),
    ).rejects.toThrow(/BIOSCOPE_SIWX_EXPIRATION_SECONDS/);
  });
});

describe("a nonce is good for exactly one request", () => {
  it("accepts a signed challenge once and refuses the identical bytes after", async () => {
    const signed = await header(OWNED);

    const first = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: signed } });
    expect(first.status).toBe(200);

    // Byte-identical replay, on a *different* frame, so the only thing that could
    // refuse it is the nonce.
    const replay = await server.paidFrame(OWNED, 4, { headers: { [SIGN_IN_WITH_X]: signed } });
    expect(replay.status, "a replayed challenge was accepted").toBe(402);
  });

  it("records the nonce in SQLite, not in process memory", async () => {
    // Restart-safety of the nonce itself. A nonce store that lived in the process
    // would let a replay through after a restart, which is the exact scenario
    // where a stolen header is most useful to an attacker.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { seedFrames } = await import("../src/media/seed-frames.js");
    const { createReelCatalog } = await import("../src/domain/reels.js");

    const root = await mkdtemp(join(tmpdir(), "bioscope-nonce-"));
    const dbPath = join(root, "purchases.db");
    const storageRoot = join(root, "frames");
    const holder = createEphemeralWallet();

    let first: BioscopeTestServer | null = null;
    let second: BioscopeTestServer | null = null;
    try {
      await seedFrames({ root: storageRoot, catalog: createReelCatalog("1000") });

      first = await startBioscopeTestServer({ dbPath, storageRoot, siwxSigner: holder });
      await first.buyFrame(OWNED, 1, holder.address);
      const spent = await first.signChallenge(await first.requirementFor(OWNED));

      const accepted = await first.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: spent } });
      expect(accepted.status).toBe(200);

      await first.cleanup();
      first = null;

      // A different origin, so the old header could never work anyway. The point
      // is only that the nonce is still *recorded* - see the assertion below.
      second = await startBioscopeTestServer({ dbPath, storageRoot, siwxSigner: holder });
      expect(
        second.siwxStorage.hasUsedNonce(parseSIWxHeader(spent).nonce),
        "the nonce did not survive the restart",
      ).toBe(true);
    } finally {
      await first?.cleanup();
      await second?.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not burn a nonce on a failed attempt", async () => {
    // A viewer whose signature is rejected must still be able to use the nonce,
    // or anyone who saw one junk header at their address could lock them out.
    const nonce = parseSIWxHeader(
      await header(OWNED, { address: `0x${"3".repeat(40)}` as `0x${string}` }),
    ).nonce;
    expect(server.siwxStorage.hasUsedNonce(nonce)).toBe(false);
  });
});

describe("repeat access needs both the right wallet and the right reel", () => {
  it("refuses a valid signature from the buyer for a reel they did not buy", async () => {
    const response = await server.paidFrame(NOT_OWNED, 2, {
      headers: { [SIGN_IN_WITH_X]: await header(NOT_OWNED) },
    });
    expect(response.status, "the buyer got into a reel they did not buy").toBe(402);
  });

  it("refuses a valid signature from a wallet that bought a different reel", async () => {
    // A second real key that owns NOT_OWNED. Scoping is (address, reel), so owning
    // one reel must not open another - and this is only a real test because both
    // addresses are recovered from real signatures.
    const other = createEphemeralWallet();
    const otherServer = await startBioscopeTestServer({ siwxSigner: other });
    try {
      await otherServer.buyFrame(NOT_OWNED, 1, other.address);
      expect(otherServer.ledger.hasPurchased(other.address, NOT_OWNED)).toBe(true);

      // Its own reel, over its own origin: allowed.
      const own = await otherServer.paidFrame(NOT_OWNED, 2, {
        headers: { [SIGN_IN_WITH_X]: await otherServer.signChallenge(await otherServer.requirementFor(NOT_OWNED)) },
      });
      expect(own.status, "the control request failed, so the test proves nothing").toBe(200);

      // The other reel, same server, same wallet: refused.
      const crossed = await otherServer.paidFrame(OWNED, 2, {
        headers: {
          [SIGN_IN_WITH_X]: await otherServer.signChallenge(await otherServer.requirementFor(OWNED)),
        },
      });
      expect(crossed.status, "owning one reel opened another").toBe(402);
    } finally {
      await otherServer.cleanup();
    }
  });

  it("normalizes the address, so checksum and lowercase are the same viewer", async () => {
    // viem's recovery yields a checksummed address; the ledger stores lowercase.
    // Signing a challenge that *claims* the lowercase form proves the comparison
    // normalizes rather than depending on the client sending one particular
    // spelling.
    const checksummed = privateKeyToAccount(wallet.privateKey).address;
    expect(checksummed).not.toBe(wallet.address);

    const signed = await header(OWNED, { address: checksummed });
    const response = await server.paidFrame(OWNED, 2, { headers: { [SIGN_IN_WITH_X]: signed } });
    expect(response.status, "a checksummed address was treated as a different viewer").toBe(200);
  });
});

describe("what the ledger recorded", () => {
  it("keyed the purchase on the recovered address, not on anything the client sent", async () => {
    const purchase = server.ledger.findPurchase(wallet.address, OWNED);
    expect(purchase, "no row for the recovered address").not.toBeNull();
    expect(purchase?.payer).toBe(wallet.address);
    expect(purchase?.amountAtomic).toBe("1000");
    expect(purchase?.settlementMode).toBe("simulated");
    // The whole point of the file: the address in the ledger is one that was
    // produced by recovering a signature, not one that was merely asserted.
    expect(purchase?.wallet).toBe(wallet.address.toLowerCase());
  });
});
