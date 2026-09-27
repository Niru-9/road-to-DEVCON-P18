/**
 * Where a frame lives on disk, and what counts as a legal way to ask for one.
 *
 * ## The one rule this module encodes
 *
 * **Frame 0 is the free peek. Every other frame is paid.** That single sentence
 * decides the whole directory layout, and this module is the only place that
 * knows it, so there is exactly one definition to get wrong rather than three
 * (a naming helper, a route, and a seed script all inventing their own idea of
 * "the first frame").
 *
 * ```
 * <storage root>/
 *   public-frames/<reelId>/frame-000.svg   <- the only frame served unpaid
 *   paid-frames/<reelId>/frame-001.svg     <- ... through frame-NNN, gated
 *   paid-frames/<reelId>/frame-002.svg
 * ```
 *
 * The directory name is not decoration. `public-frames` is the only frame
 * directory whose contents are ever free, and `paid-frames` is outside every
 * directory this server will ever hand to a browser. Putting the boundary in the
 * path means a reviewer can read it off `ls` without opening a single file, and
 * it means a bug in a route handler cannot move a file across the boundary -
 * only the seed script writes, and it writes each frame into the directory its
 * index belongs to.
 *
 * ## Why validation is this strict
 *
 * `reelId` becomes a path segment and `index` becomes part of a filename, so
 * both are checked against closed patterns before they are used, and neither is
 * ever accepted pre-formatted. There is no code path here that takes a caller
 * supplied path: callers supply a reel id and a number, and this module builds
 * the rest. A `..` cannot reach the filesystem because the only strings that are
 * ever concatenated into a path have already matched `REEL_ID_PATTERN` (see
 * `isSafeReelId` in the domain) or are integers this module formatted itself.
 *
 * Frame indices are treated with the same suspicion as monetary amounts in
 * `src/domain/amount.ts`: exactly one spelling of each index is accepted.
 * `"1"`, `"01"`, `" 1"`, `"+1"`, `"1.0"` and `1` are six spellings of one frame,
 * and a media store that resolves all six has six chances to serve the wrong
 * file.
 */

import { isSafeReelId } from "../domain/reel-resource.js";
import { isFreeFrameIndex } from "../domain/reels.js";

/** Directory name whose contents are all free. Frame 0 only. */
export const PUBLIC_FRAMES_DIRNAME = "public-frames";

/**
 * Directory name for everything behind the coin slot.
 *
 * Never mounted, never under a public directory, never rendered into a page.
 * Only `src/media/frame-store.ts#readPaidFrame` may read it, and only after the
 * caller has already decided the viewer may.
 */
export const PAID_FRAMES_DIRNAME = "paid-frames";

export const FRAME_FILE_EXTENSION = ".svg";

/** The frames are SVG, so the whole reel is text: greppable, diffable, tiny. */
export const FRAME_CONTENT_TYPE = "image/svg+xml";

/** The free peek. Re-exported from the domain so there is one definition. */
export const PREVIEW_FRAME_INDEX = 0;

/** Zero padding width for a frame filename: `frame-000.svg`. */
export const FRAME_INDEX_WIDTH = 3;

/** Highest index the naming scheme can express. */
export const MAX_FRAME_INDEX = 10 ** FRAME_INDEX_WIDTH - 1;

export type FrameKind = "free" | "paid";

export const FRAME_KINDS: readonly FrameKind[] = ["free", "paid"];

/**
 * Every way a media request can be refused.
 *
 * The codes are stable strings so route handlers can map them to status codes
 * and tests can assert on the reason rather than on a message.
 */
export type MediaErrorCode =
  /** The reel id was not a safe, path-shaped reel id. */
  | "invalid-reel"
  /** The frame index was not a canonical non-negative integer. */
  | "invalid-frame-index"
  /**
   * The frame exists, but not on the side of the boundary the caller asked for.
   * Asking the free side for frame 3, or the paid side for frame 0, lands here.
   */
  | "frame-outside-scope"
  /** The reel and frame are legal, but no file has been generated for them yet. */
  | "frame-missing"
  /** The on-disk layout contradicts the free/paid boundary. Always a bug. */
  | "media-layout-violation";

export class MediaError extends Error {
  public readonly code: MediaErrorCode;

  public constructor(code: MediaErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** Which side of the boundary an index belongs to. @throws for a non-index. */
export function frameKindForIndex(index: number): FrameKind {
  requireFrameIndex(index);
  return isFreeFrameIndex(index) ? "free" : "paid";
}

/**
 * Throw unless `value` is a safe reel id usable as a single path segment.
 *
 * @throws {MediaError} with code `invalid-reel`
 */
export function requireSafeReelId(value: unknown): string {
  if (!isSafeReelId(value)) {
    throw new MediaError(
      "invalid-reel",
      `Not a safe reel id: ${JSON.stringify(typeof value === "string" ? value : String(value))}`,
    );
  }
  return value;
}

/**
 * Throw unless `value` is a canonical non-negative integer frame index.
 *
 * Accepts a `number` that is a safe integer, or a decimal `string` in canonical
 * form. Rejects leading zeros, signs, whitespace, exponents, fractions and
 * `NaN`/`Infinity`, so one frame index has exactly one spelling.
 *
 * @throws {MediaError} with code `invalid-frame-index`
 */
export function requireFrameIndex(value: unknown): number {
  const index = parseFrameIndex(value);
  if (index === null) {
    throw new MediaError(
      "invalid-frame-index",
      `Not a canonical frame index: ${JSON.stringify(
        typeof value === "string" ? value : String(value),
      )}`,
    );
  }
  return index;
}

/**
 * Parse a frame index, or return `null`.
 *
 * The `null` return is for callers that want to branch instead of catching.
 * Bounds are inclusive of `MAX_FRAME_INDEX` because that is the widest the
 * filename scheme can express; a caller still has to check the index against
 * the reel's real frame count, which only the catalog knows.
 */
export function parseFrameIndex(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_FRAME_INDEX ? value : null;
  }
  if (typeof value !== "string" || !CANONICAL_FRAME_INDEX.test(value)) {
    return null;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index <= MAX_FRAME_INDEX ? index : null;
}

/** The canonical spelling of a frame index, and nothing else. */
const CANONICAL_FRAME_INDEX = /^(0|[1-9][0-9]{0,2})$/;

/**
 * Filename for a frame: `frame-000.svg`.
 *
 * Zero padded so the directory listing sorts in playback order, which matters
 * when a human is auditing what a reel actually contains.
 *
 * @throws {MediaError} for a non-canonical index.
 */
export function frameFileName(index: unknown): string {
  const at = requireFrameIndex(index);
  return `frame-${String(at).padStart(FRAME_INDEX_WIDTH, "0")}${FRAME_FILE_EXTENSION}`;
}

/** Per-reel subdirectory name. Identical on both sides of the boundary. */
export function frameDirectoryName(reelId: unknown): string {
  return requireSafeReelId(reelId);
}

/**
 * The filename the *free* side holds for a frame index.
 *
 * Always `frame-000.svg`. Exists so the "one free frame per reel" rule is
 * expressed as a function of the same validator, rather than as a constant
 * somebody could set to something else.
 *
 * @throws {MediaError} for any index other than 0.
 */
export function freeFrameFileName(index: unknown = PREVIEW_FRAME_INDEX): string {
  const at = requireFrameIndex(index);
  if (!isFreeFrameIndex(at)) {
    throw new MediaError(
      "frame-outside-scope",
      `Frame ${at} is not free. Only frame ${PREVIEW_FRAME_INDEX} is.`,
    );
  }
  return frameFileName(at);
}

/**
 * The filename the *paid* side holds for a frame index.
 *
 * @throws {MediaError} for frame 0, which lives in the free directory and is
 * never served through the paid path.
 */
export function paidFrameFileName(index: unknown): string {
  const at = requireFrameIndex(index);
  if (isFreeFrameIndex(at)) {
    throw new MediaError(
      "frame-outside-scope",
      `Frame ${at} is the free preview frame and is never stored or served as a paid frame.`,
    );
  }
  return frameFileName(at);
}

/** Free/paid directory name for a side of the boundary. */
export function framesDirectoryName(kind: FrameKind): string {
  if (kind === "free") {
    return PUBLIC_FRAMES_DIRNAME;
  }
  if (kind === "paid") {
    return PAID_FRAMES_DIRNAME;
  }
  throw new MediaError(
    "media-layout-violation",
    `Unknown frame kind: ${JSON.stringify(String(kind))}. Expected "free" or "paid".`,
  );
}

/**
 * The path of a frame *relative to its own side's directory*, with `/`
 * separators so the string is stable in messages and test assertions.
 *
 * This is the layout contract, in one string:
 * `<reelId>/frame-NNN.svg`.
 */
export function frameRelativePath(kind: FrameKind, reelId: unknown, index: unknown): string {
  const id = frameDirectoryName(reelId);
  const name = kind === "free" ? freeFrameFileName(index) : paidFrameFileName(index);
  return `${id}/${name}`;
}
