/**
 * The paid side of the bioscope: one x402-gated route, and the gate in front of it.
 *
 * ## The shape of the request
 *
 * `GET /api/reels/:reelId/frames/frame-003.svg`
 *
 * The filename is the *canonical* one from `src/media/frame-paths.ts`, zero padded
 * to three digits, and it is the only spelling accepted. `frame-3.svg`,
 * `frame-0030.svg` and `frame-0003.svg` are all refused. The reason is the same
 * reason `src/domain/amount.ts` accepts exactly one spelling of an amount: six
 * spellings of one frame is six chances to serve the wrong file, and a URL that
 * means two things is a URL that can be used to ask "which of these is it?".
 *
 * ## Why there is a gate *before* the payment middleware
 *
 * This is the part that is easy to get wrong. The obvious implementation is
 * `app.get(paidRoute, paymentMiddleware, handler)`, and it is wrong in a way that
 * leaks information and charges for nothing.
 *
 * A 402 is a statement about a *product*: "this exists, it costs this much". If
 * an unknown reel id, or frame `0`, or frame `9999` of a twenty-four-frame reel,
 * all produce a 402, then the payment middleware has become a free oracle. Anyone
 * can enumerate the catalog, learn each reel's exact frame count by watching which
 * indices stop answering 402, and never pay anything.
 *
 * So validation runs **first**, and an invalid request never reaches x402:
 *
 * ```
 *   gate          reject with 404, no PAYMENT-REQUIRED header, no price
 *   middleware    402 with a price, or next() if payment was good
 *   handler       read the frame, serve it privately
 * ```
 *
 * A valid-but-unpaid request is the only thing that gets a 402, and every 402
 * corresponds to a frame that genuinely exists and genuinely costs something.
 *
 * ## Why the gate answers 404 for everything
 *
 * Not 400, not 403. The existing `sendMediaError` mapping is finer-grained, and
 * it is the right mapping for a caller who has already paid. Before payment,
 * `invalid-frame-index -> 400` versus `frame-outside-scope -> 403` is a difference
 * in status code that says "the reel is real and the frame is merely out of
 * range" - a free frame-count oracle, handed to a stranger. So both the gate and
 * the handler resolve the frame through the *same* function and answer 404
 * uniformly. They cannot drift, because there is one implementation.
 *
 * ## No static mount, ever
 *
 * There is no `express.static` in this server, and this handler is the only thing
 * that can read `paid-frames/`. The catalogue hands an unpaid viewer a
 * `previewUrl` and no other frame URL, so there is nothing in the catalogue to
 * leak and nothing in the browser to guess at.
 *
 * ## Two ways in, one way to the bytes (T6)
 *
 * ```
 *   paidFrameGate         404 anything that is not a real paid frame
 *   sessionFrameGate      200 the frame, if a live session's wallet bought it
 *   paymentMiddleware     402 a real paid frame with no payment, else next()
 *   GET .../:file         the paid frame
 * ```
 *
 * The session gate was added in T6 so a returning viewer is not asked to sign once
 * per frame. It sits between the two above and below the x402 middleware, and it
 * only ever *answers* when it has both a live session and a ledger row for the
 * exact reel being requested - otherwise it calls `next()` and the request
 * continues to the 402, unchanged. A session that cannot buy anything is
 * indistinguishable, from the outside, from having no session at all.
 */

import { Router, type NextFunction, type Request, type Response } from "express";

import type { SettlementMode } from "../../domain/entitlement.js";
import type { ReelCatalog } from "../../domain/reels.js";
import { MediaError, frameFileName, parseFrameIndex } from "../../media/frame-paths.js";
import { PREVIEW_FRAME_INDEX } from "../../media/frame-paths.js";
import type { FrameStore } from "../../media/frame-store.js";
import { FRAME_INDEX_HEADER, FRAME_KIND_HEADER } from "./preview.js";

/** The path every paid frame is served from. */
export const PAID_FRAME_ROUTE_PATTERN = "/api/reels/:reelId/frames/:file";

/**
 * Header naming whether a payment moved real coins.
 *
 * Set on **every** response by `src/http/app.ts`, before any handler runs, because
 * the response that matters most to a nervous client is the 402 - the one that
 * arrives before they have paid anything. The paid-frame handler sets it as well,
 * but by then the payment middleware has already answered for the requests that
 * were not paid for.
 */
export const SETTLEMENT_MODE_HEADER = "X-Bioscope-Settlement-Mode";

/**
 * Anything under `/api/reels/<id>/frames` is addressing the paid area.
 *
 * The trailing group is deliberately loose - `/api/reels/x/frames`,
 * `/api/reels/x/frames/1.svg` and `/api/reels/x/frames/1.svg/extra` all match -
 * because the x402 route pattern ends in `/*` and would happily charge for all
 * three. Catching the loose shape here is what makes "charged for something that
 * does not exist" impossible.
 *
 * It does **not** match `/api/reels/x/preview`: the `frames` segment is required,
 * so the free preview route can never be caught by this.
 */
const PAID_AREA_PATTERN = /^\/api\/reels\/([^/]+)\/frames(?:\/(.*))?$/;

/** Why a paid-frame request was refused. Not surfaced to the caller. */
export type PaidFrameRefusal =
  | "unknown-reel"
  | "malformed-frame-name"
  | "preview-frame-is-free"
  | "out-of-range";

export type PaidFrameResolution =
  | { readonly ok: true; readonly reelId: string; readonly index: number }
  | { readonly ok: false; readonly reason: PaidFrameRefusal };

/**
 * The canonical frame index in a filename, or `null`.
 *
 * Accepts exactly the string `frameFileName` would produce for some index. The
 * round trip at the end is what makes that true: the parsed index is re-formatted
 * and compared against the input, so no alternative spelling survives even when it
 * is all digits.
 */
export function indexFromFrameFile(file: unknown): number | null {
  if (typeof file !== "string") {
    return null;
  }
  const match = /^frame-([0-9]+)\.svg$/.exec(file);
  if (match === null) {
    return null;
  }
  // Strip the padding so the value is canonical *as a number*, then insist the
  // canonical rendering is byte-identical to what the caller asked for. That one
  // comparison is what rejects "3", "03" and "0003".
  const index = parseFrameIndex(match[1]?.replace(/^0+(?=[0-9])/, "") ?? "");
  if (index === null) {
    return null;
  }
  return frameFileName(index) === file ? index : null;
}

/**
 * Resolve a paid-frame request against the catalog.
 *
 * Pure, total, and the *only* place that decides whether a paid-frame request is
 * well-formed. Both the pre-payment gate and the post-payment handler call it, so
 * the two stages cannot answer differently.
 *
 * Fails closed, in an order that never leaks: an unknown reel is refused before
 * the frame name is looked at, so a bad reel id never depends on the frame being
 * valid.
 */
export function resolvePaidFrame(
  catalog: ReelCatalog,
  reelId: unknown,
  file: unknown,
): PaidFrameResolution {
  if (typeof reelId !== "string" || !catalog.has(reelId)) {
    return { ok: false, reason: "unknown-reel" };
  }

  const index = indexFromFrameFile(file);
  if (index === null) {
    return { ok: false, reason: "malformed-frame-name" };
  }

  // Frame 0 is the free peek. Serving it here would mean the paid route handing
  // out something the free route already gives away - and it would let someone
  // "unlock" a reel by paying for a frame that costs nothing.
  if (index === PREVIEW_FRAME_INDEX) {
    return { ok: false, reason: "preview-frame-is-free" };
  }

  const reel = catalog.get(reelId);
  if (reel === null || index >= reel.frames.length) {
    return { ok: false, reason: "out-of-range" };
  }

  return { ok: true, reelId, index };
}

/**
 * The 404 body, identical for every refusal.
 *
 * The whole point of the uniform status code is that the body has to match it. A
 * helpful "that reel has 24 frames" would undo the gate.
 */
function sendPaidFrameNotFound(res: Response): void {
  res.status(404).json({
    ok: false,
    error: "no-such-frame",
    detail: "No such frame. See GET /api/reels for the catalog, and /preview for each reel's free frame.",
  });
}

/** The reel id and the single file segment of a request under the paid area. */
export function paidAreaOf(
  path: string,
): { readonly reelId: string; readonly file: string | null } | null {
  const match = PAID_AREA_PATTERN.exec(path);
  if (match === null) {
    return null;
  }
  const rest = match[2];
  // `/api/reels/x/frames` has no file at all, and `/api/reels/x/frames/1.svg/x`
  // has more than one. Both are malformed, and neither names a frame.
  const file = rest === undefined || rest === "" || rest.includes("/") ? null : rest;
  return { reelId: match[1] ?? "", file };
}

export interface PaidFrameGateDeps {
  readonly catalog: ReelCatalog;
}

/**
 * The middleware that runs before x402.
 *
 * Mount this immediately before the payment middleware. Its only job is to make
 * sure a 402 can only ever be produced by a request for a frame that exists.
 */
export function paidFrameGate({ catalog }: PaidFrameGateDeps) {
  return function gate(req: Request, res: Response, next: NextFunction): void {
    // Anything that is not a read of a frame falls through untouched. An
    // unsupported method on a paid path then behaves like it does everywhere else
    // in the app, instead of acquiring a special answer here.
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const area = paidAreaOf(req.path);
    if (area === null) {
      // Not the paid area at all. The free catalog and preview routes land here.
      next();
      return;
    }

    if (area.file === null || !resolvePaidFrame(catalog, area.reelId, area.file).ok) {
      sendPaidFrameNotFound(res);
      return;
    }

    next();
  };
}

export interface PaidFrameRouterDeps {
  readonly catalog: ReelCatalog;
  readonly frames: FrameStore;
  readonly settlementMode: SettlementMode;
}

/**
 * Write a paid frame to the response.
 *
 * ## Why this is a function and not the handler
 *
 * As of T6 there are **two** ways a request reaches a paid frame's bytes, and
 * they must be indistinguishable:
 *
 * - the x402 path: the payment middleware called `next()`, or the SIWX extension
 *   granted access on a verified challenge;
 * - the session path: a live session for a wallet that has bought *this* reel, so
 *   the request never needs a second signature (`src/http/routes/session.ts`).
 *
 * If each had its own copy of the header block, the two would drift - and the
 * drift that matters is the security-relevant kind: a session-served frame that
 * quietly lost `Cache-Control: private, no-store` would be a paid frame in a
 * shared cache. So there is one implementation, called from both, and it is the
 * only code in the project that writes paid bytes to a response.
 *
 * @param resolution a frame the caller has already resolved and authorized. The
 * function does not re-check entitlement, because "authorized" is the caller's
 * whole job and mixing the two would make the audit harder, not easier.
 */
export async function servePaidFrame(
  res: Response,
  frames: FrameStore,
  resolution: { readonly reelId: string; readonly index: number },
  settlementMode: SettlementMode,
): Promise<void> {
  const frame = await frames.readPaidFrame(resolution.reelId, resolution.index);

  // Private, never cached, never stored. A paid frame is a paid frame, and a
  // shared cache that kept one would hand it to the next person to ask.
  res.setHeader("Content-Type", frame.contentType);
  res.setHeader("Content-Length", String(frame.byteLength));
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Says out loud, on every paid response, whether a chain was involved.
  res.setHeader(SETTLEMENT_MODE_HEADER, settlementMode);
  res.setHeader(FRAME_INDEX_HEADER, String(frame.index));
  res.setHeader(FRAME_KIND_HEADER, frame.kind);

  // ETag deliberately omitted. A validator would let a revalidation succeed with
  // 304, and a 304 to an unpaid caller is a way to observe that a frame exists
  // without paying for it.
  res.status(200).end(frame.bytes);
}

/**
 * Map a media failure onto a response. Returns `false` for anything that is not
 * one, so the caller can hand it to `next` instead.
 *
 * Shared with the session gate in `session.ts` for the reason `servePaidFrame` is:
 * a missing paid file is an answer both paths must give identically, and it is
 * exactly the case where a copy of the handling would be a copy of the bug.
 */
export function respondToFrameError(res: Response, error: unknown): boolean {
  if (!(error instanceof MediaError)) {
    return false;
  }
  // A missing file for a frame the catalog promises is a real bug, and the shared
  // mapping is honest about it: 404 for absent, 500 for a violation.
  res
    .status(error.code === "media-layout-violation" ? 500 : 404)
    .json({ ok: false, error: error.code, detail: error.message });
  return true;
}

/**
 * The paid frame handler.
 *
 * Reached only after the payment middleware has called `next()`, which means only
 * for a request that carried a valid payment, presented a valid Sign-In-With-X
 * challenge for a reel this wallet already owns, or arrived with a live session
 * for a wallet that has bought this reel (in which case the session gate in front
 * would normally have answered it already, and this is the belt to that braces).
 *
 * It re-resolves the frame rather than trusting that the gate ran. The gate and
 * this share one resolver, so the re-check cannot disagree - it is there so that
 * swapping the two middlewares by accident produces a 404 rather than a paid frame
 * handed to someone who did not pay.
 */
export function buildPaidFrameHandler({ catalog, frames, settlementMode }: PaidFrameRouterDeps) {
  return async function paidFrame(req: Request, res: Response, next: NextFunction): Promise<void> {
    const resolution = resolvePaidFrame(catalog, req.params.reelId, req.params.file);
    if (!resolution.ok) {
      sendPaidFrameNotFound(res);
      return;
    }

    try {
      await servePaidFrame(res, frames, resolution, settlementMode);
    } catch (error) {
      if (!respondToFrameError(res, error)) {
        next(error);
      }
    }
  };
}

/**
 * The paid section, as a router.
 *
 * Returned as a router so the app can mount it in one visible place - after the
 * gate and the payment middleware - and so the ordering is legible in `app.ts`
 * rather than implied by which file imported which.
 */
export function buildPaidFrameRouter(deps: PaidFrameRouterDeps): Router {
  const router = Router();
  router.get(PAID_FRAME_ROUTE_PATTERN, buildPaidFrameHandler(deps));
  return router;
}
