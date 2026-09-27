/**
 * The three UI files, served by name.
 *
 * ## No `express.static`, here or anywhere else
 *
 * T3's decision, restated because T7 is the task that could most easily have
 * broken it: the temptation is `app.use(express.static("public"))`, which works and
 * makes check 5 depend on nobody ever adding media to that directory. P3 does not
 * do that. The UI is three files, so they are served by an allow-list of exact
 * names, and the consequences are structural rather than procedural:
 *
 * - there is no URL pattern that reaches a file, only three URLs that reach *these*
 *   files;
 * - a traversal cannot work, because the requested name has to equal a key in a map
 *   before anything is read from disk;
 * - `storage/paid-frames` cannot be inside `public/` in a way that matters, because
 *   nothing walks `public/`. The existing test that walks it anyway is kept as the
 *   second line of defence.
 *
 * ## Why the shell is rendered here and the assets are not
 *
 * The HTML carries the server's own configuration — the settlement mode, the
 * network, the price, the session lifetime — because those are the labels a viewer
 * is supposed to trust. Rendering them server-side means the page cannot disagree
 * with the API about whether money moved. The three asset files carry no
 * configuration at all; they read the embedded block at runtime.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

/** Absolute path of the package root, from this file's own location. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the three UI files live. Not configurable, and deliberately so. */
export const PUBLIC_DIR = join(PACKAGE_ROOT, "public");

/**
 * The allow-list.
 *
 * Exact filenames only. A request for anything not named here is a 404, and no
 * filesystem read is attempted - which is what makes "the mount cannot reach
 * media" a property of this table rather than of the directory layout.
 *
 * `bioscope-core.d.ts` is in `public/` for the TypeScript compiler and is
 * deliberately **not** on this list. Its absence here is asserted by a test.
 */
export const UI_ASSETS: Readonly<Record<string, string>> = {
  "bioscope.css": "text/css; charset=utf-8",
  "bioscope-core.js": "text/javascript; charset=utf-8",
  "bioscope-app.js": "text/javascript; charset=utf-8",
};

export interface UiAsset {
  readonly body: Buffer;
  readonly contentType: string;
  /** Content hash, so a repeat visit costs a 304 instead of the file. */
  readonly etag: string;
}

/** `null` for any name not on the allow-list. No read is attempted. */
export async function readUiAsset(name: string): Promise<UiAsset | null> {
  const contentType = UI_ASSETS[name];
  if (contentType === undefined) {
    return null;
  }

  const path = join(PUBLIC_DIR, name);
  // Belt to the map's braces. The map is the guard; this is the assertion that the
  // map and the filesystem cannot have drifted into naming something outside the
  // directory the map is about.
  const parent = resolve(PUBLIC_DIR, "..");
  if (!path.startsWith(parent + sep)) {
    throw new Error(`Refusing to serve ${name}: ${path} is outside ${PUBLIC_DIR}.`);
  }

  const body = await readFile(path);
  return {
    body,
    contentType,
    etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
  };
}

/** Every filename this server will serve from `public/`, sorted. For tests. */
export function uiAssetNames(): string[] {
  return Object.keys(UI_ASSETS).sort();
}
