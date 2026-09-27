/**
 * The x402 route table: one priced, protected route per reel.
 *
 * ## Why one route per reel and not a wildcard
 *
 * The obvious cheap design is a single `GET /api/reels/:reelId/frames/*` route
 * with one price. It is wrong, and it is wrong in a way that is invisible until
 * someone has paid: the x402 `resource` is what an unlock is recorded against, so
 * a shared route means one payment grants every reel. That is the "pay once, watch
 * everything" failure this project exists to avoid.
 *
 * So `buildPaidFrameRoutes` emits one entry per catalog reel, each with:
 *
 * - a pattern that pins the reel id (`/api/reels/calcutta-tram/frames/*`),
 * - a `resource` URL that names *that* reel's unlock,
 * - that reel's own price.
 *
 * A reel added to the catalog is protected the moment the server restarts, and a
 * reel removed from it is no longer sellable. The price is read from the catalog
 * rather than from configuration, so a route can never quote a different amount
 * from the one the ledger records.
 *
 * ## Why the resource is an absolute URL
 *
 * `RouteConfig.resource` looks like it could be a path, and for a plain x402 route
 * it can. Two things in this stack insist on an absolute URL:
 *
 * - the Sign-In-With-X enrichment does `new URL(resourceUrl)` when it rebases the
 *   challenge onto the server origin, and
 * - the SIWX settle hook does `new URL(resourceUrl).pathname` to decide which
 *   resource a settlement bought.
 *
 * So the resource is built as `<origin>/reels/<reelId>/unlock`. The path half is
 * exactly what `reelUnlockResource` produces and exactly what
 * `reelIdFromResource` parses back, which means the round trip
 * resource -> settlement -> reel id is total and unambiguous.
 *
 * ## `price.extra` carries the EIP-712 domain, and has to
 *
 * Found in T7, and worth writing down because it looks optional and is not. An
 * x402 `exact` payment is authorised by an EIP-712 signature over a
 * `TransferWithAuthorization`, and the signed domain includes the token's `name`
 * and `version`. `@x402/evm`'s client refuses to build a payment without them:
 *
 * ```
 * Error: EIP-712 domain parameters (name, version) are required in payment
 * requirements for asset 0x036CbD...
 * ```
 *
 * A route that omits them therefore produces a 402 that the reference client
 * cannot answer - the server looks like it takes payment and no conforming wallet
 * can pay it. The values come from the SDK's own asset table, and
 * `eip712DomainFor` refuses to build a route if that table and `config.asset` ever
 * disagree.
 */

import { declareSIWxExtension } from "@x402/extensions/sign-in-with-x";
import type { RouteConfig } from "@x402/core/server";

import { ETHEREUM_SEPOLIA_USDC, ETHEREUM_SEPOLIA_USDC_NAME, ETHEREUM_SEPOLIA_USDC_VERSION, payToFor, type BioscopeConfig } from "../config.js";
import { isSafeReelId, reelUnlockResource } from "../domain/reel-resource.js";
import type { ReelCatalog } from "../domain/reels.js";

/** Extension key the SDK uses. Re-exported so callers never hard-code the string. */
export const SIGN_IN_WITH_X = "sign-in-with-x";

/** Where paid frames live. Shared with the pre-x402 gate and the Express route. */
export const PAID_FRAME_PREFIX = "/api/reels/";
export const PAID_FRAME_FRAMES_SEGMENT = "/frames/";

/**
 * The x402 route pattern for one reel's paid frames.
 *
 * The trailing `*` is what the SDK's own `parseRoutePattern` turns into
 * "and anything after this", so one route covers every frame index of that reel
 * while still pinning the reel id to a single path segment.
 */
export function paidFrameRoutePattern(reelId: string): string {
  if (!isSafeReelId(reelId)) {
    throw new Error(`Cannot build a payment route for an unsafe reel id: ${JSON.stringify(reelId)}`);
  }
  return `GET ${PAID_FRAME_PREFIX}${reelId}${PAID_FRAME_FRAMES_SEGMENT}*`;
}

/** Absolute URL of a reel's unlock, used as the x402 `resource`. */
export function paidFrameResourceUrl(origin: string, reelId: string): string {
  return new URL(reelUnlockResource(reelId), origin).toString();
}

/**
 * The human-readable reason a 402 happened, returned in the 402 body.
 *
 * The SDK's default body is `{}` and the authoritative requirements live in the
 * `PAYMENT-REQUIRED` header. That is the right protocol; it is a poor API for a
 * developer with `curl` open. So the body is replaced with something that says
 * what happened and points at the header, and carries the settlement mode so
 * nobody can mistake a simulated unlock for a real one.
 */
function unpaidBody(config: BioscopeConfig) {
  return (_context: unknown): { contentType: string; body: Record<string, unknown> } => ({
    contentType: "application/json",
    body: {
      error: "payment_required",
      message:
        "This frame is part of a paid reel. Pay with x402 to unlock it; the machine-readable " +
        "requirements are in the PAYMENT-REQUIRED response header.",
      settlementMode: config.paymentMode,
      readMore:
        config.paymentMode === "simulated"
          ? "This server is in simulated mode: no chain is contacted and no funds move."
          : "This server settles real test USDC on Ethereum Sepolia.",
    },
  });
}

/**
 * Build the protected route table.
 *
 * @returns keyed by the SDK's `"<VERB> <pattern>"` route pattern, one entry per
 * reel. Empty when the catalog is empty, which the resource server treats as "no
 * protected routes" rather than as an error.
 */
export function buildPaidFrameRoutes(config: BioscopeConfig, catalog: ReelCatalog): Record<string, RouteConfig> {
  const routes: Record<string, RouteConfig> = {};
  const payTo = payToFor(config);
  const eip712Domain = eip712DomainFor(config);

  for (const reel of catalog.list()) {
    routes[paidFrameRoutePattern(reel.id)] = {
      resource: paidFrameResourceUrl(config.origin, reel.id),
      description: `Unlock every paid frame of "${reel.title}".`,
      mimeType: "image/svg+xml",
      // Declared so the SDK attaches a Sign-In-With-X challenge to this 402. A
      // viewer who has already paid can present a signed challenge and be let
      // straight through instead of being asked to pay a second time - see
      // src/payment/siwx.ts for how the path is resolved to a reel.
      //
      // `declareSIWxExtension` is used rather than a bare `{}` because it carries
      // the options the SDK reads back when it builds the challenge: the
      // expiration window and the chain to advertise. `expirationSeconds` comes
      // from configuration rather than a literal so a demo can be given a shorter
      // window without a code change.
      extensions: declareSIWxExtension({
        statement: "Sign in to watch the paid frames of this reel. Signing proves which wallet you are; it costs no x402 payment.",
        expirationSeconds: config.siwxExpirationSeconds,
        network: config.network,
      }),
      accepts: {
        scheme: "exact",
        network: config.network,
        payTo,
        price: {
          asset: config.asset,
          amount: reel.priceAtomic,
          // The EIP-712 domain the client signs against. Found in T7, and it is not
          // optional: `@x402/evm`'s client throws
          //
          //   "EIP-712 domain parameters (name, version) are required in payment
          //    requirements for asset ..."
          //
          // without them, so a 402 built this way could not be paid by *any*
          // conforming x402 client - only by one that hard-codes which token it is
          // about to authorise. Read from the SDK's own asset table rather than
          // written out here, so a token rename cannot leave a stale domain behind.
          extra: eip712Domain,
        },
        maxTimeoutSeconds: config.maxTimeoutSeconds,
      },
      unpaidResponseBody: unpaidBody(config),
    };
  }

  return routes;
}

/**
 * `{ name, version }` for the asset this server charges in.
 *
 * From this project's declared constants rather than the SDK's default-asset
 * table, which has no Ethereum Sepolia entry — `getDefaultAsset` throws for
 * `eip155:11155111`. The address and domain were read from the token contract.
 * The cross-check that remains is the one that matters: the domain must belong
 * to the token this server actually charges in.
 */
function eip712DomainFor(config: BioscopeConfig): { name: string; version: string } {
  if (ETHEREUM_SEPOLIA_USDC.toLowerCase() !== config.asset.toLowerCase()) {
    throw new Error(
      `The EIP-712 domain this server signs against belongs to ${ETHEREUM_SEPOLIA_USDC}, but ` +
        `this server charges in ${config.asset}. A client would sign a domain for one token and ` +
        `be charged in another.`,
    );
  }
  return { name: ETHEREUM_SEPOLIA_USDC_NAME, version: ETHEREUM_SEPOLIA_USDC_VERSION };
}
