import { describe, expect, it } from "vitest";

import {
  InvalidWalletAddressError,
  isWalletAddress,
  normalizeWalletAddress,
  tryNormalizeWalletAddress,
} from "../src/domain/wallet.js";

/** The same account, spelled the three ways it turns up in practice. */
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const LOWERCASE = CHECKSUMMED.toLowerCase();
const UPPERCASE_HEX = "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED";

const OTHER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";

describe("wallet address normalization", () => {
  it("collapses every spelling of one address onto one canonical form", () => {
    expect(normalizeWalletAddress(CHECKSUMMED)).toBe(LOWERCASE);
    expect(normalizeWalletAddress(LOWERCASE)).toBe(LOWERCASE);
    expect(normalizeWalletAddress(UPPERCASE_HEX)).toBe(LOWERCASE);
  });

  it("keeps different addresses apart", () => {
    expect(normalizeWalletAddress(OTHER)).not.toBe(normalizeWalletAddress(CHECKSUMMED));
  });

  it("always produces the canonical 0x + 40 lowercase hex shape", () => {
    for (const spelling of [CHECKSUMMED, LOWERCASE, UPPERCASE_HEX]) {
      expect(normalizeWalletAddress(spelling)).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });

  it("is idempotent", () => {
    const once = normalizeWalletAddress(CHECKSUMMED);
    expect(normalizeWalletAddress(once)).toBe(once);
  });

  it("rejects anything that is not a 20-byte EVM address", () => {
    const rejected: unknown[] = [
      "",
      "0x",
      "not-an-address",
      // One hex digit short.
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe",
      // One hex digit long.
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd",
      // Non-hex characters.
      "0xZZAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      // No 0x prefix.
      "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      // Surrounding whitespace is not trimmed away silently.
      " 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed ",
      // A URL, not a bare address.
      "https://example.com/0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      // A private key, which is 32 bytes and must never be treated as a wallet.
      `0x${"11".repeat(32)}`,
      42,
      null,
      undefined,
      {},
      [],
    ];

    for (const value of rejected) {
      expect(isWalletAddress(value), `expected rejection of ${JSON.stringify(value)}`).toBe(false);
      expect(tryNormalizeWalletAddress(value)).toBeNull();
      expect(() => normalizeWalletAddress(value)).toThrow(InvalidWalletAddressError);
    }
  });

  it("rejects a 32-byte value that would otherwise look address-shaped", () => {
    // Guards the specific mistake of treating a signing key as an identity.
    const keyLike = `0x${"ab".repeat(32)}`;
    expect(isWalletAddress(keyLike)).toBe(false);
  });
});
