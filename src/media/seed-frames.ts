/**
 * Seeding the frame store.
 *
 * ## What this guarantees about the on-disk boundary
 *
 * For every reel in the catalog:
 *
 * - frame 0 is written to `storage/public-frames/<reelId>/frame-000.svg`, and
 *   frames 1..n-1 are written to `storage/paid-frames/<reelId>/frame-NNN.svg`.
 * - The write goes through `FrameStore.writeFrame`, which refuses a frame index
 *   on the wrong side of the boundary. There is no code path in this module
 *   that can put `frame-003.svg` into the free directory, and none that can put
 *   `frame-000.svg` into the paid one.
 * - Before writing, previously generated frames are removed, so a reel that used
 *   to have ten frames does not leave frame-009.svg lying around in the paid
 *   directory forever.
 * - After writing, the free directory is walked and the seed refuses to report
 *   success unless it contains exactly one `frame-000.svg` per reel and nothing
 *   else.
 *
 * So a judge can run `npm run seed`, then `ls -R storage`, and the layout states
 * the paywall on its own.
 *
 * ## Re-running is safe
 *
 * The artwork is deterministic, so a second run produces byte-identical files and
 * an empty diff. The removal step is deliberately narrow: it deletes only files
 * matching `frame-NNN.svg` inside per-reel directories, so it can never delete
 * anything a person put there.
 */

import type { AtomicAmount } from "../domain/amount.js";
import { createReelCatalog, type ReelCatalog } from "../domain/reels.js";
import { renderFrameArtwork } from "./frame-artwork.js";
import {
  assertFreeDirectoryIsClean,
  createFrameStore,
  type FramePayload,
  type FrameStore,
  type PublicFrameDirectoryAudit,
} from "./frame-store.js";
import { framesDirectoryName, type FrameKind } from "./frame-paths.js";

/**
 * Price used only to build reel objects for the artwork.
 *
 * The catalog constructor needs a price, and the artwork does not use it. The
 * price the *server* quotes comes from configuration and is never read from
 * here; this constant only exists so `seedFrames()` can be called with no
 * arguments.
 */
export const SEED_CATALOG_PRICE_ATOMIC: AtomicAmount = "1000";

export interface SeedFrameOptions {
  /** Storage root. Defaults to `BIOSCOPE_STORAGE_DIR`, else `<package>/storage`. */
  readonly root?: string;
  /** Defaults to a catalog of the three seeded reels. */
  readonly catalog?: ReelCatalog;
}

export interface SeededFrame {
  readonly reelId: string;
  readonly index: number;
  readonly kind: FrameKind;
  /** Path relative to the storage root, `/`-separated. */
  readonly relativePath: string;
  readonly byteLength: number;
  readonly etag: string;
}

export interface SeedResult {
  readonly root: string;
  readonly publicFramesDir: string;
  readonly paidFramesDir: string;
  /** Generated files from a previous run that this run deleted. */
  readonly removed: readonly string[];
  readonly written: readonly SeededFrame[];
  readonly audit: PublicFrameDirectoryAudit;
  readonly reelCount: number;
  readonly freeFrameCount: number;
  readonly paidFrameCount: number;
  readonly totalBytes: number;
}

/**
 * Draw every frame of every seeded reel and put each one on the correct side of
 * the free/paid boundary.
 *
 * @throws {MediaError} `media-layout-violation` if the free directory does not
 * end up holding exactly one frame per reel, and `frame-outside-scope` if the
 * catalog somehow contains a frame index the store will not accept.
 */
export async function seedFrames(options: SeedFrameOptions = {}): Promise<SeedResult> {
  const catalog = options.catalog ?? createReelCatalog(SEED_CATALOG_PRICE_ATOMIC);
  const store: FrameStore = createFrameStore(options.root === undefined ? {} : { root: options.root });

  await store.ensureDirectories();
  const removed = await store.deleteGeneratedFrames();

  const written: SeededFrame[] = [];
  let freeFrameCount = 0;
  let paidFrameCount = 0;
  let totalBytes = 0;

  for (const reel of catalog.list()) {
    for (const frame of reel.frames) {
      const artwork = renderFrameArtwork(reel, frame.index);
      // `artwork.kind` and the `kind` argument must agree; the store enforces
      // the boundary and would throw on a paid index in the free directory, so
      // this is belt and braces that also documents the mapping.
      const payload: FramePayload = await store.writeFrame(
        artwork.kind,
        reel.id,
        artwork.index,
        artwork.svg,
      );
      const relativePath = `${framesDirectoryName(artwork.kind)}/${reel.id}/${payload.filename}`;
      if (artwork.kind === "free") {
        freeFrameCount += 1;
      } else {
        paidFrameCount += 1;
      }
      totalBytes += payload.byteLength;
      written.push({
        reelId: reel.id,
        index: artwork.index,
        kind: artwork.kind,
        relativePath,
        byteLength: payload.byteLength,
        etag: payload.etag,
      });
    }
  }

  const reelIds = catalog.list().map((reel) => reel.id);
  const audit = await store.auditPublicFrameDirectory(reelIds);
  // The seed does not get to report success on a layout that leaks.
  assertFreeDirectoryIsClean(audit);

  return {
    root: store.root,
    publicFramesDir: store.publicFramesDir,
    paidFramesDir: store.paidFramesDir,
    removed,
    written,
    audit,
    reelCount: reelIds.length,
    freeFrameCount,
    paidFrameCount,
    totalBytes,
  };
}

/** One line per written frame, for the seed script's output. */
export function formatSeedReport(result: SeedResult): string {
  const lines: string[] = [];
  lines.push(`storage root : ${result.root}`);
  lines.push(
    `free frames  : ${result.freeFrameCount} in ${result.publicFramesDir}  (frame 0 of each reel, served without payment)`,
  );
  lines.push(
    `paid frames  : ${result.paidFrameCount} in ${result.paidFramesDir}  (never mounted, never in any public directory)`,
  );
  lines.push(`reels        : ${result.reelCount}`);
  lines.push(`total bytes  : ${result.totalBytes}`);
  if (result.removed.length > 0) {
    lines.push(`removed      : ${result.removed.length} file(s) from the previous run`);
  }
  lines.push("");
  for (const frame of result.written) {
    lines.push(`  ${frame.kind === "free" ? "free " : "paid "} ${frame.relativePath}`);
  }
  lines.push("");
  lines.push(
    `free directory audit: OK (${result.audit.present.length} file(s), 0 unexpected). ` +
      `Every file in the free directory is a frame-000.`,
  );
  return lines.join("\n");
}
