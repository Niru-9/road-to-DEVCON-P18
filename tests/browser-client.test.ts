/**
 * The browser client, driven without a browser (T7).
 *
 * ## What this file is for
 *
 * The payment and sign-in flows are the part of a wallet UI most likely to be
 * quietly wrong: a signed message that differs from the server's by one character
 * does not fail loudly, it just never verifies, and the demo looks like a broken
 * wallet. There is no browser in this test suite and no wallet either, so the only
 * honest way to cover it is to run **the actual client module** -
 * `public/bioscope-core.js`, the same bytes the page loads - against a real server
 * on a real socket.
 *
 * So this file does three things, in increasing strength:
 *
 * 1. **Byte equality.** `siweMessage()` is compared with the SDK's own
 *    `formatSIWEMessage()` for a real challenge, and for the awkward cases
 *    (expired, foreign origin, no statement). If the hand-written formatter ever
 *    drifts from the server's, this fails before any signature is attempted.
 * 2. **A real EIP-712 signature.** The payload the client builds is signed by a
 *    viem account and sent as `PAYMENT-SIGNATURE`, so the server runs its real
 *    scheme, its real facilitator interface and its real settle hook.
 * 3. **The whole flow.** Pay → sign in → session cookie → play every paid frame,
 *    with no signature after the first. A stub provider stands in for MetaMask and
 *    nothing else about the protocol is simulated.
 *
 * ## What is *not* covered
 *
 * The DOM half. `bioscope-app.js` renders, focuses and announces; it cannot be
 * exercised without a browser, and pretending otherwise with a fake DOM would test
 * the fake. Its untested surface is listed in the README and the manual steps
 * in the T7 report.
 *
 * ## No credentials
 *
 * The key is generated in process by `generatePrivateKey()` and never leaves it.
 * There is no `.env`, no configured payer key, and nothing to clean up.
 */

import { describe, expect, it } from "vitest";
import { formatSIWEMessage, type CompleteSIWxInfo } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

import {
  buildExactPayment,
  challengeFrom,
  decodeSettlementHeader,
  exactEip712Types,
  formatUnits,
  frameFileName,
  networkLabel,
  paidFrameUrl,
  randomNonceHex,
  siweMessage,
  settlementSentence,
  utf8ToHex,
} from "../public/bioscope-core.js";
import type { PaymentRequired } from "../public/bioscope-core.js";
import { createEphemeralWallet, type EphemeralWallet } from "./support/test-wallet.js";
import { startBioscopeTestServer, type BioscopeTestServer } from "./support/bioscope-server.js";

const OWNED = "calcutta-tram";
const NOT_OWNED = "circus-elephant";

/**
 * A stand-in for `window.ethereum`, built on a real viem account.
 *
 * Deliberately thin: it implements the two EIP-1193 methods the client uses and
 * throws on anything else, so a client change that reaches for a third method fails
 * here instead of in a browser. The signatures it produces are genuine secp256k1
 * signatures over genuine EIP-712 and EIP-191 payloads.
 */
/** `0x`-prefixed hex back to a UTF-8 string, the way a wallet decodes it. */
function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * A stand-in for `window.ethereum`, built on a real viem account.
 *
 * Deliberately thin: it implements the two EIP-1193 methods the client uses and
 * throws on anything else, so a client change that reaches for a third method fails
 * here instead of in a browser. The signatures it produces are genuine secp256k1
 * signatures over genuine EIP-712 and EIP-191 payloads.
 */
function fakeProvider(wallet: EphemeralWallet, chainId: number) {
  const account = privateKeyToAccount(wallet.privateKey);
  const calls: string[] = [];

  const provider = {
    isBioscopeTestProvider: true,
    async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
      calls.push(args.method);
      switch (args.method) {
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return `0x${chainId.toString(16)}`;
        case "wallet_switchEthereumChain":
          return null;
        case "personal_sign": {
          // MetaMask's `personal_sign` takes the message as hex, decodes it, and
          // signs the *string* - which is what applies the EIP-191 prefix. Signing
          // the raw bytes instead (viem's `{ raw }` form) produces a different
          // digest, so a provider that gets this wrong yields a signature the
          // server cannot possibly verify. Modelling it correctly is the point of
          // having a provider at all.
          const [message, address] = args.params as [string, string];
          expect(address.toLowerCase()).toBe(wallet.address);
          return account.signMessage({ message: hexToUtf8(message) });
        }
        case "eth_signTypedData_v4": {
          const [, json] = args.params as [string, string];
          return account.signTypedData(JSON.parse(json));
        }
        default:
          throw new Error(`The test provider does not implement ${args.method}.`);
      }
    },
  };

  return { provider, calls, account };
}

describe("the client's SIWE message is the server's SIWE message", () => {
  it("matches the SDK byte for byte, for a live challenge", async () => {
    const server = await startBioscopeTestServer();
    try {
      const requirements = await server.requirementFor(OWNED);
      const { info } = challengeFrom(requirements as unknown as PaymentRequired);

      expect(siweMessage(info, "0x1111111111111111111111111111111111111111")).toBe(
        formatSIWEMessage(info as CompleteSIWxInfo, "0x1111111111111111111111111111111111111111"),
      );
    } finally {
      await server.cleanup();
    }
  });

  it("matches for the awkward shapes too: no statement, no expiry, foreign origin, many resources", () => {
    const address = "0x2222222222222222222222222222222222222222";
    const base = {
      domain: "localhost:8787",
      uri: "http://localhost:8787/reels/calcutta-tram/unlock",
      version: "1",
      chainId: "eip155:11155111",
      type: "eip191",
      nonce: "4bdddec915305b8f9eae95ca6f33492b",
      issuedAt: "2026-09-27T11:47:59.912Z",
    };

    const shapes: CompleteSIWxInfo[] = [
      base as CompleteSIWxInfo,
      { ...base, statement: "Sign in to watch the paid frames of this reel." } as CompleteSIWxInfo,
      { ...base, statement: "Short.", expirationTime: "2026-09-27T11:52:59.913Z" } as CompleteSIWxInfo,
      {
        ...base,
        statement: "With resources.",
        expirationTime: "2026-09-27T11:52:59.913Z",
        notBefore: "2026-09-27T11:47:59.912Z",
        requestId: "req-1",
        resources: ["http://localhost:8787/a", "http://localhost:8787/b"],
      } as CompleteSIWxInfo,
      { ...base, domain: "127.0.0.1:1", uri: "http://127.0.0.1:1/reels/x/unlock" } as CompleteSIWxInfo,
    ];

    for (const info of shapes) {
      expect(siweMessage(info, address), `mismatch for ${JSON.stringify(info).slice(0, 120)}`).toBe(
        formatSIWEMessage(info, address),
      );
    }
  });

  it("refuses a challenge whose chain id is not an EVM chain, rather than signing nonsense", () => {
    expect(() =>
      siweMessage(
        {
          domain: "localhost:8787",
          uri: "http://localhost:8787/x",
          version: "1",
          chainId: "solana:devnet",
          type: "ed25519",
          nonce: "abc",
        },
        "0x1111111111111111111111111111111111111111",
      ),
    ).toThrow(/unusable chain id/);
  });
});

describe("the client's payment payload matches what a real x402 client builds", () => {
  it("advertises the EIP-712 domain a conforming client requires", async () => {
    // The defect T7 found in T4: without `extra.name` / `extra.version` the
    // reference client throws and no wallet can pay the 402 at all.
    const server = await startBioscopeTestServer();
    try {
      const requirements = await server.requirementFor(OWNED);
      const accepted = requirements.accepts[0];
      expect(accepted?.extra?.name).toBe("USDC");
      expect(accepted?.extra?.version).toBe("2");

      // And the client's EIP-712 types are the SDK's, field for field.
      const built = buildExactPayment({
        requirements: requirements as unknown as PaymentRequired,
        address: "0x1111111111111111111111111111111111111111",
        nowSeconds: 1_700_000_000,
        nonce: `0x${"11".repeat(32)}`,
      });
      expect(built.typedData.types.TransferWithAuthorization).toEqual([
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ]);
      expect(built.typedData.domain).toEqual({
        name: "USDC",
        version: "2",
        chainId: 11155111,
        verifyingContract: accepted?.asset,
      });
      expect(built.typedData.primaryType).toBe("TransferWithAuthorization");
      expect(built.authorization.value).toBe(accepted?.amount);
      expect(built.authorization.to).toBe(accepted?.payTo);
      expect(built.authorization.validBefore).toBe(
        String(1_700_000_000 + (accepted?.maxTimeoutSeconds ?? 60)),
      );
      expect(exactEip712Types().EIP712Domain).toHaveLength(4);
    } finally {
      await server.cleanup();
    }
  });

  it("refuses to guess a token when the server withholds the EIP-712 domain", () => {
    expect(() =>
      buildExactPayment({
        requirements: {
          x402Version: 2,
          resource: { url: "http://localhost/x" },
          accepts: [
            { scheme: "exact", network: "eip155:11155111", amount: "1000", asset: "0x0", payTo: "0x0", extra: {} },
          ],
        },
        address: "0x1111111111111111111111111111111111111111",
        nowSeconds: 1,
        nonce: "0x00",
      }),
    ).toThrow(/Refusing to guess/);
  });
});

describe("a whole unlock, driven by the real client module", () => {
  it("pays, signs in, and then plays every frame from one session cookie", async () => {
    const wallet = createEphemeralWallet();
    const server = await startBioscopeTestServer({ siwxSigner: wallet });
    const { provider, calls, account } = fakeProvider(wallet, 11155111);

    try {
      // --- 1. The viewer asks for a paid frame and is quoted a price. ---------
      const quote = await server.paidFrame(OWNED, 1);
      expect(quote.status).toBe(402);
      const requirements = quote.headers.get("payment-required");
      expect(requirements, "the 402 carried no payment-required header").not.toBeNull();
      const decoded = (await import("../public/bioscope-core.js")).decodeJsonHeader(
        requirements as string,
      ) as PaymentRequired;

      // The client's own guard: the network it is about to pay on must be the one
      // the server rendered into the page, not one the SIWX block claims.
      expect(decoded.accepts[0]?.network).toBe(server.runtime.config.network);
      expect(decoded.accepts[0]?.network).not.toBe(networkLabel("eip155:1"));

      // --- 2. It builds and signs the payment exactly as the client would. ----
      const built = buildExactPayment({
        requirements: decoded,
        address: await (provider.request({ method: "eth_accounts" }) as Promise<string[]>).then(
          (accounts) => accounts[0] as string,
        ),
        nowSeconds: Math.floor(Date.now() / 1000),
        nonce: randomNonceHex(),
      });
      const signature = (await provider.request({
        method: "eth_signTypedData_v4",
        params: [account.address, JSON.stringify(built.typedData)],
      })) as string;
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

      const paid = await server.paidFrame(OWNED, 1, {
        headers: {
          "PAYMENT-SIGNATURE": (await import("../public/bioscope-core.js")).encodeJsonHeader({
            ...built.paymentPayload,
            payload: { ...built.paymentPayload.payload, signature },
          }),
        },
      });
      expect(paid.status, `the real client payload was refused: ${paid.text.slice(0, 300)}`).toBe(200);

      // The receipt the UI will show a human, read from the server's own header.
      const settlement = decodeSettlementHeader(paid.headers.get("payment-response"));
      expect(settlement?.success).toBe(true);
      expect(settlement?.transaction).toMatch(/^0x[0-9a-f]{128}$/);
      expect(settlement?.payer?.toLowerCase()).toBe(wallet.address);
      expect(paid.headers.get("x-bioscope-settlement-mode")).toBe("simulated");

      // --- 3. One more signature, to be signed in for the rest of the reel. ----
      // The address is used in *one* spelling throughout - the one the wallet
      // reported. SIWE puts the address inside the signed text, so a client that
      // signs with the checksummed form and then sends the lowercase one (or the
      // reverse) produces a valid signature over a message the server never sees,
      // and the failure looks like a broken wallet rather than a mismatched string.
      const quote2 = await server.paidFrame(OWNED, 2);
      expect(quote2.status).toBe(402);
      const requirements2 = (await import("../public/bioscope-core.js")).decodeJsonHeader(
        quote2.headers.get("payment-required") as string,
      ) as PaymentRequired;
      const challenge = challengeFrom(requirements2);
      const message = siweMessage(challenge.info, account.address);
      const siwxSignature = (await provider.request({
        method: "personal_sign",
        params: [utf8ToHex(message), account.address],
      })) as string;

      const core = await import("../public/bioscope-core.js");
      const session = await server.request("/api/session", {
        method: "POST",
        headers: {
          "sign-in-with-x": core.siwxHeaderValue(challenge, account.address, siwxSignature),
        },
      });
      expect(session.status, `sign-in was refused: ${session.text.slice(0, 300)}`).toBe(201);
      const cookie = /bioscope_session=([^;]*)/.exec(session.headers.getSetCookie().join(";"))?.[1] ?? "";
      expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // --- 4. Every remaining frame, from the cookie, with no more signing. ---
      const verifyBefore = server.facilitator.verifyCalls;
      const settleBefore = server.facilitator.settleCalls;
      const reel = server.catalog.require(OWNED);
      for (const frame of reel.frames) {
        if (frame.index === 0) {
          continue;
        }
        const response = await server.paidFrame(OWNED, frame.index, {
          headers: { Cookie: `bioscope_session=${cookie}` },
        });
        expect(response.status, `frame ${frame.index} was not served from the session`).toBe(200);
      }
      expect(server.facilitator.verifyCalls).toBe(verifyBefore);
      expect(server.facilitator.settleCalls).toBe(settleBefore);

      // --- 5. An unbought reel is still shut, from the same cookie. ----------
      expect((await server.paidFrame(NOT_OWNED, 1, { headers: { Cookie: `bioscope_session=${cookie}` } })).status).toBe(402);

      // The wallet was asked exactly twice, and only for the two things a wallet
      // should ever be asked for here: authorise a payment, and prove identity.
      expect(calls).toEqual(["eth_accounts", "eth_signTypedData_v4", "personal_sign"]);
    } finally {
      await server.cleanup();
    }
  });

  it("keeps working when the viewer pays, closes the tab, and comes back with the session cookie", async () => {
    const wallet = createEphemeralWallet();
    const server = await startBioscopeTestServer({ siwxSigner: wallet });
    const { provider, account } = fakeProvider(wallet, 11155111);
    const core = await import("../public/bioscope-core.js");

    try {
      const signIn = async (reelId: string): Promise<string> => {
        const quote = await server.paidFrame(reelId, 1);
        const requirements = core.decodeJsonHeader(quote.headers.get("payment-required") as string) as PaymentRequired;
        const challenge = challengeFrom(requirements);
        const signature = (await provider.request({
          method: "personal_sign",
          params: [utf8ToHex(siweMessage(challenge.info, account.address)), account.address],
        })) as string;
        const response = await server.request("/api/session", {
          method: "POST",
          headers: { "sign-in-with-x": core.siwxHeaderValue(challenge, account.address, signature) },
        });
        expect(response.status).toBe(201);
        return /bioscope_session=([^;]*)/.exec(response.headers.getSetCookie().join(";"))?.[1] ?? "";
      };

      // Paying first, so there is something to come back to.
      const quote = await server.paidFrame(OWNED, 1);
      const requirements = core.decodeJsonHeader(quote.headers.get("payment-required") as string) as PaymentRequired;
      const built = buildExactPayment({
        requirements,
        address: account.address,
        nowSeconds: Math.floor(Date.now() / 1000),
        nonce: randomNonceHex(),
      });
      const signature = (await provider.request({
        method: "eth_signTypedData_v4",
        params: [account.address, JSON.stringify(built.typedData)],
      })) as string;
      expect(
        (
          await server.paidFrame(OWNED, 1, {
            headers: {
              "PAYMENT-SIGNATURE": core.encodeJsonHeader({
                ...built.paymentPayload,
                payload: { ...built.paymentPayload.payload, signature },
              }),
            },
          })
        ).status,
      ).toBe(200);

      const cookie = await signIn(OWNED);

      // A "new tab" is a request with the cookie and nothing else. The client
      // learns the viewer is a returning one from GET /api/session, and pays
      // nothing and signs nothing to play.
      const who = await server.request("/api/session", { headers: { Cookie: `bioscope_session=${cookie}` } });
      const state = JSON.parse(who.text) as { signedIn: boolean; wallet: string; reels: string[] };
      expect(state.signedIn).toBe(true);
      expect(state.wallet).toBe(wallet.address);
      expect(state.reels).toEqual([OWNED]);
      expect((await server.paidFrame(OWNED, 5, { headers: { Cookie: `bioscope_session=${cookie}` } })).status).toBe(200);
    } finally {
      await server.cleanup();
    }
  });
});

describe("the little helpers the page leans on", () => {
  it("names only the one frame spelling the server accepts", () => {
    expect(frameFileName(0)).toBe("frame-000.svg");
    expect(frameFileName(7)).toBe("frame-007.svg");
    expect(frameFileName(12)).toBe("frame-012.svg");
    expect(paidFrameUrl("calcutta-tram", 3)).toBe("/api/reels/calcutta-tram/frames/frame-003.svg");
    // A hostile id is encoded rather than interpolated, so a reel id can never
    // become a path the browser resolves somewhere else.
    expect(paidFrameUrl("../storage/paid-frames", 1)).toBe(
      "/api/reels/..%2Fstorage%2Fpaid-frames/frames/frame-001.svg",
    );
  });

  it("renders prices from base units, and never rounds a small one away", () => {
    expect(formatUnits("1000", 6)).toBe("0.001");
    expect(formatUnits("0", 6)).toBe("0");
    expect(formatUnits("1", 6)).toBe("0.000001");
    expect(formatUnits("1500000", 6)).toBe("1.5");
    expect(formatUnits("1000000000000000000", 18)).toBe("1");
  });

  it("says out loud that simulated is simulated", () => {
    const simulated = settlementSentence("simulated", "Ethereum Sepolia");
    expect(simulated).toContain("no funds move");
    expect(simulated).toContain("no chain is contacted");
    // The record lives in this app's own database. It must NOT name a chain:
    // saying "recorded locally on Base Sepolia" contradicted "no chain is
    // contacted" in the same sentence, and that is exactly the kind of claim
    // this project exists not to make.
    expect(simulated).toContain("local database");
    expect(simulated).not.toMatch(/ethereum sepolia|base sepolia|on-chain|on chain/i);
    // The words that would overstate it must not appear.
    expect(simulated).not.toMatch(/payment (complete|received)/i);

    expect(settlementSentence("testnet", "Ethereum Sepolia")).toContain("Real test USDC");
  });

  it("labels the networks this project can serve and echoes anything else", () => {
    expect(networkLabel("eip155:11155111")).toBe("Ethereum Sepolia");
    expect(networkLabel("eip155:999999")).toBe("eip155:999999");
  });

  it("hex-encodes UTF-8 for `personal_sign`", () => {
    expect(utf8ToHex("abc")).toBe("0x616263");
    // A statement with a non-ASCII character has to survive as UTF-8 bytes, or
    // the wallet signs different bytes than the server hashes.
    expect(utf8ToHex("é")).toBe("0xc3a9");
    expect(utf8ToHex("𝄞")).toBe("0xf09d849e");
  });

  it("reads a settlement header, and shrugs at one that is not there", async () => {
    const core = await import("../public/bioscope-core.js");
    expect(core.decodeSettlementHeader(null)).toBeNull();
    expect(core.decodeSettlementHeader("")).toBeNull();
    expect(core.decodeSettlementHeader("not base64 json")).toBeNull();
    expect(core.decodeSettlementHeader(core.encodeJsonHeader({ success: true, transaction: "0xabc" }))).toEqual({
      success: true,
      transaction: "0xabc",
    });
  });
});
