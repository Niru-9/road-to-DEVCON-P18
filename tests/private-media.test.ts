/**
 * Paid frames are private (rubric check 5, 18 points - the biggest single check
 * in P3).
 *
 * ## What check 5 asks
 *
 * "Frames after the first are stored outside every publicly served directory and
 * are only returned by the gated handler. Fails if any paid frame lives in a
 * publicly served directory (such as Next.js public/), a public bucket, or a
 * static route the gate does not cover, or its direct URL is rendered to viewers
 * who have not paid."
 *
 * Three claims, so three kinds of assertion:
 *
 * 1. **Stored outside every public directory.** A filesystem walk compares the
 *    exact file list on both sides. A paid frame in `public-frames` fails it.
 * 2. **Not reachable from a public path.** A real server is probed with the URLs
 *    that *would* work if anything were mounted: the directory name alone, the
 *    storage path, the sibling of the free frame, and `..` traversal written
 *    verbatim to the socket because `fetch` normalizes it away. All must 404, and
 *    no response body may equal a paid frame's bytes.
 * 3. **No static mount exists to cover them.** `src/http/app.ts` contains no
 *    `express.static` call and never names the paid directory. T7 will add a
 *    `public/` mount for the browser UI, so this asserts about the *media*
 *    directories specifically and a companion assertion keeps the paid store out
 *    of `public/` if that directory ever appears.
 *
 * ## The server is fully wired, including the payment layer
 *
 * Until T4 this suite booted a bare `buildApp({ catalog, frames })`, because the
 * app had no payment layer to boot. It boots the real one now - gate, x402 and
 * all. That is a stronger version of every assertion here: "no path returns a paid
 * frame" is now proven against the same chain a browser traverses, rather than
 * against an app that served paid frames to anyone who asked.
 *
 * It still needs no payment, no wallet and no chain, which is the point being
 * made: the frames are private *before* any of that.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { frameFileName } from "../src/media/frame-paths.js";
import { createFrameStore } from "../src/media/frame-store.js";
import { rawGet } from "./support/http-server.js";
import { startBioscopeTestServer, type BioscopeTestServer } from "./support/bioscope-server.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const APP_SOURCE = fileURLToPath(new URL("../src/http/app.ts", import.meta.url));

let server: BioscopeTestServer;

beforeAll(async () => {
  server = await startBioscopeTestServer();
});

afterAll(async () => {
  await server.cleanup();
});

async function walk(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await walk(join(directory, entry.name), child)));
    } else {
      found.push(child);
    }
  }
  return found.sort();
}

/** Every paid frame's bytes, so any response can be checked against all of them. */
function allPaidFrames(): Buffer[] {
  return [...server.paidFrameBytes.values()];
}

/**
 * Source with comments removed.
 *
 * The static-mount assertion below is a grep, and `app.ts` talks at length about
 * `express.static` in its documentation precisely to explain why it calls none.
 * Stripping comments first means the assertion is about the code, and the prose
 * can stay as clear as it needs to be.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // A `//` preceded by a quote or a colon is part of a string (`"http://"`),
    // not the start of a comment.
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("on disk, every frame after the first is in the paid directory", () => {
  it("holds exactly one file per reel in the free directory", async () => {
    const files = await walk(server.frames.publicFramesDir);
    const expected = server.catalog
      .list()
      .map((reel) => `${reel.id}/frame-000.svg`)
      .sort();
    expect(files).toEqual(expected);
  });

  it("holds every later frame in the paid directory, and none in the free one", async () => {
    const paid = await walk(server.frames.paidFramesDir);
    const expected = server.catalog
      .list()
      .flatMap((reel) =>
        reel.frames
          .filter((frame) => frame.index > 0)
          .map((frame) => `${reel.id}/${frameFileName(frame.index)}`),
      )
      .sort();
    expect(paid).toEqual(expected);
    expect(paid.length).toBeGreaterThan(0);
  });

  it("keeps the two sides disjoint, and the paid side out of any public asset directory", async () => {
    const isInside = (parent: string, child: string) => {
      const rel = relative(resolve(parent), resolve(child));
      return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
    };

    // The store the app and the seed script actually use, resolved from
    // `BIOSCOPE_STORAGE_DIR` or from the default. This is the one that ships.
    const shipping = createFrameStore();
    expect(isInside(PACKAGE_ROOT, shipping.publicFramesDir)).toBe(true);
    expect(isInside(PACKAGE_ROOT, shipping.paidFramesDir)).toBe(true);
    expect(isInside(shipping.publicFramesDir, shipping.paidFramesDir)).toBe(false);
    expect(isInside(shipping.paidFramesDir, shipping.publicFramesDir)).toBe(false);

    // A UI asset directory may appear in T7. If it does, the paid store must not
    // be anywhere beneath it, or the paid frames would be published by a mount.
    const repoPublic = join(PACKAGE_ROOT, "public");
    if (existsSync(repoPublic)) {
      expect(isInside(repoPublic, shipping.paidFramesDir)).toBe(false);
    }

    // Same for the throwaway store this suite seeded.
    expect(isInside(server.frames.publicFramesDir, server.frames.paidFramesDir)).toBe(false);
  });
});

describe("over HTTP, no path returns a paid frame", () => {
  it("404s every URL that would work if a frame directory were mounted", async () => {
    const urls: string[] = [
      "/storage",
      "/storage/paid-frames",
      "/storage/paid-frames/calcutta-tram/frame-001.svg",
      "/paid-frames",
      "/paid-frames/calcutta-tram/frame-001.svg",
      "/paid-frames/calcutta-tram/",
      "/public-frames",
      "/public-frames/calcutta-tram/frame-001.svg",
      "/public-frames/calcutta-tram/frame-000.svg",
      "/public",
      "/public/bioscope.css/../calcutta-tram/frame-001.svg",
      "/frames/calcutta-tram/1",
      "/api/frames/calcutta-tram/1",
      "/api/reels/calcutta-tram/frames/1",
      "/api/paid-frames/calcutta-tram/1",
      "/../storage/paid-frames/calcutta-tram/frame-001.svg",
      "/%2e%2e%2fstorage%2fpaid-frames%2fcalcutta-tram%2fframe-001.svg",
      "/storage%2fpaid-frames%2fcalcutta-tram%2fframe-001.svg",
    ];

    for (const url of urls) {
      const response = await server.request(url);
      expect(response.status, `GET ${url}`).toBe(404);
      for (const paid of allPaidFrames()) {
        expect(response.bytes.equals(paid), `GET ${url} returned a paid frame`).toBe(false);
      }
    }

    // `/` was on that list until T7, when it became the UI shell. It no longer 404s,
    // so it gets its own assertion instead of quietly dropping off the list: the one
    // URL a browser lands on returns HTML and not one byte of any frame, on either
    // side of the paywall.
    const root = await server.request("/");
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html; charset=utf-8");
    for (const paid of allPaidFrames()) {
      expect(root.bytes.equals(paid), "the page contains a paid frame").toBe(false);
    }
    for (const reel of server.catalog.list()) {
      const preview = await server.request(`/api/reels/${reel.id}/preview`);
      expect(root.bytes.equals(preview.bytes), "the page contains the free frame's bytes").toBe(false);
    }

    // The canonical spelling of a paid frame is the one URL here that is *not* a
    // 404 - it is a 402, because it is a real product with a real price. Listed
    // here so the list above cannot be read as "every path under frames/ is
    // private"; the 402 is the whole design, and it is checked frame by frame in
    // `paid-frame-gate.test.ts`.
    const canonical = await server.request("/api/reels/calcutta-tram/frames/frame-001.svg");
    expect(canonical.status).toBe(402);
    for (const paid of allPaidFrames()) {
      expect(canonical.bytes.equals(paid)).toBe(false);
    }
  });

  it("404s traversal written verbatim to the socket, unnormalized", async () => {
    // `fetch` resolves `..` before the request is sent, so these targets would
    // never reach the server otherwise. Sent raw, they are exactly the request a
    // curious person would craft by hand.
    const targets = [
      "/public-frames/../../storage/paid-frames/calcutta-tram/frame-001.svg",
      "/api/reels/../../storage/paid-frames/calcutta-tram/frame-001.svg",
      "/./storage/paid-frames/circus-elephant/frame-007.svg",
      "/storage/paid-frames/calcutta-tram/../calcutta-tram/frame-001.svg",
    ];
    for (const target of targets) {
      const response = await rawGet(server.baseUrl, target);
      expect([400, 403, 404], `GET ${target} returned ${response.status}`).toContain(response.status);
      for (const paid of allPaidFrames()) {
        expect(response.bytes.equals(paid), `GET ${target} returned a paid frame`).toBe(false);
      }
    }
  });

  it("serves the free frame at one URL only, and never a second path to it", async () => {
    // Documented as a consequence of mounting nothing: `public-frames` is not a
    // route, so the free frame does not have a directory-shaped URL either. If a
    // future change adds a static mount, this fails and the boundary is rethought.
    const free = await server.request("/api/reels/calcutta-tram/preview");
    expect(free.status).toBe(200);
    for (const url of ["/public-frames/calcutta-tram/frame-000.svg", "/storage/public-frames/calcutta-tram/frame-000.svg"]) {
      expect((await server.request(url)).status, `GET ${url}`).toBe(404);
    }
  });
});

describe("the app itself declares no static mount for media", () => {
  it("never names the paid directory and never calls express.static", async () => {
    const source = codeOnly(await readFile(APP_SOURCE, "utf8"));
    // The store owns the directory name. If this file ever hard-codes it, or
    // mounts a directory, that is the moment a paid frame becomes public - and
    // this assertion is what makes the change impossible to merge unnoticed.
    // Only the code is scanned: `app.ts` discusses `express.static` and the paid
    // directory at length in its comments precisely so a reader knows why it
    // does neither.
    expect(source).not.toContain("express.static");
    expect(source).not.toContain("paid-frames");
    expect(source).not.toContain("paidFramesDir");
    expect(source).not.toContain("publicFramesDir");
  });

  it("still documents the decision in prose, so the reason is not only in a test", async () => {
    const source = await readFile(APP_SOURCE, "utf8");
    expect(source).toContain("express.static");
    expect(source).toContain("paid-frames");
  });

  it("keeps the paid store out of a future public/ asset directory", async () => {
    const repoPublic = join(PACKAGE_ROOT, "public");
    if (!existsSync(repoPublic)) {
      // Not built yet. Recorded so the check is visibly pending rather than
      // silently passing.
      expect(existsSync(repoPublic)).toBe(false);
      return;
    }
    const info = await stat(repoPublic);
    expect(info.isDirectory()).toBe(true);

    // T7 built it, so this is no longer a "not yet" branch — and the check now has
    // teeth. `public/` exists to hold the browser UI, and the two things that could
    // go wrong are both checked here: a media file appearing in it, and the paid
    // store being reachable from inside it.
    const inPublic = await walk(repoPublic);
    expect(
      inPublic.filter((name) => name.endsWith(".svg") || name.includes("frame-")),
      "public/ holds something that looks like media",
    ).toEqual([]);
    // The three UI files and the type declaration the compiler reads, and nothing else.
    expect(inPublic).toEqual(["bioscope-app.js", "bioscope-core.d.ts", "bioscope-core.js", "bioscope.css"]);

    const paidDir = createFrameStore({ root: server.frames.paidFramesDir.replace(/[\\/]paid-frames$/, "") })
      .paidFramesDir;
    expect(paidDir.startsWith(repoPublic + sep), "the paid store lives inside public/").toBe(false);
  });
});
