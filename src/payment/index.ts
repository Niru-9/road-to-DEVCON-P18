/**
 * Assembling the payment layer: facilitator, routes, SIWX, settle hook, middleware.
 *
 * ## The order things are registered in, and why it is load-bearing
 *
 * ```
 *   1. facilitator        simulated stand-in, or the real HTTP facilitator
 *   2. scheme              ExactEvmScheme, registered for Ethereum Sepolia
 *   3. routes              one priced route per reel
 *   4. SIWX extension      registered, so the 402 carries a challenge
 *   5. onAfterSettle       the purchase recorder
 *   6. initialize()        validates routes against what the facilitator supports
 *   7. middleware          the Express handler Express actually runs
 * ```
 *
 * Steps 1-3 must precede step 4, because `x402HTTPResourceServer`'s constructor
 * validates every route's `accepts` against the registered schemes and throws if
 * a route names a scheme that is not registered. Step 6 must come after 4, because
 * a route that declares an extension which is not registered is a route whose
 * 402 silently omits its challenge.
 *
 * Step 5 is registered on the inner `x402ResourceServer` and therefore runs
 * *before* the SIWX extension's own settle hook. That is what makes the recorded
 * row the rich one; see src/payment/settle.ts.
 *
 * ## `initialize()` is not optional
 *
 * It calls `getSupported()` on the facilitator and then checks every route
 * against the result. A route for a network or scheme the facilitator cannot
 * handle is a 402 no client can ever satisfy, and the only place that is caught
 * before a viewer finds out is here. Skipping it would mean shipping a server
 * that boots happily and fails every payment.
 *
 * ## In testnet mode this talks to a real facilitator
 *
 * `HTTPFacilitatorClient` is constructed with the configured URL and nothing
 * else. In particular, **no private key is passed to it**, because there is no
 * server-side key in this design: the x402 `exact` scheme's *client* half signs
 * the payment, the facilitator verifies it, and the resource server's job is
 * only to state the requirement and record the result. Passing a key here would
 * have been cargo-culting from the client SDK, and it does not even typecheck -
 * `FacilitatorConfig` has no such field.
 *
 * `BIOSCOPE_PAYER_PRIVATE_KEY` is still read, validated and reported, because the
 * key a *paying client* needs is an operational fact an operator wants to see at
 * startup. See the note in `src/config.ts`.
 */

import { registerExactEvmScheme } from "@x402/evm/exact/server";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
} from "@x402/core/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import type { RequestHandler } from "express";

import { assertAssetMatchesUsdc, type BioscopeConfig } from "../config.js";
import type { ReelCatalog } from "../domain/reels.js";
import type { SqlitePurchaseStore } from "../db/purchase-store.js";
import { buildPaidFrameRoutes } from "./routes.js";
import { createPurchaseRecorder, type RecordedPurchaseSummary } from "./settle.js";
import { SimulatedFacilitator } from "./simulated-facilitator.js";
import { createBioscopeSIWx, type BioscopeSIWxStorage } from "./siwx.js";

export interface PaymentLayerOptions {
  readonly config: BioscopeConfig;
  readonly catalog: ReelCatalog;
  readonly ledger: SqlitePurchaseStore;
  /**
   * Notified once per successful settlement, for tests and diagnostics.
   *
   * Note what is *not* here: any way to replace the SIWX signature verifier. Up
   * to T4 this interface carried an optional `EVMMessageVerifier` so tests could
   * inject a deterministic stand-in for ECDSA recovery. T5 removed it, so the
   * verifier is the SDK's own viem-backed one for the application and for every
   * test alike. See the module comment in `siwx.ts`.
   */
  readonly onRecorded?: ((summary: RecordedPurchaseSummary) => void) | undefined;
}

export interface PaymentLayer {
  /** The Express middleware. Mount this *after* the pre-x402 gate. */
  readonly middleware: RequestHandler;
  /** Present only in `simulated` mode, so a test can assert what was settled. */
  readonly simulatedFacilitator: SimulatedFacilitator | null;
  /** The path-aware SIWX storage, for assertions about repeat access. */
  readonly siwxStorage: BioscopeSIWxStorage;
  /** The priced route table, for assertions about per-reel pricing. */
  readonly routes: Readonly<Record<string, unknown>>;
}

/** The scheme every Bioscope route uses. One scheme, one network, no ambiguity. */
export const BIOSCOPE_SCHEME = "exact";

function buildFacilitator(config: BioscopeConfig): {
  facilitator: FacilitatorClient;
  simulated: SimulatedFacilitator | null;
} {
  if (config.paymentMode === "simulated") {
    const simulated = new SimulatedFacilitator({ network: config.network, scheme: BIOSCOPE_SCHEME });
    return { facilitator: simulated, simulated };
  }

  // `config` has already been validated: in testnet mode the URL is present, or
  // the process never got here. The assertion is narrowing for the type system
  // rather than a runtime check that could be skipped, and it throws loudly
  // rather than silently building a facilitator with `undefined` in it.
  //
  // Note there is no private key here, and there is deliberately no
  // `createAuthHeaders` either. The x402 `exact` server scheme does not sign
  // anything: the *client* signs the payment, the facilitator verifies it, and
  // the server only has to know where the facilitator lives. See the module
  // comment on `BIOSCOPE_PAYER_PRIVATE_KEY`.
  if (config.facilitatorUrl === null) {
    throw new Error(
      "testnet payment mode was reached without a facilitator URL. This should be unreachable: " +
        "loadConfig refuses to start in that state.",
    );
  }

  return { facilitator: new HTTPFacilitatorClient({ url: config.facilitatorUrl }), simulated: null };
}

/**
 * Build the payment layer.
 *
 * @throws {Error} when the routes do not match what the facilitator supports. That
 * is a configuration bug, and it is better found at boot than by a viewer.
 */
export async function createPaymentLayer(options: PaymentLayerOptions): Promise<PaymentLayer> {
  const { config, catalog, ledger } = options;

  // Cheap, and it turns a silently mispriced server into a loud one.
  assertAssetMatchesUsdc();

  const { facilitator, simulated } = buildFacilitator(config);

  const resourceServer = new x402ResourceServer(facilitator);
  // Registers the V2 `exact` scheme for this one network. Naming the network
  // explicitly is the point: the helper's default is an `eip155:*` wildcard, and
  // a wildcard on a server holding real money is not a decision to make by
  // accident.
  registerExactEvmScheme(resourceServer, { networks: [config.network] });

  const siwx = createBioscopeSIWx({ config, catalog, ledger });
  resourceServer.registerExtension(siwx.extension);

  resourceServer.onAfterSettle(
    createPurchaseRecorder({
      ledger,
      catalog,
      settlementMode: config.paymentMode,
      ...(options.onRecorded === undefined ? {} : { onRecorded: options.onRecorded }),
    }),
  );

  const routes = buildPaidFrameRoutes(config, catalog);
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  // Must happen before the middleware is ever used. See the module comment.
  await httpServer.initialize();

  const middleware = paymentMiddlewareFromHTTPServer(httpServer, {
    appName: "P3 Bioscope",
    testnet: true,
  });

  return {
    middleware,
    simulatedFacilitator: simulated,
    siwxStorage: siwx.adapter,
    routes,
  };
}
