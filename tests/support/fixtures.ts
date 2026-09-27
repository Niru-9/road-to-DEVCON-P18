/**
 * Test fixtures: a throwaway frame store on the local temp drive.
 *
 * Seeded once per test file into a directory the OS cleans up, so the suite
 * never depends on, or damages, the real `storage/` tree. That matters for the
 * privacy tests: they walk the filesystem to prove where each frame landed, and
 * they should be reading a store they just built, not whatever a previous
 * `npm run seed` left behind.
 *
 * `N:` is a network share, so temp goes to the system temp drive instead - one
 * less thing that can be slow or locked while a test runs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtomicAmount } from "../../src/domain/amount.js";
import { createReelCatalog, type ReelCatalog } from "../../src/domain/reels.js";
import { createFrameStore, type FrameStore } from "../../src/media/frame-store.js";
import { seedFrames, type SeedResult } from "../../src/media/seed-frames.js";

export const TEST_PRICE: AtomicAmount = "1000";

export interface SeededFixture {
  readonly root: string;
  readonly catalog: ReelCatalog;
  readonly frames: FrameStore;
  readonly seed: SeedResult;
  /** Bytes of every paid frame, by `<reelId>/<index>`. Used to prove no leak. */
  readonly paidFrameBytes: ReadonlyMap<string, Buffer>;
  cleanup(): Promise<void>;
}

export async function createSeededFixture(): Promise<SeededFixture> {
  const root = await mkdtemp(join(tmpdir(), "bioscope-t3-"));
  const catalog = createReelCatalog(TEST_PRICE);
  const seed = await seedFrames({ root, catalog });
  const frames = createFrameStore({ root });

  const paidFrameBytes = new Map<string, Buffer>();
  for (const reel of catalog.list()) {
    for (const frame of reel.frames) {
      if (frame.index === 0) {
        continue;
      }
      const payload = await frames.readPaidFrame(reel.id, frame.index);
      paidFrameBytes.set(`${reel.id}/${frame.index}`, payload.bytes);
    }
  }

  return {
    root,
    catalog,
    frames,
    seed,
    paidFrameBytes,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
