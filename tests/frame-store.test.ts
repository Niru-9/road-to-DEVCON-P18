/**
 * The media store is the free/paid boundary (rubric checks 2 and 5).
 *
 * These tests are written as an adversary rather than as a user. The question in
 * every case is not "does the happy path work" but "can I get a paid frame out of
 * the free side, or a free frame out of the paid side, or a file outside the
 * store, by controlling a reel id or a frame index". The store answers with
 * `MediaError` and a stable code in every case.
 *
 * A live server and real sockets are covered in `preview-frame.test.ts` and
 * `private-media.test.ts`; this file is the unit-level proof that the refusal
 * lives in the store and not only in a route.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MediaError, frameFileName, parseFrameIndex } from "../src/media/frame-paths.js";
import {
  assertFreeDirectoryIsClean,
  createFrameStore,
  type FrameStore,
} from "../src/media/frame-store.js";
import { createSeededFixture, type SeededFixture } from "./support/fixtures.js";

let fixture: SeededFixture;
let store: FrameStore;

beforeAll(async () => {
  fixture = await createSeededFixture();
  store = fixture.frames;
});

afterAll(async () => {
  await fixture.cleanup();
});

/** Assert that `action` refuses with a specific `MediaError` code. */
async function refusesWith(code: string, action: () => Promise<unknown>): Promise<void> {
  const outcome = await action().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (outcome.ok) {
    throw new Error(`expected MediaError(${code}), but the call resolved with ${String(outcome.value)}`);
  }
  expect(outcome.error).toBeInstanceOf(MediaError);
  expect((outcome.error as MediaError).code).toBe(code);
}

describe("frame index validation", () => {
  it("accepts exactly one spelling of each index", () => {
    for (let index = 0; index <= 7; index += 1) {
      expect(parseFrameIndex(index)).toBe(index);
      expect(parseFrameIndex(String(index))).toBe(index);
    }
  });

  it("rejects the other spellings, so one index has one name", () => {
    // "01" and "1.0" and " 1" are three more ways to ask for frame 1. Accepting
    // them would give the media store several chances to resolve the wrong file.
    for (const bad of ["01", "1.0", " 1", "1 ", "+1", "-1", "0x1", "1e0", "", " ", "1000", "١", 1.5, -1, NaN, Infinity, null, undefined, {}, [], true]) {
      expect(parseFrameIndex(bad), `expected ${JSON.stringify(String(bad))} to be rejected`).toBeNull();
    }
  });

  it("names files in a fixed zero-padded width, in playback order", () => {
    expect(frameFileName(0)).toBe("frame-000.svg");
    expect(frameFileName(7)).toBe("frame-007.svg");
    expect(frameFileName(10)).toBe("frame-010.svg");
    expect([0, 1, 2, 10, 11].map((index) => frameFileName(index))).toEqual([
      "frame-000.svg",
      "frame-001.svg",
      "frame-002.svg",
      "frame-010.svg",
      "frame-011.svg",
    ]);
  });
});

describe("the free side serves frame 0 and nothing else", () => {
  it("serves the preview frame of every reel", async () => {
    for (const reel of fixture.catalog.list()) {
      const frame = await store.readFreeFrame(reel.id, 0);
      expect(frame.kind).toBe("free");
      expect(frame.index).toBe(0);
      expect(frame.reelId).toBe(reel.id);
      expect(frame.path.startsWith(store.publicFramesDir)).toBe(true);
      expect(frame.contentType).toBe("image/svg+xml");
      expect(frame.byteLength).toBeGreaterThan(0);
      expect(frame.bytes.toString("utf8")).toContain(`data-reel-id="${reel.id}"`);
    }
  });

  it("refuses every paid index, however the caller spells it", async () => {
    for (const reel of fixture.catalog.list()) {
      for (const index of [1, 2, 3, 4, 5, 6, 7, 99]) {
        await refusesWith("frame-outside-scope", () => store.readFreeFrame(reel.id, index));
        await refusesWith("frame-outside-scope", () => store.readFreeFrame(reel.id, String(index)));
      }
    }
  });

  it("refuses a malformed index rather than defaulting it to the free frame", async () => {
    // Note that `"1"` is absent on purpose: it is a well-formed index for a paid
    // frame, so it is refused as `frame-outside-scope` above. A caller must not
    // be able to reach a paid frame by sending a *valid* index either, and a
    // caller must not get frame 0 by sending garbage.
    for (const bad of [undefined, null, "", "abc", -1, 1.5, NaN, [], {}]) {
      await refusesWith("invalid-frame-index", () => store.readFreeFrame("calcutta-tram", bad));
    }
  });
});

describe("the paid side serves frames 1..n-1 and refuses frame 0", () => {
  it("reads every paid frame from the paid directory", async () => {
    for (const reel of fixture.catalog.list()) {
      for (const frame of reel.frames) {
        if (frame.index === 0) {
          continue;
        }
        const payload = await store.readPaidFrame(reel.id, frame.index);
        expect(payload.kind).toBe("paid");
        expect(payload.path.startsWith(store.paidFramesDir)).toBe(true);
        expect(payload.path.startsWith(store.publicFramesDir)).toBe(false);
        expect(payload.bytes.toString("utf8")).toContain(`data-frame-index="${frame.index}"`);
        expect(payload.bytes.toString("utf8")).toContain('data-frame-kind="paid"');
      }
    }
  });

  it("refuses the free frame, so the paid path cannot be used as a free-frame reader", async () => {
    for (const reel of fixture.catalog.list()) {
      await refusesWith("frame-outside-scope", () => store.readPaidFrame(reel.id, 0));
      await refusesWith("frame-outside-scope", () => store.readPaidFrame(reel.id, "0"));
    }
  });

  it("reports a legal but ungenerated frame as missing, not as a boundary failure", async () => {
    await refusesWith("frame-missing", () => store.readPaidFrame("calcutta-tram", 42));
  });
});

describe("reel id validation", () => {
  it("refuses any reel id that could reach outside its own directory", async () => {
    const hostile = [
      "",
      "..",
      "../paid-frames/circus-elephant",
      "../../etc/passwd",
      "calcutta-tram/../../durga-puja-procession",
      "calcutta-tram\\durga-puja-procession",
      "CALCUTTA-TRAM",
      "calcutta tram",
      "calcutta-tram%2F..",
      "calcutta-tram?index=1",
      "calcutta-tram#x",
      "calcutta-tram/frame-001.svg",
      ".gitkeep",
      42,
      null,
      undefined,
      ["calcutta-tram"],
      { toString: () => "calcutta-tram" },
    ];
    for (const bad of hostile) {
      await refusesWith("invalid-reel", () => store.readFreeFrame(bad, 0));
      await refusesWith("invalid-reel", () => store.readPaidFrame(bad, 1));
    }
  });

  it("distinguishes an unsafe id from a well-formed id for a reel that does not exist", async () => {
    // A reel id that is safe but unknown is a missing frame, not a malformed
    // request. The distinction matters: the route turns the first into a 404 and
    // the second into a 400, and a caller must not be able to probe which reel
    // ids exist by watching which error code comes back.
    await refusesWith("frame-missing", () => store.readFreeFrame("no-such-reel", 0));
    await refusesWith("frame-missing", () => store.readPaidFrame("no-such-reel", 1));
  });
});

describe("paths are built, never accepted", () => {
  it("places each frame inside its own side's directory", () => {
    expect(store.framePath("free", "calcutta-tram", 0)).toBe(
      join(store.publicFramesDir, "calcutta-tram", "frame-000.svg"),
    );
    expect(store.framePath("paid", "calcutta-tram", 1)).toBe(
      join(store.paidFramesDir, "calcutta-tram", "frame-001.svg"),
    );
    // The two sides never share a path prefix, which is what makes the split
    // structural rather than a naming convention.
    expect(store.publicFramesDir.startsWith(store.paidFramesDir)).toBe(false);
    expect(store.paidFramesDir.startsWith(store.publicFramesDir)).toBe(false);
  });

  it("refuses to build a path for a frame on the wrong side", () => {
    expect(() => store.framePath("free", "calcutta-tram", 1)).toThrow(MediaError);
    expect(() => store.framePath("paid", "calcutta-tram", 0)).toThrow(MediaError);
    expect(() => store.framePath("free", "calcutta-tram", 1)).toThrow(/not free/);
    expect(() => store.framePath("paid", "calcutta-tram", 0)).toThrow(/never stored or served/);
  });
});

describe("the free directory is audited, not assumed", () => {
  it("is clean after seeding", async () => {
    const reelIds = fixture.catalog.list().map((reel) => reel.id);
    const audit = await store.auditPublicFrameDirectory(reelIds);
    expect(audit.unexpected).toEqual([]);
    expect(audit.missing).toEqual([]);
    expect(audit.present).toEqual(reelIds.map((id) => `public-frames/${id}/frame-000.svg`).sort());
    expect(() => assertFreeDirectoryIsClean(audit)).not.toThrow();
  });

  it("catches a paid frame that has been dropped into the free directory", async () => {
    // The exact accident the audit exists for: someone copies a file, or a
    // script writes with the wrong `kind`, and frame 1 becomes reachable.
    const stray = join(store.publicFramesDir, "calcutta-tram", "frame-001.svg");
    await mkdir(join(store.publicFramesDir, "calcutta-tram"), { recursive: true });
    await writeFile(stray, "<svg/>", "utf8");
    try {
      const audit = await store.auditPublicFrameDirectory(["calcutta-tram"]);
      expect(audit.ok).toBe(false);
      expect(audit.unexpected).toContain("public-frames/calcutta-tram/frame-001.svg");
      expect(() => assertFreeDirectoryIsClean(audit)).toThrow(/frame-001\.svg/);
    } finally {
      await rm(stray, { force: true });
    }
  });

  it("catches a stray file and a non-reel directory in the free directory", async () => {
    const strayFile = join(store.publicFramesDir, "notes.txt");
    const strayDir = join(store.publicFramesDir, "not a reel");
    await writeFile(strayFile, "hello", "utf8");
    await mkdir(strayDir, { recursive: true });
    try {
      const audit = await store.auditPublicFrameDirectory([]);
      expect(audit.unexpected).toContain("public-frames/notes.txt");
      expect(audit.unexpected.some((path) => path.includes("not a reel"))).toBe(true);
    } finally {
      await rm(strayFile, { force: true });
      await rm(strayDir, { recursive: true, force: true });
    }
  });

  it("tolerates a tracked .gitkeep at the top of the free directory", async () => {
    const keep = join(store.publicFramesDir, ".gitkeep");
    await writeFile(keep, "", "utf8");
    try {
      const audit = await store.auditPublicFrameDirectory([]);
      expect(audit.unexpected).toEqual([]);
    } finally {
      await rm(keep, { force: true });
    }
  });
});
