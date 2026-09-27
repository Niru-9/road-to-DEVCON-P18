/**
 * Wallet address identity.
 *
 * Every entitlement decision in P3 is keyed by a wallet address, so the address
 * has to mean exactly one thing no matter how it was spelled on the way in. A
 * browser wallet sends an EIP-55 checksummed address, a script might send a
 * lowercase one, and a person pasting from a block explorer might send either.
 * All three are the same account, and treating them as three different accounts
 * would let a returning viewer pay twice - which is the one thing the bioscope
 * promises never to happen.
 *
 * The canonical form is therefore lowercase `0x` + 40 hex characters.
 */

import { isAddress } from "viem";

/** The canonical shape of a stored wallet address. */
export const WALLET_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

export class InvalidWalletAddressError extends Error {
  public constructor(value: unknown) {
    super(
      `Not a 20-byte EVM wallet address: ${JSON.stringify(
        typeof value === "string" ? value : String(value),
      )}`,
    );
    this.name = "InvalidWalletAddressError";
  }
}

/**
 * True when `value` is a 20-byte EVM address in any casing.
 *
 * Deliberately *not* checksum-strict. viem's default `isAddress` rejects a
 * mixed-case address whose EIP-55 checksum does not verify, which is a useful
 * typo detector but is not an identity guarantee: the lowercase hex already
 * determines which account is meant. Being strict here could reject a perfectly
 * real viewer over a casing quirk; being lenient cannot grant the wrong access,
 * because every accepted spelling still lowers to the same address.
 */
export function isWalletAddress(value: unknown): value is string {
  return typeof value === "string" && isAddress(value, { strict: false });
}

/**
 * Normalize any accepted spelling of an address to its canonical lowercase form.
 *
 * @throws {InvalidWalletAddressError} if the value is not a 20-byte EVM address.
 */
export function normalizeWalletAddress(value: unknown): string {
  if (!isWalletAddress(value)) {
    throw new InvalidWalletAddressError(value);
  }
  return value.toLowerCase();
}

/** Normalize, or return `null` instead of throwing. */
export function tryNormalizeWalletAddress(value: unknown): string | null {
  return isWalletAddress(value) ? value.toLowerCase() : null;
}
