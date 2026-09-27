/**
 * `npm run seed` - draw the placeholder frames for every seeded reel.
 *
 * Needs no credentials, no network and no chain. It reads the reel catalog and
 * writes SVG files into `storage/public-frames` (frame 0 only) and
 * `storage/paid-frames` (every later frame). See `src/media/seed-frames.ts` for
 * the invariants it holds, and `src/media/frame-store.ts` for why the free/paid
 * split is enforced in code rather than by convention.
 *
 * Override the location with `BIOSCOPE_STORAGE_DIR` if you want to seed a store
 * somewhere other than `./storage`.
 */

import { MediaError } from "../src/media/frame-paths.js";
import { formatSeedReport, seedFrames } from "../src/media/seed-frames.js";

try {
  const result = await seedFrames();
  console.log("The Bioscope - seeded placeholder frames\n");
  console.log(formatSeedReport(result));
} catch (error) {
  if (error instanceof MediaError) {
    console.error(`Seed failed [${error.code}]: ${error.message}`);
  } else {
    console.error("Seed failed:", error);
  }
  process.exitCode = 1;
}
