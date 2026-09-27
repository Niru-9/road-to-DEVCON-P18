/**
 * One place that turns a `MediaError` into an HTTP response.
 *
 * Shared by the preview route now and by the paid route in T4, so the two cannot
 * drift into answering differently for the same class of mistake.
 *
 * The mapping is deliberately conservative. A caller should not be able to learn
 * whether some *other* reel exists by reading a status code, so
 * `invalid-reel` and `frame-missing` are both 404. `invalid-frame-index` is a
 * 400 because the request was malformed rather than absent. `frame-outside-scope`
 * is a 403 with a stable code, because it is a genuine boundary refusal and a
 * caller hitting it has a bug worth surfacing loudly.
 */

import type { Response } from "express";

import { MediaError, type MediaErrorCode } from "../../media/frame-paths.js";

const STATUS_BY_CODE: Record<MediaErrorCode, number> = {
  "invalid-reel": 404,
  "invalid-frame-index": 400,
  "frame-outside-scope": 403,
  "frame-missing": 404,
  // A layout violation is our bug, not the caller's. 500 is honest.
  "media-layout-violation": 500,
};

export function sendMediaError(res: Response, error: MediaError): void {
  const status = STATUS_BY_CODE[error.code];
  res.status(status).json({
    ok: false,
    error: error.code,
    detail: error.message,
  });
}
