/**
 * Token amounts, in integer base units, as `bigint`.
 *
 * USDC has 6 decimals, so one base unit is 0.000001 USDC. Prices are decided on
 * the server and are never parsed from anything a client sent.
 *
 * Amounts are carried across the database boundary as decimal *strings* because
 * SQLite has no integer type wide enough to be worth trusting here and because a
 * JS `number` would silently lose precision. A binary float is never used for a
 * monetary value anywhere in P3.
 */

/** Base units per whole token, for the assets P3 accepts. */
export const USDC_DECIMALS = 6;

/** A canonical, zero-padded-free base-unit amount, e.g. `"1000"`. */
export type AtomicAmount = string;

const CANONICAL_AMOUNT = /^(0|[1-9][0-9]*)$/;

export class InvalidAmountError extends Error {
  public constructor(value: unknown) {
    super(
      `Not a non-negative integer base-unit amount: ${JSON.stringify(
        typeof value === "string" ? value : String(value),
      )}`,
    );
    this.name = "InvalidAmountError";
  }
}

/**
 * Parse a canonical decimal string into base units.
 *
 * Rejects signs, decimal points, exponents, leading zeros and whitespace rather
 * than quietly repairing them, so that `"01000"`, `"+1000"` and `"1000.0"` are
 * all errors instead of three spellings of one price.
 *
 * @throws {InvalidAmountError}
 */
export function parseAtomicAmount(value: unknown): bigint {
  if (typeof value !== "string" || !CANONICAL_AMOUNT.test(value)) {
    throw new InvalidAmountError(value);
  }
  return BigInt(value);
}

/** Render base units back to a canonical decimal string. */
export function formatAtomicAmount(value: bigint): AtomicAmount {
  if (value < 0n) {
    throw new InvalidAmountError(value.toString());
  }
  return value.toString();
}

/** Throw unless `value` is already a canonical base-unit string. */
export function assertAtomicAmount(value: unknown): asserts value is AtomicAmount {
  parseAtomicAmount(value);
}
