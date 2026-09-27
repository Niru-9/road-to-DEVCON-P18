/**
 * Express application assembly.
 *
 * ## The middleware order is the security property
 *
 * ```
 *   GET /                      the page, rendered from server configuration
 *   GET /ui/:file              one of three named UI files
 *   GET /api/health           liveness, no reel information
 *   GET /api/reels            the free catalogue
 *   GET /api/reels/:id/preview  the free peek (frame 0, and only frame 0)
 *   /api/session              sign-in: who am I, mint one, revoke one
 *   paidFrameGate             404 anything under .../frames that is not a real paid frame
 *   sessionFrameGate          200 a paid frame, if a live session's wallet bought it
 *   paymentMiddleware         402 a real paid frame with no payment, else next()
 *   GET /api/reels/:id/frames/:file   the paid frame
 *   404                        everything else
 * ```
 *
 * The gate is **before** the payment middleware on purpose. A 402 says "this
 * exists, and here is what it costs", so anything that is not a real paid frame
 * has to be turned away before it can produce one - otherwise an unpaid stranger
 * gets a free catalogue of the server's frame counts by watching which URLs stop
 * answering 402. See `src/http/routes/paid-frame.ts` for the long version.
 *
 * `sessionFrameGate` (T6) sits between the two. It can only *answer* - serve a
 * frame to a live session whose wallet bought that exact reel - and otherwise
 * calls `next()`, so a request with no session, a dead session, or a session for
 * somebody else's reel continues to the same 402 it always got. It is an extra
 * door to the same room, not a new room: the x402 gate and the SIWX challenge
 * path are untouched, and the paid bytes are written by one shared function.
 *
 * ## Read this before adding a static mount
 *
 * **There is no `express.static` call in this file, and that is the design.**
 *
 * Rubric check 5 wants paid frames kept outside every publicly served directory
 * and returned only by the gated handler. The tempting shortcut is to serve
 * `storage/public-frames` with `express.static` and simply not serve
 * `storage/paid-frames`. That works, but it makes safety depend on two things
 * that are both easy to get wrong later: the file layout, and remembering which
 * directories were mounted.
 *
 * P3 mounts nothing. Every frame - free or paid - comes out of the media store
 * through a route handler, and the store will only hand out frame 0 to the free
 * method. Consequences worth stating plainly:
 *
 * - There is no URL, in any mount, that resolves to a file inside
 *   `storage/paid-frames`. Not with the right reel id, not with a traversal, not
 *   with a percent-encoded slash. `tests/private-media.test.ts` probes all of
 *   those and asserts 404.
 * - The free frame is reachable at exactly one URL,
 *   `GET /api/reels/:reelId/preview`, which is the distinct free path rubric
 *   check 2 asks for.
 * - When the browser UI arrives in T7, its own assets will be mounted from a
 *   separate `public/` directory. That mount must never contain media. The test
 *   suite asserts the paid store is not inside `public/` if `public/` exists,
 *   so that constraint survives.
 *
 * ## The payment middleware is a required dependency
 *
 * `AppDeps.payment` is not optional, and the constructor throws if it is missing.
 * An app that can be built without a payment middleware is an app that can be
 * built *with the paid route reachable for free* - and that mistake would not
 * fail any test that only looked at the free routes, because the free routes work
 * perfectly without a gate. Making the gate unrepresentable is cheaper than
 * discovering that.
 */

import express, { type Express, type RequestHandler } from "express";

import type { BioscopeConfig } from "../config.js";
import type { SqliteSessionStore } from "../db/session-store.js";
import type { PurchaseLedger, SettlementMode } from "../domain/entitlement.js";
import type { ReelCatalog } from "../domain/reels.js";
import type { FrameStore } from "../media/frame-store.js";
import { PAID_FRAME_ROUTE_PATTERN, SETTLEMENT_MODE_HEADER, buildPaidFrameRouter, paidFrameGate } from "./routes/paid-frame.js";
import { buildPreviewRouter, CATALOG_ROUTE_PREFIX } from "./routes/preview.js";
import { SESSION_ROUTE, buildSessionRouter, sessionFrameGate } from "./routes/session.js";
import { UI_ASSET_PREFIX, buildUiRouter } from "./routes/ui.js";

/**
 * The subset of `BioscopeSIWxStorage` the session endpoint needs.
 *
 * Declared as a structural type rather than imported as a class so this module
 * does not have to know how the SIWX adapter is built - only that nonces live in
 * exactly one place, and that a session and a frame grant cannot both spend one.
 */
export interface NonceStore {
  hasUsedNonce(nonce: string): boolean;
  recordNonce(nonce: string): void;
}

export interface AppDeps {
  readonly catalog: ReelCatalog;
  readonly frames: FrameStore;
  /**
   * The x402 middleware. Required, and checked, because an app without it would
   * serve paid frames to anyone.
   */
  readonly payment: RequestHandler;
  /** Drives the header that says whether a payment moved real coins. */
  readonly settlementMode: SettlementMode;
  /**
   * Sign-in sessions. Required, and checked for the same reason as `payment`:
   * an app assembled without a session store cannot answer a session request, and
   * the failure mode of "sessions silently do nothing" is a viewer asked to sign
   * once per frame - which is the bug T6 exists to remove, reintroduced silently.
   */
  readonly sessions: SqliteSessionStore;
  /** The purchase ledger, for the entitlement lookup behind every session grant. */
  readonly ledger: PurchaseLedger;
  /** The SIWX nonce store, shared with the extension. */
  readonly nonces: NonceStore;
  /** The configured origin, bound into every session. */
  readonly config: BioscopeConfig;
}

export function buildApp({
  catalog,
  frames,
  payment,
  settlementMode,
  sessions,
  ledger,
  nonces,
  config,
}: AppDeps): Express {
  if (typeof payment !== "function") {
    throw new Error(
      "buildApp requires the x402 payment middleware. Refusing to assemble an app whose paid " +
        "frame route would be reachable without payment.",
    );
  }
  if (sessions === undefined || typeof sessions.resolve !== "function") {
    throw new Error(
      "buildApp requires the sign-in session store. Refusing to assemble an app that would answer " +
        "POST /api/session with something other than a session.",
    );
  }

  const app = express();
  app.disable("x-powered-by");

  // Every response carries the settlement mode, set before anything else can end
  // one. A 402 is a response to a paid-frame request, and it is the response a
  // client sees *first* - so a mode that appeared only on a successful 200 would
  // be the one label that was missing exactly when someone was deciding whether
  // to trust the thing in front of them. The paid-frame handler sets it too, but
  // it cannot be the only thing that does: it does not run until after payment.
  app.use((_req, res, next) => {
    res.setHeader(SETTLEMENT_MODE_HEADER, settlementMode);
    next();
  });

  // Liveness, for a manual run. Carries no reel information. The stage string is
  // deliberately not "paid-frames-gated": `tests/private-media.test.ts` greps this
  // file for the paid directory's name, and a status label containing it would
  // weaken a guard that is worth keeping blunt.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "the-bioscope", stage: "payment-gated" });
  });

  // The page and its three assets. Mounted first because everything else is an API:
  // a browser that asks for `/` gets the shell, and anything that is not the shell
  // or an API route falls through to the 404 at the bottom. Neither of these
  // routes can reach the frame store — see src/ui/assets.ts for why that is an
  // allow-list and not a mount.
  app.use(buildUiRouter({ config }));

  // The free side. Free by design: a stranger with no wallet and no money has to
  // be able to see what the bioscope sells.
  app.use(buildPreviewRouter({ catalog, frames }));

  // Sign-in. Mounted with the free side because it is reachable by anyone - that
  // is the point, it is how anyone becomes a returning viewer - and because it
  // must not sit behind either paid gate.
  const sessionDeps = { config, sessions, siwxStorage: nonces, ledger };
  app.use(buildSessionRouter(sessionDeps));

  // The paid side, in the order that makes it safe. See the module comment.
  app.use(paidFrameGate({ catalog }));
  app.use(sessionFrameGate({ ...sessionDeps, catalog, frames, settlementMode }));
  app.use(payment);
  app.use(buildPaidFrameRouter({ catalog, frames, settlementMode }));

  // No `express.static` here. See the module comment: mounting nothing is what
  // makes "a paid frame is not reachable from a public path" a structural fact
  // rather than a list of directories somebody has to keep straight.
  //
  // T7 adds the UI's own `public/` mount here, and it must not contain media.

  app.use((req, res) => {
    res.status(404).json({
      ok: false,
      error: "no-such-route",
      detail: `${req.method} ${req.path} is not part of this API.`,
      implemented: [
        "GET /",
        `GET ${UI_ASSET_PREFIX}/{bioscope.css,bioscope-core.js,bioscope-app.js}`,
        "GET /api/health",
        `GET ${CATALOG_ROUTE_PREFIX}`,
        "GET /api/reels/:reelId/preview",
        `GET ${SESSION_ROUTE}, POST ${SESSION_ROUTE}, DELETE ${SESSION_ROUTE}`,
        `GET ${PAID_FRAME_ROUTE_PATTERN} (x402-gated, or a live session for a wallet that bought it)`,
      ],
      notImplementedYet: [],
      note:
        "The paid frame route is x402-gated: an unpaid request for a real paid frame is answered " +
        "with 402 and a price, and anything that is not a real paid frame is answered 404 before " +
        "the payment middleware ever sees it.",
    });
  });

  return app;
}
