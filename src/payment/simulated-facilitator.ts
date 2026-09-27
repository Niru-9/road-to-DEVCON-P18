/**
 * A facilitator that settles nothing.
 *
 * ## Read this before believing a 402 from a default-configured server
 *
 * This class is the entire reason `BIOSCOPE_PAYMENT_MODE=simulated` is the
 * default, and it is a **protocol simulation, not a payment**. No chain is
 * contacted, no signature is checked, no coin moves. A demo that looks like it
 * takes payment but quietly does not is the single worst thing this project could
 * ship, so the simulation is loud rather than convenient:
 *
 * - The class name says `Simulated` in every log line and every error.
 * - Every transaction hash it returns is a SHA-256 of the payment, not a chain
 *   hash. It cannot be looked up on any explorer, which is the point.
 * - The health endpoint and every paid frame response carry
 *   `X-Bioscope-Settlement-Mode: simulated`, so a client cannot mistake one for
 *   the other even if it never read a word of documentation.
 * - Real testnet settlement goes through `HTTPFacilitatorClient` instead, and
 *   the config loader will not start in `testnet` mode without a URL, a
 *   recipient and a key.
 *
 * ## Why a hand-written facilitator is legitimate here at all
 *
 * The x402 server SDK does not verify or settle anything itself. `ExactEvmScheme`
 * on the server side parses a price, advertises payment requirements, and then
 * hands both `verify` and `settle` to a `FacilitatorClient`. So substituting one
 * is substituting the *only* component that touches a chain, and every other part
 * of the pipeline - the route matching, the 402, the `PAYMENT-SIGNATURE` header,
 * the requirement matching, the settle lifecycle, the after-settle hooks - is
 * the real SDK running for real.
 *
 * That is a much stronger test than stubbing the middleware would be. It is not
 * a licence to make the stub permissive, though: `verify` below still refuses a
 * payment with no identifiable payer, or one whose amount, asset, network or
 * recipient disagrees with what the server advertised. A stub that accepted
 * anything would let a test pass against a server that would reject a real
 * client's payment.
 */

import { createHash } from "node:crypto";

import type { FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

import { isWalletAddress } from "../domain/wallet.js";

/** Prefixed on every message this facilitator produces. */
const SIMULATED = "[simulated facilitator]";

export interface SimulatedFacilitatorOptions {
  /** The only network this stand-in will claim to support. */
  readonly network: Network;
  /** The only scheme it will claim to support. */
  readonly scheme?: string;
}

export interface SimulatedSettlement {
  readonly resource: string;
  readonly payer: string;
  readonly amount: string;
  readonly asset: string;
  readonly network: Network;
  readonly payTo: string;
  /** The fake hash returned to the client. */
  readonly transaction: string;
}

/**
 * Pull the paying address out of an `exact` scheme payment payload.
 *
 * Handles both transfer methods the server scheme advertises: EIP-3009
 * (`authorization.from`, the default) and Permit2 (`permit2Authorization.from`).
 * Returns `null` when neither is present or the value is not an address, which
 * the caller turns into a rejection.
 */
export function payerFromPaymentPayload(payload: Record<string, unknown> | undefined): string | null {
  if (payload === undefined || payload === null || typeof payload !== "object") {
    return null;
  }
  const candidates: unknown[] = [
    (payload as { authorization?: { from?: unknown } }).authorization?.from,
    (payload as { permit2Authorization?: { from?: unknown } }).permit2Authorization?.from,
  ];
  for (const candidate of candidates) {
    if (isWalletAddress(candidate)) {
      return candidate.toLowerCase();
    }
  }
  return null;
}

/** The resource the payment was made against, or `""` when the client omitted it. */
function resourceOf(payload: PaymentPayload): string {
  return payload.resource?.url ?? "";
}

/**
 * What a real facilitator would check first: does this payment agree with what
 * the server asked for? Shared by `verify` and `settle` so the two cannot drift.
 */
function disagreement(
  requirements: PaymentRequirements,
  expectedNetwork: Network,
  expectedScheme: string,
  payer: string | null,
): string | null {
  if (requirements.network !== expectedNetwork) {
    return `payment names network ${requirements.network}, this facilitator only speaks ${expectedNetwork}`;
  }
  if (requirements.scheme !== expectedScheme) {
    return `payment names scheme ${requirements.scheme}, this facilitator only speaks ${expectedScheme}`;
  }
  if (!isWalletAddress(requirements.payTo)) {
    return `the server advertised a payTo that is not an address: ${String(requirements.payTo)}`;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(requirements.amount)) {
    return `the server advertised a non-canonical amount: ${JSON.stringify(requirements.amount)}`;
  }
  if (typeof requirements.asset !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(requirements.asset)) {
    return `the server advertised an asset that is not an address: ${String(requirements.asset)}`;
  }
  if (payer === null) {
    return "the payment carries no recognizable payer address";
  }
  return null;
}

/**
 * A deterministic, chain-free transaction hash.
 *
 * SHA-256 over a canonical rendering of the settlement, so the same payment
 * always produces the same string and two different payments never collide. The
 * result is prefixed with a 32-byte zero word: it has the shape of a hash, it
 * will not resolve on any block explorer, and nothing downstream can mistake it
 * for a real Ethereum Sepolia transaction.
 */
function simulatedTransactionHash(input: {
  resource: string;
  payer: string;
  amount: string;
  asset: string;
  network: Network;
  payTo: string;
}): string {
  const canonical = [
    "bioscope-simulated-settlement-v1",
    input.network,
    input.resource,
    input.payer,
    input.payTo,
    input.asset.toLowerCase(),
    input.amount,
  ].join("|");
  return `0x${"0".repeat(64)}${createHash("sha256").update(canonical).digest("hex")}`;
}

export class SimulatedFacilitator implements FacilitatorClient {
  /** Only network/scheme this stand-in claims. */
  readonly network: Network;
  readonly scheme: string;

  /** Every payment this facilitator was asked to verify or settle, in order. */
  readonly settlements: SimulatedSettlement[] = [];

  #verifyCalls = 0;
  #settleCalls = 0;

  public constructor(options: SimulatedFacilitatorOptions) {
    this.network = options.network;
    this.scheme = options.scheme ?? "exact";
  }

  public get verifyCalls(): number {
    return this.#verifyCalls;
  }

  public get settleCalls(): number {
    return this.#settleCalls;
  }

  /**
   * Advertise exactly one kind: `exact` on our one network, at protocol version 2.
   *
   * `x402ResourceServer.initialize()` validates every route against this, so
   * understating it here is what makes a misconfigured route fail loudly at boot
   * instead of at the first unlock attempt.
   */
  public async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: this.scheme, network: this.network }],
      extensions: [],
      signers: {},
    };
  }

  public async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.#verifyCalls += 1;
    const payer = payerFromPaymentPayload(paymentPayload.payload);
    const problem = disagreement(paymentRequirements, this.network, this.scheme, payer);

    if (problem !== null) {
      return {
        isValid: false,
        invalidReason: "simulated_facilitator_rejected",
        invalidMessage: `${SIMULATED} ${problem}. No signature was checked and no funds would move.`,
      };
    }

    // A real facilitator would recover the signer from an EIP-712 signature here
    // and reject any mismatch. There is no signature to check, so the only
    // honest statement is that we took the payload's word for the payer - and
    // the settle hook below records that exact address as the payer.
    return { isValid: true, payer: payer as string };
  }

  public async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.#settleCalls += 1;
    const payer = payerFromPaymentPayload(paymentPayload.payload);
    const problem = disagreement(paymentRequirements, this.network, this.scheme, payer);

    if (problem !== null) {
      return {
        success: false,
        errorReason: "simulated_facilitator_rejected",
        errorMessage: `${SIMULATED} ${problem}. Nothing was settled.`,
        transaction: "",
        network: this.network,
      };
    }

    const transaction = simulatedTransactionHash({
      resource: resourceOf(paymentPayload),
      payer: payer as string,
      amount: paymentRequirements.amount,
      asset: paymentRequirements.asset,
      network: this.network,
      payTo: paymentRequirements.payTo,
    });

    this.settlements.push({
      resource: resourceOf(paymentPayload),
      payer: payer as string,
      amount: paymentRequirements.amount,
      asset: paymentRequirements.asset,
      network: this.network,
      payTo: paymentRequirements.payTo,
      transaction,
    });

    return {
      success: true,
      payer: payer as string,
      transaction,
      network: this.network,
      // `exact` settles the advertised amount. Carried so the settle hook can
      // record what was actually taken rather than what was asked for.
      amount: paymentRequirements.amount,
    };
  }
}
