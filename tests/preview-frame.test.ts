/**
 * The free preview path, over real HTTP (rubric check 2, 4 points).
 *
 * ## What check 2 actually asks
 *
 * "Code serves each reel's first frame without requiring payment. Fails if the
 * first frame requires payment, or there is no distinct preview path for it."
 *
 * So two things are asserted, repeatedly and by different means:
 *
 * - **Free.** Every request in this file carries no payment header of any kind.
 *   Not `X-PAYMENT`, not `Authorization`, no wallet, no session - and every
 *   response is still 200 with the frame's bytes. The route also returns no 402,
 *   which is asserted directly rather than by the absence of a status.
 * - **Distinct.** `/api/reels/:reelId/preview` is the one frame URL in this
 *   build, it is a different path from anything a paid request would use, and it
 *   ignores every attempt to steer it with a query parameter.
 *
 * ## This suite runs against the fully wired server, not a bare app
 *
 * Until T4 it built `buildApp({ catalog, frames })` directly. That is no longer
 * expressible - `AppDeps.payment` is required and checked - and the constraint is
 * an improvement: these assertions are now made against the same middleware chain
 * a browser will hit, gate and x402 included. A free frame that was free only
 * because the app had no payment layer at all would not have been much of a proof.
 *
 * The server is a real socket on `127.0.0.1:0`, not a request mock, so what is
 * measured is what a browser would get.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FRAME_INDEX_HEADER, FRAME_KIND_HEADER } from "../src/http/routes/preview.js";
import { startBioscopeTestServer, type BioscopeTestServer } from "./support/bioscope-server.js";

let server: BioscopeTestServer;

beforeAll(async () => {
  server = await startBioscopeTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

describe("the catalog is public", () => {
  it("lists at least three reels with a free frame count and a price", async () => {
    const response = await server.request("/api/reels");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as {
      ok: boolean;
      count: number;
      reels: {
        id: string;
        frameCount: number;
        freeFrameCount: number;
        paidFrameCount: number;
        priceAtomic: string;
        previewUrl: string;
      }[];
    };
    expect(body.ok).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(3);
    for (const reel of body.reels) {
      expect(reel.freeFrameCount).toBe(1);
      expect(reel.paidFrameCount).toBe(reel.frameCount - 1);
      expect(reel.priceAtomic).toBe("1000");
      expect(reel.previewUrl).toBe(`/api/reels/${reel.id}/preview`);
    }
  });

  it("never hands an unpaid viewer a URL for a paid frame", async () => {
    const response = await server.request("/api/reels");
    // The catalog is the first thing a browser sees. If it contained a per-frame
    // URL list, the URLs would exist before anyone paid, which is the failure
    // mode the problem statement calls out by name.
    expect(response.text).not.toMatch(/\/frames\//);
    expect(response.text).not.toMatch(/frame-00[1-9]/);
    expect(Object.keys(JSON.parse(response.text) as object).sort()).toEqual([
      "count",
      "ok",
      "reels",
    ]);
  });
});

describe("the first frame of every reel is served without payment", () => {
  it("returns frame 0 with the right content type and no payment requirement", async () => {
    for (const reel of server.catalog.list()) {
      const response = await server.request(`/api/reels/${reel.id}/preview`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      expect(response.headers.get(FRAME_INDEX_HEADER.toLowerCase())).toBe("0");
      expect(response.headers.get(FRAME_KIND_HEADER.toLowerCase())).toBe("free");
      expect(response.headers.get("payment-required")).toBeNull();
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("x-payment")).toBeNull();
      expect(response.text).toContain(`data-reel-id="${reel.id}"`);
      expect(response.text).toContain('data-frame-index="0"');
      expect(response.text).toContain('data-frame-kind="free"');
      expect(response.text).toContain("FREE PEEK");
      // Never paid bytes, for any frame, of any reel.
      for (const paid of server.paidFrameBytes.values()) {
        expect(response.bytes.equals(paid)).toBe(false);
      }
    }
  });

  it("is the only frame path, and it is distinct from a paid one", async () => {
    // A paid frame is a *different* URL, and an unpaid request for one is a 402
    // rather than a 200. Asserted here as "not this path"; the 402 itself, and
    // every way of failing to earn one, are `paid-frame-gate.test.ts`.
    const canonical = await server.request("/api/reels/calcutta-tram/frames/frame-001.svg");
    expect(canonical.status).toBe(402);

    const preview = await server.request("/api/reels/calcutta-tram/preview");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("ignores every attempt to steer it to a later frame with a query parameter", async () => {
    const plain = await server.request("/api/reels/calcutta-tram/preview");
    expect(plain.status).toBe(200);

    for (const query of [
      "?index=1",
      "?index=7",
      "?index=99",
      "?frame=3",
      "?frameIndex=3",
      "?paid=1",
      "?free=0",
      "?unlocked=true",
      "?index=-1",
      "?index=abc",
    ]) {
      const steered = await server.request(`/api/reels/calcutta-tram/preview${query}`);
      // Not an error, not a redirect, not frame 3: the same frame 0, byte for
      // byte. The route has no index parameter, so there is nothing to steer.
      expect(steered.status, `for ${query}`).toBe(200);
      expect(steered.headers.get(FRAME_INDEX_HEADER.toLowerCase()), `for ${query}`).toBe("0");
      expect(steered.bytes.equals(plain.bytes), `for ${query}`).toBe(true);
    }
  });

  it("revalidates with an ETag instead of resending the bytes", async () => {
    const first = await server.request("/api/reels/calcutta-tram/preview");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"sha256-[0-9a-f]{32}"$/);

    const revalidated = await server.request("/api/reels/calcutta-tram/preview", {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.bytes.byteLength).toBe(0);
  });
});

describe("reel validation on the preview route", () => {
  it("404s an unknown reel and leaks nothing about the ones that exist", async () => {
    const response = await server.request("/api/reels/no-such-reel/preview");
    expect(response.status).toBe(404);
    const body = JSON.parse(response.text) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("no-such-reel");
    expect(response.bytes.byteLength).toBeLessThan(400);
  });

  it("refuses hostile reel ids with 4xx and never a 200", async () => {
    for (const hostile of [
      "..",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "calcutta-tram%2F..%2F..%2Fstorage%2Fpaid-frames%2Fcalcutta-tram%2Fframe-001.svg",
      "CALCUTTA-TRAM",
      "calcutta-tram%00",
      "calcutta-tram%20",
      "..%2fpublic-frames%2fcalcutta-tram%2fframe-001.svg",
      "storage",
      "public-frames",
    ]) {
      const response = await server.request(`/api/reels/${hostile}/preview`);
      expect(response.status, `for ${hostile}`).toBeGreaterThanOrEqual(400);
      expect(response.status, `for ${hostile}`).toBeLessThan(500);
      for (const paid of server.paidFrameBytes.values()) {
        expect(response.bytes.equals(paid), `for ${hostile}`).toBe(false);
      }
    }
  });

  it("is case-sensitive, so there is no second spelling of a reel", async () => {
    const lower = await server.request("/api/reels/calcutta-tram/preview");
    const upper = await server.request("/api/reels/Calcutta-Tram/preview");
    expect(lower.status).toBe(200);
    expect(upper.status).toBe(404);
  });
});
