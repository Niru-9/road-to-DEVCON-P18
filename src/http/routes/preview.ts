/**
 * The free side of the bioscope: the catalog, and the first frame of each reel.
 *
 * ## The two routes
 *
 * - `GET /api/reels` - metadata for every reel, with a `previewUrl` and nothing
 *   else. A viewer who has not paid is never handed a URL for a frame that is
 *   not already theirs, so there is nothing in the catalog to leak and nothing in
 *   the browser to guess at.
 * - `GET /api/reels/:reelId/preview` - the free peek, and only that.
 *
 * ## Why the preview route cannot be talked into serving a paid frame
 *
 * The route has **no index parameter**. There is nothing to read, so there is
 * nothing to abuse: `?index=3`, `?frame=3` and `?paid=1` are all ignored and the
 * response is byte-identical to the plain request. A test asserts exactly that.
 *
 * Underneath, the route asks the media store for frame 0 by name, and the store
 * refuses any index that is not the free one - see `FrameStore.readFreeFrame`.
 * So the guarantee does not live in this file. Even a future
 * `GET /api/reels/:reelId/preview?index=N` added by mistake would get a 403
 * rather than a paid frame.
 *
 * ## What is deliberately absent
 *
 * No paid route, no payment middleware, no wallet handling, no session. Those
 * are T4 and T5. Nothing here claims to gate anything; it only decides what is
 * free.
 */

import { Router } from "express";
import {
  reelPaidFrameCount,
  type ReelCatalog,
} from "../../domain/reels.js";
import { MediaError, PREVIEW_FRAME_INDEX } from "../../media/frame-paths.js";
import type { FrameStore } from "../../media/frame-store.js";
import { sendMediaError } from "./media-errors.js";

/** Route prefix for everything under the public catalog. */
export const CATALOG_ROUTE_PREFIX = "/api/reels";

/** The distinct free path for a reel's first frame. */
export const PREVIEW_ROUTE_PATTERN = "/api/reels/:reelId/preview";

/**
 * Header naming the frame a response contains.
 *
 * Free, cacheable, and asserts its own value in tests, so a preview that
 * somehow started returning frame 2 would be caught by the response headers and
 * not only by the body.
 */
export const FRAME_INDEX_HEADER = "X-Bioscope-Frame-Index";

/** Header naming which side of the boundary a response came from. */
export const FRAME_KIND_HEADER = "X-Bioscope-Frame-Kind";

const PREVIEW_CACHE_CONTROL = "public, max-age=300";
const CATALOG_CACHE_CONTROL = "public, max-age=60";

export interface PreviewRouterDeps {
  readonly catalog: ReelCatalog;
  readonly frames: FrameStore;
}

export function buildPreviewRouter({ catalog, frames }: PreviewRouterDeps): Router {
  const router = Router();

  /**
   * The public catalog. Free by design: a stranger with no wallet and no money
   * has to be able to see what the bioscope sells.
   */
  router.get(CATALOG_ROUTE_PREFIX, (_req, res) => {
    const reels = catalog.list().map((reel) => ({
      id: reel.id,
      title: reel.title,
      year: reel.year,
      place: reel.place,
      blurb: reel.blurb,
      priceAtomic: reel.priceAtomic,
      frameCount: reel.frames.length,
      freeFrameCount: 1,
      paidFrameCount: reelPaidFrameCount(reel),
      /** The only frame URL an unpaid viewer is ever given. */
      previewUrl: `${CATALOG_ROUTE_PREFIX}/${reel.id}/preview`,
    }));
    res.setHeader("Cache-Control", CATALOG_CACHE_CONTROL);
    res.json({ ok: true, count: reels.length, reels });
  });

  /**
   * The free peek.
   *
   * Note what is absent: no `req.query` read, no `req.params` beyond the reel
   * id, and no path into the paid store. The frame is requested as frame 0 by
   * constant, from a store method that refuses anything else.
   */
  router.get(PREVIEW_ROUTE_PATTERN, async (req, res, next) => {
    const reelId = req.params.reelId;
    const reel = typeof reelId === "string" ? catalog.get(reelId) : null;
    if (reel === null) {
      res.status(404).json({
        ok: false,
        error: "no-such-reel",
        detail:
          typeof reelId === "string" && reelId.length > 0
            ? `No reel named ${JSON.stringify(reelId)}.`
            : "A reel id is required.",
        reelsUrl: CATALOG_ROUTE_PREFIX,
      });
      return;
    }

    try {
      const frame = await frames.readFreeFrame(reel.id, PREVIEW_FRAME_INDEX);

      // The preview is free and cacheable, so a revalidation is a legitimate
      // request. A 304 carries no body, and therefore no frame bytes.
      const ifNoneMatch = req.headers["if-none-match"];
      if (typeof ifNoneMatch === "string" && ifNoneMatch.split(",").some((tag) => tag.trim() === frame.etag)) {
        res.status(304).end();
        return;
      }

      res.setHeader("Content-Type", frame.contentType);
      res.setHeader("Content-Length", String(frame.byteLength));
      res.setHeader("Cache-Control", PREVIEW_CACHE_CONTROL);
      res.setHeader("ETag", frame.etag);
      res.setHeader(FRAME_INDEX_HEADER, String(frame.index));
      res.setHeader(FRAME_KIND_HEADER, frame.kind);
      // Free, so a cross-origin page or a proxy may hold on to it. The paid
      // route will set its own, much narrower, headers.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).end(frame.bytes);
    } catch (error) {
      if (error instanceof MediaError) {
        sendMediaError(res, error);
        return;
      }
      next(error);
    }
  });

  return router;
}
