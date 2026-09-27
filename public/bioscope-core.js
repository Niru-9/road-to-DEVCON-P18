/**
 * bioscope-core.js — the parts of the browser client that contain no browser.
 *
 * ## Why this file exists, and why it is separate
 *
 * Everything in here is a pure function over plain data: base64, the SIWE message
 * text, the x402 EIP-3009 payload, a few formatters. None of it touches `window`,
 * `document` or a wallet. That is not tidiness — it is the only reason the payment
 * and sign-in flows can be *proved* by an automated test.
 *
 * `tests/browser-client.test.ts` imports this exact file, runs it against a real
 * server on a real socket, and compares `siweMessage()` byte for byte with the
 * SDK's own `formatSIWEMessage()`. If this file and the server ever disagree about
 * a single byte of the signed message, a signature stops verifying and the tests
 * fail. So the risky part of a wallet UI — hand-rolled signing — is covered without
 * a browser, a wallet, or a credential.
 *
 * The DOM half lives in `bioscope-app.js`, which is the only file that may assume
 * a browser exists.
 *
 * ## No dependencies, on purpose
 *
 * No bundler in this project, no `node_modules` shipped to the page, and no network
 * fetch for a font or a script. Everything here is ES2020 that a browser and Node
 * both run, so the same bytes are tested in CI and executed on the page. The cost
 * is that base64 and hex are written out by hand rather than imported; the benefit
 * is that the demo has no build step and no third-party code running in the tab
 * that decides who may see a paid frame.
 *
 * ## What this file deliberately cannot do
 *
 * It cannot decide access. It has no notion of "unlocked", no wallet to store, and
 * no way to skip a signature: every paid frame it is asked for comes back 402 with
 * a challenge unless the server has already decided otherwise from its own ledger
 * and session. Access lives in `src/`, and this file is a protocol client.
 */

const HEX = "0123456789abcdef";

/** Lowercase `0x` hex, no padding. */
function toHex(bytes) {
  let out = "0x";
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/** UTF-8 encode without `TextEncoder`, so the encoding is visible in the source. */
export function utf8ToHex(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.codePointAt(i);
    if (code > 0xffff) {
      i += 1; // surrogate pair consumed
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return toHex(bytes);
}

/** Decode a base64 header into bytes. Works in a browser and in Node. */
function base64ToBytes(base64) {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node, for the tests. `Buffer` is the only Node global used anywhere in P3's
  // test tooling, and only on this branch, which a browser never takes.
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function bytesToBase64(bytes) {
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

/** Decode a base64 JSON header value, e.g. `payment-required` or a SIWX payload. */
export function decodeJsonHeader(value) {
  const text = new TextDecoder().decode(base64ToBytes(value));
  return JSON.parse(text);
}

/** Encode a JSON value as a base64 header value. */
export function encodeJsonHeader(value) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

/** 32 bytes of nonce, the shape EIP-3009 asks for. */
export function randomNonceHex() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * The EIP-4361 (Sign-In-With-Ethereum) message, byte for byte.
 *
 * Reproduces `SiweMessage#toMessage()` for `version: "1"`, which is what
 * `@x402/extensions` builds on the server via `formatSIWEMessage`. Every field is
 * taken from the challenge the server issued; nothing is invented here, because a
 * signed message that differs from the server's by one character is a signature
 * over nothing.
 *
 * The shape, for a challenge with a statement and an expiry:
 *
 * ```
 * <domain> wants you to sign in with your Ethereum account:
 * <address>
 *
 * <statement>
 *
 * URI: <uri>
 * Version: 1
 * Chain ID: <numeric chain id>
 * Nonce: <nonce>
 * Issued At: <issuedAt>
 * Expiration Time: <expirationTime>
 * Resources:
 * - <resource>
 * ```
 *
 * @param info the `sign-in-with-x` block from a 402, plus `chainId` and `type`.
 * @param address the signer's address, as it appears in the message.
 */
export function siweMessage(info, address) {
  const chainId = String(info.chainId ?? "").replace(/^eip155:/, "");
  if (!/^[0-9]+$/.test(chainId)) {
    throw new Error(`The challenge carries an unusable chain id: ${JSON.stringify(info.chainId)}`);
  }

  const header = `${info.domain} wants you to sign in with your Ethereum account:`;
  let opening;
  if (info.statement === undefined || info.statement === null) {
    opening = `${header}\n${address}\n\n`;
  } else {
    opening = `${header}\n${address}\n\n${info.statement}\n`;
  }

  const fields = [`URI: ${info.uri}`, `Version: ${info.version}`, `Chain ID: ${chainId}`, `Nonce: ${info.nonce}`];
  if (info.issuedAt) {
    fields.push(`Issued At: ${info.issuedAt}`);
  }
  if (info.expirationTime) {
    fields.push(`Expiration Time: ${info.expirationTime}`);
  }
  if (info.notBefore) {
    fields.push(`Not Before: ${info.notBefore}`);
  }
  if (info.requestId !== undefined) {
    fields.push(`Request ID: ${info.requestId}`);
  }
  if (info.resources) {
    fields.push(["Resources:", ...info.resources.map((resource) => `- ${resource}`)].join("\n"));
  }

  return `${opening}\n${fields.join("\n")}`;
}

/**
 * The sign-in-with-x block, with the chain filled in.
 *
 * @throws when the 402 carried no challenge. A paid frame that cannot be signed
 * into has to be paid for again every time, so this is a real error and not
 * something to paper over with a default.
 */
export function challengeFrom(requirements) {
  const block = requirements.extensions?.["sign-in-with-x"];
  const chain = block?.supportedChains?.find((entry) => entry.type === "eip191") ?? block?.supportedChains?.[0];
  if (block?.info === undefined || chain === undefined) {
    throw new Error("This server did not offer a sign-in challenge with its price.");
  }
  return { info: { ...block.info, chainId: chain.chainId, type: chain.type } };
}

/** The `sign-in-with-x` header value for a signed challenge. */
export function siwxHeaderValue(challenge, address, signature) {
  return encodeJsonHeader({ ...challenge.info, address, signature });
}

/** The EIP-712 types EIP-3009 uses, spelled out for `eth_signTypedData_v4`. */
export function exactEip712Types() {
  return {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
}

/**
 * Build an x402 V2 `exact` (EIP-3009) payment payload and the EIP-712 message that
 * has to be signed to authorise it.
 *
 * Everything comes out of the server's own `payment-required`: the amount, the
 * asset, the recipient, the network and — importantly — `extra.name` and
 * `extra.version`, which are the EIP-712 domain parameters. A client that guessed
 * those instead would be guessing which token it is about to authorise a transfer
 * of, so their absence is a hard error here rather than a fallback.
 *
 * @returns `{ paymentPayload, typedData, authorization }`. The caller signs
 * `typedData` and puts the signature into `paymentPayload.payload.signature`.
 */
export function buildExactPayment({ requirements, address, nowSeconds, nonce }) {
  const accepted = requirements.accepts?.[0];
  if (accepted === undefined) {
    throw new Error("The server advertised no way to pay.");
  }
  if (accepted.scheme !== "exact") {
    throw new Error(`This client only speaks the "exact" scheme; the server asked for ${accepted.scheme}.`);
  }
  const name = accepted.extra?.name;
  const version = accepted.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(
      "The server did not say which token version to sign against (extra.name / extra.version). " +
        "Refusing to guess, because that is the token a payment would authorise.",
    );
  }
  const chainMatch = /^eip155:([0-9]+)$/.exec(accepted.network ?? "");
  if (chainMatch === null) {
    throw new Error(`Unsupported payment network: ${JSON.stringify(accepted.network)}`);
  }

  const authorization = {
    from: address,
    to: accepted.payTo,
    value: String(accepted.amount),
    validAfter: "0",
    validBefore: String(nowSeconds + (accepted.maxTimeoutSeconds ?? 60)),
    nonce,
  };

  const typedData = {
    domain: {
      name,
      version,
      chainId: Number(chainMatch[1]),
      verifyingContract: accepted.asset,
    },
    types: exactEip712Types(),
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  };

  return {
    authorization,
    typedData,
    paymentPayload: {
      x402Version: requirements.x402Version,
      resource: requirements.resource,
      accepted,
      payload: { signature: "", authorization },
    },
  };
}

/** `frame-007.svg` — the one spelling the server accepts. */
export function frameFileName(index) {
  return `frame-${String(index).padStart(3, "0")}.svg`;
}

/** The paid-frame URL for one index of one reel. */
export function paidFrameUrl(reelId, index) {
  return `/api/reels/${encodeURIComponent(reelId)}/frames/${frameFileName(index)}`;
}

/** A base-unit amount as a short decimal string, e.g. `1000` at 6dp → `0.001`. */
export function formatUnits(amountAtomic, decimals) {
  const value = BigInt(amountAtomic);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * What to tell the viewer about money.
 *
 * `simulated` is stated in the first clause, every time, because the whole demo
 * rests on nobody being misled about whether a coin moved.
 */
export function settlementSentence(mode, chainLabel) {
  return mode === "testnet"
    ? `Real test USDC settles on ${chainLabel} when you pay.`
    : "Simulated mode: no chain is contacted and no funds move. This purchase is recorded only in this app's local database.";
}

/** Human label for a CAIP-2 network id, for the ones this project can serve. */
export function networkLabel(network) {
  const known = {
    "eip155:84532": "Ethereum Sepolia",
    "eip155:8453": "Base",
    "eip155:1": "Ethereum",
    "eip155:11155111": "Ethereum Sepolia",
  };
  return known[network] ?? network;
}

/** The `PAYMENT-RESPONSE` body, decoded. `null` when the server sent none. */
export function decodeSettlementHeader(value) {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  try {
    return decodeJsonHeader(value);
  } catch {
    return null;
  }
}
