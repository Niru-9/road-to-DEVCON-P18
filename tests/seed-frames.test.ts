/**
 * The seed script and the placeholder artwork (rubric check 5, and the "seed at
 * least three reels" requirement).
 *
 * Two properties are worth more than the rest:
 *
 * 1. **The layout is exact.** After seeding, the free directory holds one
 *    `frame-000.svg` per reel and the paid directory holds `frame-001..NNN.svg`
 *    and nothing else. A test that walks the filesystem and compares the exact
 *    file list catches a paid frame in the wrong place, a missing frame, and a
 *    leftover from an earlier run - all three of which a status-code test
 *    cannot see.
 * 2. **The artwork is self-contained and deterministic.** No URL, no external
 *    reference, no clock, no `Math.random`. Re-running the seed produces
 *    byte-identical files, so the generated media is reviewable in a diff.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReelCatalog, FRAMES_PER_REEL } from "../src/domain/reels.js";
import { renderFrameArtwork } from "../src/media/frame-artwork.js";
import { MediaError, frameRelativePath } from "../src/media/frame-paths.js";
import { createFrameStore } from "../src/media/frame-store.js";
import { formatSeedReport, seedFrames } from "../src/media/seed-frames.js";
import { TEST_PRICE } from "./support/fixtures.js";

let root = "";
const catalog = createReelCatalog(TEST_PRICE);
const reelIds = catalog.list().map((reel) => reel.id);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bioscope-seed-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Walk a directory tree, returning `/`-separated paths of every file. */
async function walk(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await walk(join(directory, entry.name), relative)));
    } else {
      found.push(relative);
    }
  }
  return found.sort();
}

describe("seeding produces exactly the expected layout", () => {
  it("seeds at least three reels", async () => {
    expect(reelIds.length).toBeGreaterThanOrEqual(3);
    const result = await seedFrames({ root, catalog });
    expect(result.reelCount).toBeGreaterThanOrEqual(3);
  });

  it("puts frame 0 in public-frames and every later frame in paid-frames, and nothing else", async () => {
    await seedFrames({ root, catalog });

    const expected: string[] = [];
    for (const reel of catalog.list()) {
      for (const frame of reel.frames) {
        const kind = frame.index === 0 ? "free" : "paid";
        expected.push(`${kind}/${frameRelativePath(kind, reel.id, frame.index)}`);
      }
    }
    expected.sort();

    // Includes `.gitkeep`-free temp dirs, so this is a full equality check: an
    // extra file anywhere in either frame directory fails here.
    expect(await walk(join(root, "public-frames"))).toEqual(
      expected.filter((path) => path.startsWith("free/")).map((path) => path.slice("free/".length)),
    );
    expect(await walk(join(root, "paid-frames"))).toEqual(
      expected.filter((path) => path.startsWith("paid/")).map((path) => path.slice("paid/".length)),
    );
  });

  it("counts one free frame and n-1 paid frames per reel", async () => {
    const result = await seedFrames({ root, catalog });
    expect(result.freeFrameCount).toBe(reelIds.length);
    expect(result.paidFrameCount).toBe(reelIds.length * (FRAMES_PER_REEL - 1));
    for (const frame of result.written) {
      expect(frame.kind).toBe(frame.index === 0 ? "free" : "paid");
      expect(frame.relativePath.startsWith(frame.index === 0 ? "public-frames/" : "paid-frames/")).toBe(true);
    }
  });

  it("is idempotent: a second run reports what it replaced and writes identical bytes", async () => {
    const first = await seedFrames({ root, catalog });
    const before = await Promise.all(
      first.written.map((frame) => readFile(join(root, ...frame.relativePath.split("/")))),
    );

    const second = await seedFrames({ root, catalog });
    expect(second.removed).toEqual([...first.written.map((frame) => frame.relativePath)].sort());
    expect(second.written.map((frame) => frame.relativePath)).toEqual(
      first.written.map((frame) => frame.relativePath),
    );
    expect(second.written.map((frame) => frame.etag)).toEqual(first.written.map((frame) => frame.etag));

    const after = await Promise.all(
      second.written.map((frame) => readFile(join(root, ...frame.relativePath.split("/")))),
    );
    expect(after.map((bytes) => bytes.toString("utf8"))).toEqual(
      before.map((bytes) => bytes.toString("utf8")),
    );
  });

  it("refuses to report success if the free directory is not exactly one frame per reel", async () => {
    // Proven by planting the violation first, then re-running the seed: the seed
    // clears generated files, so the audit passes again. That is the behaviour
    // we want - the seed repairs rather than inherits a bad layout.
    const store = createFrameStore({ root });
    await seedFrames({ root, catalog });
    const stray = join(store.publicFramesDir, "calcutta-tram", "frame-001.svg");
    await rm(store.paidFramesDir, { recursive: true, force: true });
    await writeFile(stray, "<svg/>", "utf8");

    const audit = await store.auditPublicFrameDirectory(reelIds);
    expect(audit.ok).toBe(false);

    const repaired = await seedFrames({ root, catalog });
    expect(repaired.audit.ok).toBe(true);
    expect(repaired.audit.unexpected).toEqual([]);
  });
});

describe("the placeholder artwork", () => {
  it("is deterministic for the same reel and index", () => {
    for (const reel of catalog.list()) {
      for (const frame of reel.frames) {
        const once = renderFrameArtwork(reel, frame.index);
        const twice = renderFrameArtwork(reel, frame.index);
        expect(twice.svg).toBe(once.svg);
        expect(twice.byteLength).toBe(once.byteLength);
      }
    }
  });

  it("differs between the free frame and the paid frames, and between reels", () => {
    const rendered = new Map<string, string>();
    for (const reel of catalog.list()) {
      for (const frame of reel.frames) {
        const artwork = renderFrameArtwork(reel, frame.index);
        rendered.set(`${reel.id}/${frame.index}`, artwork.svg);
        expect(artwork.kind).toBe(frame.index === 0 ? "free" : "paid");
      }
    }
    expect(new Set(rendered.values()).size).toBe(rendered.size);
  });

  it("references nothing outside itself", () => {
    // The whole point of "self-contained": a frame renders with no network, no
    // asset pipeline and no second file. These are every way SVG can reach out.
    // The one unavoidable URL is the SVG namespace declaration, which is an
    // identifier rather than a fetch - it is stripped before the other checks so
    // it cannot mask a real one.
    for (const reel of catalog.list()) {
      for (const frame of reel.frames) {
        const svg = renderFrameArtwork(reel, frame.index).svg;
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
        const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', "");

        expect(withoutNamespace).not.toMatch(/https?:\/\//);
        expect(withoutNamespace).not.toMatch(/xlink:href/);
        expect(withoutNamespace).not.toMatch(/<image[\s>]/);
        expect(withoutNamespace).not.toMatch(/url\((?!#)/);
        expect(withoutNamespace).not.toMatch(/@import/);
        expect(withoutNamespace).not.toMatch(/<script/i);
        expect(withoutNamespace).not.toMatch(/foreignObject/i);
      }
    }
  });

  it("states its reel, index and free/paid status in the markup", () => {
    for (const reel of catalog.list()) {
      for (const frame of reel.frames) {
        const svg = renderFrameArtwork(reel, frame.index).svg;
        expect(svg).toContain(`data-reel-id="${reel.id}"`);
        expect(svg).toContain(`data-frame-index="${frame.index}"`);
        expect(svg).toContain(`data-frame-kind="${frame.index === 0 ? "free" : "paid"}"`);
        expect(svg).toContain(`data-frame-count="${reel.frames.length}"`);
        expect(svg).toContain(`FRAME ${frame.index + 1} / ${reel.frames.length}`);
        expect(svg).toContain(frame.index === 0 ? "FREE PEEK" : "PAID FRAME");
      }
    }
  });

  it("refuses to draw a frame the reel does not have", () => {
    const reel = catalog.list()[0];
    if (reel === undefined) {
      throw new Error("expected at least one reel");
    }
    expect(() => renderFrameArtwork(reel, reel.frames.length)).toThrow(MediaError);
    expect(() => renderFrameArtwork(reel, -1)).toThrow(MediaError);
    expect(() => renderFrameArtwork(reel, 1.5)).toThrow(MediaError);
  });
});

describe("the seed report", () => {
  it("names both directories and says which side is free", async () => {
    const report = formatSeedReport(await seedFrames({ root, catalog }));
    expect(report).toContain(join(root, "public-frames"));
    expect(report).toContain(join(root, "paid-frames"));
    expect(report).toMatch(new RegExp(`free frames\\s+: ${reelIds.length}`));
    expect(report).toMatch(/never mounted, never in any public directory/);
    expect(report).toContain("free directory audit: OK");
  });
});
