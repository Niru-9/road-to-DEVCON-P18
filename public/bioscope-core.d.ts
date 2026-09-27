/**
 * Types for `public/bioscope-core.js`.
 *
 * Hand-written, and deliberately minimal: the file is plain browser JavaScript with
 * no build step, so this is what lets `tsc --noEmit` check the *test* that drives
 * it. Every declaration below is a promise the implementation has to keep, which
 * is the point — a signature mismatch between the client and the server is the
 * failure this file exists to make visible.
 *
 * Nothing here is served to a browser. `src/ui/assets.ts` serves an allow-list of
 * three files, and a `.d.ts` is not on it.
 */

/** A CAIP-2 network id, e.g. `eip155:84532`. */
export type Network = string;

/** The `sign-in-with-x` block from a 402, with the chain selected. */
export interface SignInChallenge {
  readonly domain: string;
  readonly uri: string;
  readonly version: string;
  readonly chainId: Network;
  readonly type: string;
  readonly nonce: string;
  readonly statement?: string | undefined;
  readonly issuedAt?: string | undefined;
  readonly expirationTime?: string | undefined;
  readonly notBefore?: string | undefined;
  readonly requestId?: string | undefined;
  readonly resources?: readonly string[] | undefined;
  readonly address?: string | undefined;
  readonly signature?: string | undefined;
}

export interface PaymentRequirements {
  readonly scheme: string;
  readonly network: Network;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds?: number;
  /**
   * Scheme metadata. `name` and `version` are the EIP-712 domain parameters and
   * are required: without them a client cannot know which token it is signing for.
   */
  readonly extra?: { readonly name?: string; readonly version?: string } | undefined;
}

export interface PaymentRequired {
  readonly x402Version: number;
  readonly resource: { readonly url: string; readonly description?: string; readonly mimeType?: string };
  readonly accepts: readonly PaymentRequirements[];
  readonly extensions?: Record<string, unknown>;
}

export interface Eip712Field {
  readonly name: string;
  readonly type: string;
}

export interface ExactTypedData {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
  readonly types: Record<string, readonly Eip712Field[]>;
  readonly primaryType: string;
  readonly message: Record<string, string>;
}

export interface ExactAuthorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface ExactPaymentPayload {
  readonly x402Version: number;
  readonly resource: { readonly url: string };
  readonly accepted: PaymentRequirements;
  readonly payload: { readonly signature: string; readonly authorization: ExactAuthorization };
}

export interface SettleResponse {
  readonly success?: boolean;
  readonly transaction?: string;
  readonly network?: Network;
  readonly payer?: string;
  readonly amount?: string;
  readonly errorReason?: string;
}

export function utf8ToHex(text: string): string;
export function decodeJsonHeader(value: string): unknown;
export function encodeJsonHeader(value: unknown): string;
export function randomNonceHex(): string;
export function siweMessage(info: SignInChallenge, address: string): string;
export function challengeFrom(requirements: PaymentRequired): { info: SignInChallenge };
export function siwxHeaderValue(challenge: { info: SignInChallenge }, address: string, signature: string): string;
export function exactEip712Types(): Record<string, Eip712Field[]>;
export function buildExactPayment(input: {
  requirements: PaymentRequired;
  address: string;
  nowSeconds: number;
  nonce: string;
}): {
  authorization: ExactAuthorization;
  typedData: ExactTypedData;
  paymentPayload: ExactPaymentPayload;
};
export function frameFileName(index: number): string;
export function paidFrameUrl(reelId: string, index: number): string;
export function formatUnits(amountAtomic: string, decimals: number): string;
export function settlementSentence(mode: string, chainLabel: string): string;
export function networkLabel(network: Network): string;
export function decodeSettlementHeader(value: string | null | undefined): SettleResponse | null;
