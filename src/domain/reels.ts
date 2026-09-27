/**
 * The reel catalog.
 *
 * Forty reels went into the brass box; this demo seeds three of them. The
 * catalog is server-owned data: ids, frame order and prices are all decided here
 * and none of it is read from a request.
 *
 * Frame 0 of every reel is the free peek. Frames 1..n-1 are the paid ones. The
 * index is the whole of the ordering contract, so nothing downstream has to
 * guess which frame is which.
 */

import { assertAtomicAmount, type AtomicAmount } from "./amount.js";

/** One frame of a reel. The file for it lives outside this module. */
export interface ReelFrame {
  /** 0-based position in the reel. Frame 0 is the free peek. */
  readonly index: number;
  /** Short caption shown under the frame while it plays. */
  readonly caption: string;
}

export interface Reel {
  /** Stable, URL-safe identifier. Part of the entitlement key. */
  readonly id: string;
  readonly title: string;
  /** Year the reel was cranked, as a number, not a string. */
  readonly year: number;
  readonly place: string;
  readonly blurb: string;
  /** Server-decided price for the whole reel, in USDC base units. */
  readonly priceAtomic: AtomicAmount;
  /** Ordered, 0-based, contiguous, at least two frames long. */
  readonly frames: readonly ReelFrame[];
}

/** The first frame of a reel is free. This is the only definition of "free". */
export function isFreeFrameIndex(index: number): boolean {
  return index === 0;
}

export function reelPaidFrameCount(reel: Reel): number {
  return reel.frames.length - 1;
}

export interface ReelCatalog {
  list(): readonly Reel[];
  /** `null` for an unknown id. Never throws - callers decide what that means. */
  get(id: string): Reel | null;
  has(id: string): boolean;
  /** @throws {UnknownReelError} for an unknown id. */
  require(id: string): Reel;
}

export class UnknownReelError extends Error {
  public constructor(id: unknown) {
    super(`No such reel: ${JSON.stringify(typeof id === "string" ? id : String(id))}`);
    this.name = "UnknownReelError";
  }
}

/** A reel before a price has been applied. */
interface ReelSeed {
  readonly id: string;
  readonly title: string;
  readonly year: number;
  readonly place: string;
  readonly blurb: string;
  readonly captions: readonly string[];
}

/**
 * The three seeded reels.
 *
 * `captions` is one entry per frame and is expanded into a contiguous 0-based
 * `frames` array, so frame order is a property of this list and cannot drift out
 * of sync with the generated image files.
 */
export const REEL_SEEDS: readonly ReelSeed[] = [
  {
    id: "calcutta-tram",
    title: "Tram 14 on College Street",
    year: 1953,
    place: "Calcutta, Bengal",
    blurb:
      "Tapan cranked this one through a whole monsoon. The tram climbs away from College Street and the shutter gets pulled shut on the last frame.",
    captions: [
      "The brass eyepiece is warm already.",
      "Tram 14 waits at the tram shed with its rope coiled.",
      "The conductor climbs, unhurried, for the second time.",
      "College Street: a hand-pulled cart and a very confident crow.",
      "A boy hangs off the rear step, three streets from anywhere.",
      "The rope goes taut and the bell answers it.",
      "Junction with old Calcutta, mid-afternoon, all shutters half down.",
      "The reel runs out mid-crank. Press on to see it again.",
    ],
  },
  {
    id: "durga-puja-procession",
    title: "A Dhunuchi Naash and the Turn of the Wheel",
    year: 1957,
    place: " Ballygunge, Calcutta",
    blurb:
      "Eight frames of a single procession, from the first drum to the last lamp. Rituparna says this is the one strangers ask for twice.",
    captions: [
      "Dawn on the ground floor, and the courtyard is already full.",
      "The idol is lifted, and the whole street leans in.",
      "Dhunuchi naash, and everyone breathes.",
      "Sandalwood smoke, and somebody's dog who does not care.",
      "Children with painted faces, waiting for their turn in the frame.",
      "The dhaki beat changes and the procession changes with it.",
      "Lamps on the last float, and the turn of the wheel.",
      "The wheel turns. That is the whole reel, in one motion.",
    ],
  },
  {
    id: "circus-elephant",
    title: "The Elephant Who Would Not Lie Down",
    year: 1951,
    place: " Mela ground, outside Rajshahi",
    blurb:
      "A circus elephant, a borrowed brass eyepiece, and eight frames of an animal that simply refused the trick. Tapan's favourite.",
    captions: [
      "The tent is up and the crowd is already three deep.",
      "The elephant arrives on rope, and finds the whole thing funny.",
      "The trainer tries the whistle. Nothing happens.",
      "A boot goes somewhere it should not. Nothing still happens.",
      "The crowd starts to laugh, which changes the elephant's mind.",
      "She lies down, on her own terms, and looks at everyone.",
      "Apples, and a very long silence from the trainer.",
      "The last frame is the elephant, alone, walking back.",
    ],
  },
];

/** Frame count every seeded reel has. Kept uniform so seeding stays simple. */
export const FRAMES_PER_REEL = 8;

function buildReel(seed: ReelSeed, priceAtomic: AtomicAmount): Reel {
  assertAtomicAmount(priceAtomic);
  if (seed.captions.length < 2) {
    throw new Error(`Reel ${seed.id} needs at least two frames, one free and one paid.`);
  }
  const frames: ReelFrame[] = seed.captions.map((caption, index) => ({ index, caption }));
  return {
    id: seed.id,
    title: seed.title,
    year: seed.year,
    place: seed.place,
    blurb: seed.blurb,
    priceAtomic,
    frames,
  };
}

/**
 * Build the catalog with a server-decided price.
 *
 * The price is a parameter rather than a constant so that it can come from the
 * environment and be changed in one place. It is never taken from a request.
 */
export function createReelCatalog(priceAtomic: AtomicAmount): ReelCatalog {
  const byId = new Map<string, Reel>();
  for (const seed of REEL_SEEDS) {
    const reel = buildReel(seed, priceAtomic);
    if (byId.has(reel.id)) {
      throw new Error(`Duplicate reel id in seed data: ${reel.id}`);
    }
    byId.set(reel.id, reel);
  }

  return {
    list: () => [...byId.values()],
    get: (id: string) => byId.get(id) ?? null,
    has: (id: string) => byId.has(id),
    require: (id: string) => {
      const reel = byId.get(id);
      if (reel === undefined) {
        throw new UnknownReelError(id);
      }
      return reel;
    },
  };
}
