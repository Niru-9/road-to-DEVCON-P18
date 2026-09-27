/**
 * The bridge between an x402 resource and a reel.
 *
 * ## Why this module exists
 *
 * The x402 Sign-In-With-X storage contract is keyed by a *resource string*
 * (`hasPaid(resource, address)`), not by a reel id. That is the exact place
 * where rubric check 9 is lost: an implementation that stores "this wallet has
 * paid" without ever resolving the resource down to one reel will hand out every
 * reel to whoever paid for one, and the bioscope will quietly become "pay once,
 * watch everything".
 *
 * So the resource string is made reel-scoped by construction, and the mapping is
 * a total function with a defined failure direction: an unrecognized resource
 * resolves to `null`, and every caller treats `null` as *deny*. Nothing here can
 * return a reel id it is not sure about.
 *
 * The path shape is `/reels/:reelId/unlock`. `reelId` is constrained so a
 * resource string can never be crafted to name some other reel, to smuggle a
 * query or a fragment, or to collide with a second reel after normalization.
 */

/** Canonical resource path for a reel's unlock. */
export function reelUnlockResource(reelId: string): string {
  if (!isSafeReelId(reelId)) {
    throw new Error(`Unsafe reel id for a resource path: ${JSON.stringify(reelId)}`);
  }
  return `/reels/${reelId}/unlock`;
}

const REEL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_PATTERN = /^\/reels\/([a-z0-9]+(?:-[a-z0-9]+)*)\/unlock$/;

/**
 * True for an id that is safe to put in a path and to compare byte-for-byte.
 *
 * Lowercase alphanumerics in dash-separated groups. Deliberately narrower than
 * the seeded ids need and wider than nothing: no dots, no slashes, no uppercase,
 * no percent-encoding, so there is no second spelling of the same reel.
 */
export function isSafeReelId(value: unknown): value is string {
  return typeof value === "string" && REEL_ID_PATTERN.test(value);
}

/**
 * Resolve a resource string to the reel it names.
 *
 * @returns the reel id, or `null` when the resource is not one of ours. Callers
 * must deny on `null`.
 */
export function reelIdFromResource(resource: unknown): string | null {
  if (typeof resource !== "string") {
    return null;
  }
  const match = RESOURCE_PATTERN.exec(resource);
  return match?.[1] ?? null;
}
