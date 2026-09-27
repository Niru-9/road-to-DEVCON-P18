/**
 * The two UI routes: the page, and the three files it loads.
 *
 * ```
 *   GET /            the shell, rendered from server configuration
 *   GET /ui/:file    one of three named files, or 404
 * ```
 *
 * ## Why the assets are an allow-list and not a mount
 *
 * See `src/ui/assets.ts`. Short version: a mount turns "no paid frame is publicly
 * reachable" into a property of a directory listing that somebody has to keep
 * correct, and an allow-list of three names makes it a property of a table in this
 * file. `tests/ui-shell.test.ts` asserts both halves — that the three files are
 * served, and that nothing else under `public/` is.
 *
 * ## Caching
 *
 * `public, max-age=0, must-revalidate` plus a content-hash ETag. The point is a demo
 * that you can edit: the browser revalidates, gets a 304 while the file is
 * unchanged, and gets the new bytes the moment it is not. No build step means no
 * cache-busting query strings to remember.
 *
 * ## The page is not a media route
 *
 * Neither route touches the frame store, and the paid-area gate in `app.ts` runs
 * after these, so there is no ordering relationship to get wrong. `/` and `/ui/*` do
 * not match `/api/reels/…/frames/…`, which is the only pattern that reaches paid
 * bytes.
 */

import { Router } from "express";

import type { BioscopeConfig } from "../../config.js";
import { readUiAsset } from "../../ui/assets.js";
import { renderShell } from "../../ui/shell.js";

/** Where the three UI files are served from. */
export const UI_ASSET_PREFIX = "/ui";

export interface UiRouterDeps {
  readonly config: BioscopeConfig;
}

export function buildUiRouter({ config }: UiRouterDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const html = renderShell(config);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", String(Buffer.byteLength(html)));
    // The shell is rendered per request from configuration, so it must not be
    // cached by a shared cache: two operators with different settlement modes must
    // not be served each other's banner.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.status(200).end(html);
  });

  router.get(`${UI_ASSET_PREFIX}/:file`, async (req, res, next) => {
    const name = req.params.file;
    let asset;
    try {
      // An unknown name resolves to `null` and is never read from disk, so a
      // traversal attempt costs one map lookup.
      asset = name === undefined ? null : await readUiAsset(name);
    } catch (error) {
      next(error);
      return;
    }

    if (asset === null) {
      res.status(404).json({
        ok: false,
        error: "no-such-asset",
        detail: "The browser UI is three files, served by name. This is not one of them.",
      });
      return;
    }

    const ifNoneMatch = req.headers["if-none-match"];
    if (typeof ifNoneMatch === "string" && ifNoneMatch.split(",").some((tag) => tag.trim() === asset.etag)) {
      res.status(304).end();
      return;
    }

    res.setHeader("Content-Type", asset.contentType);
    res.setHeader("Content-Length", String(asset.body.byteLength));
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    res.setHeader("ETag", asset.etag);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).end(asset.body);
  });

  return router;
}
