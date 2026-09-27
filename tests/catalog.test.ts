import { describe, expect, it } from "vitest";

import { InvalidAmountError, formatAtomicAmount, parseAtomicAmount } from "../src/domain/amount.js";
import {
  FRAMES_PER_REEL,
  REEL_SEEDS,
  createReelCatalog,
  isFreeFrameIndex,
  reelPaidFrameCount,
  UnknownReelError,
} from "../src/domain/reels.js";
import { isSafeReelId, reelIdFromResource, reelUnlockResource } from "../src/domain/reel-resource.js";

const PRICE = "1000";

describe("reel catalog", () => {
  it("seeds at least three reels", () => {
    expect(REEL_SEEDS.length).toBeGreaterThanOrEqual(3);
    expect(createReelCatalog(PRICE).list().length).toBeGreaterThanOrEqual(3);
  });

  it("gives every reel unique, path-safe ids", () => {
    const ids = createReelCatalog(PRICE).list().map((reel) => reel.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isSafeReelId(id)).toBe(true);
    }
  });

  it("numbers frames contiguously from zero for every reel", () => {
    for (const reel of createReelCatalog(PRICE).list()) {
      expect(reel.frames.map((frame) => frame.index)).toEqual(
        Array.from({ length: FRAMES_PER_REEL }, (_, index) => index),
      );
      expect(reel.frames.every((frame) => frame.caption.trim().length > 0)).toBe(true);
    }
  });

  it("treats only frame zero as free", () => {
    const reel = createReelCatalog(PRICE).require(REEL_SEEDS[0]?.id ?? "");
    expect(isFreeFrameIndex(0)).toBe(true);
    for (let index = 1; index < reel.frames.length; index += 1) {
      expect(isFreeFrameIndex(index)).toBe(false);
    }
    expect(reelPaidFrameCount(reel)).toBe(FRAMES_PER_REEL - 1);
  });

  it("applies the server-decided price to every reel", () => {
    for (const reel of createReelCatalog(PRICE).list()) {
      expect(reel.priceAtomic).toBe(PRICE);
    }
    expect(createReelCatalog("25000").require("calcutta-tram").priceAtomic).toBe("25000");
  });

  it("distinguishes an unknown reel from a known one", () => {
    const catalog = createReelCatalog(PRICE);
    expect(catalog.get("no-such-reel")).toBeNull();
    expect(catalog.has("no-such-reel")).toBe(false);
    expect(catalog.has("calcutta-tram")).toBe(true);
    expect(() => catalog.require("no-such-reel")).toThrow(UnknownReelError);
  });
});

describe("reel resource mapping", () => {
  it("round-trips a reel id through its resource path", () => {
    for (const reel of createReelCatalog(PRICE).list()) {
      const resource = reelUnlockResource(reel.id);
      expect(reelIdFromResource(resource)).toBe(reel.id);
    }
  });

  it("refuses to build a resource path from an unsafe reel id", () => {
    for (const bad of [
      "",
      "../etc/passwd",
      "a/b",
      "UPPER",
      "dot.dot",
      "trailing-",
      "-leading",
      "double--dash",
      "with space",
      "with%2Fslash",
      "with?query",
      "with#fragment",
    ]) {
      expect(isSafeReelId(bad), `expected ${JSON.stringify(bad)} to be unsafe`).toBe(false);
      expect(() => reelUnlockResource(bad)).toThrow();
    }
  });

  it("resolves an unrecognized or hostile resource to null rather than guessing", () => {
    // Every one of these has to come back null, because every caller treats null
    // as "deny". A single leak here would be a cross-reel entitlement.
    for (const resource of [
      "/reels/calcutta-tram",
      "/reels/calcutta-tram/frames",
      "/reels//unlock",
      "/reels/calcutta-tram/unlock/",
      "/reels/CALCUTTA-TRAM/unlock",
      "/reels/calcutta-tram/unlock/../../durga-puja-procession",
      "/reels/calcutta-tram/unlock?reel=durga-puja-procession",
      "/reels/calcutta-tram/unlock/../durga-puja-procession/unlock",
      "/",
      "",
      "reels/calcutta-tram/unlock",
      "//reels/calcutta-tram/unlock",
      "/reels/calcutta-tram%2F..%2Fdurga-puja-procession/unlock",
    ]) {
      expect(reelIdFromResource(resource), `expected null for ${resource}`).toBeNull();
    }

    expect(reelIdFromResource(null)).toBeNull();
    expect(reelIdFromResource(undefined)).toBeNull();
    expect(reelIdFromResource(42)).toBeNull();
  });
});

describe("base-unit amounts", () => {
  it("parses and re-renders canonically", () => {
    expect(parseAtomicAmount("1000")).toBe(1000n);
    expect(parseAtomicAmount("0")).toBe(0n);
    expect(formatAtomicAmount(1000n)).toBe("1000");
  });

  it("rejects anything that is not a plain non-negative integer", () => {
    for (const bad of ["", " ", "01000", "+1000", "-1000", "1000.0", "1e3", "0x10", "1_000", "١٢٣"]) {
      expect(() => parseAtomicAmount(bad), `expected rejection of ${JSON.stringify(bad)}`).toThrow(
        InvalidAmountError,
      );
    }
    expect(() => parseAtomicAmount(1000)).toThrow(InvalidAmountError);
  });

  it("stays exact well past what a double can hold", () => {
    // 2^53 + 1 is the classic point where a JS number starts lying.
    const huge = "9007199254740993";
    expect(parseAtomicAmount(huge)).toBe(9007199254740993n);
    expect(formatAtomicAmount(parseAtomicAmount(huge))).toBe(huge);
  });

  it("rejects a negative amount on the way out too", () => {
    expect(() => formatAtomicAmount(-1n)).toThrow(InvalidAmountError);
  });
});
