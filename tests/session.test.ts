/**
 * One signature, the whole reel (T6).
 *
 * ## The problem this solves
 *
 * T5 made sign-in real: a secp256k1 signature over a server-issued, origin-bound,
 * single-use challenge. It also made sign-in *per frame*, because a nonce is
 * single-use by design and the x402 gate asks for a fresh challenge on every
 * protected request. A viewer who bought a seven-frame reel was signing seven times
 * to watch it. T6 adds a session so one signature buys one short window, with no
 * loss of any guarantee T5 established.
 *
 * ## What is deliberately *not* relaxed
 *
 * - **The nonce is still spent.** Minting a session consumes the challenge's nonce
 *   in the same SQLite table the frame gate uses, so one signature is one
 *   signature: it cannot buy a frame grant *and* a session, and it cannot be
 *   replayed at either door.
 * - **Entitlement is still per request.** The session carries a wallet, never a
 *   reel. Every paid frame read runs `decideEntitlement(wallet, requested reel)`
 *   against the ledger, so the cookie decides nothing by itself.
 * - **The signature is still verified here.** `POST /api/session` runs the SDK's own
 *   parse → validate → recover sequence, and there is no verifier seam to bypass
 *   (`tests/siwx-no-double.test.ts`).
 *
 * ## How the negative cases are built
 *
 * Same rule as T5: a refusal is paired with a positive control that differs in one
 * field, so a 402 cannot be confused with a broken server. And every attack here is
 * a *real* cookie carrying a real hash, or a *real* signature over a message the
 * honest client path refused to sign - the tests try to spend a session the way an
 * attacker holding a stolen jar would, not by asking the server to be helpful.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SIGN_IN_WITH_X } from "@x402/extensions/sign-in-with-x";

import { loadConfig } from "../src/config.js";
import { SqliteSessionStore } from "../src/db/session-store.js";
import {
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_PATTERN,
  generateSessionToken,
  hashSessionToken,
} from "../src/domain/session.js";
import { SESSION_ROUTE, clearedSessionCookie, sessionCookieHeader } from "../src/http/routes/session.js";
import { setCookies, type HttpResult } from "./support/http-server.js";
import { createEphemeralWallet } from "./support/test-wallet.js";
import { startBioscopeTestServer, type BioscopeTestServer, type SignInResult } from "./support/bioscope-server.js";

/** The reel the buyer owns. */
const OWNED = "calcutta-tram";
/** A reel nobody in the outer server has bought. */
const NOT_OWNED = "circus-elephant";
/** A wallet with no key behind it. Used only where a *shape* is needed. */
const SOME_WALLET = "0x1111111111111111111111111111111111111111";

let server: BioscopeTestServer;
let buyer: string;

beforeAll(async () => {
  server = await startBioscopeTestServer();
  buyer = server.wallet.address;
  await server.buyFrame(OWNED, 1, buyer);
});

afterAll(async () => {
  await server.cleanup();
});

/** POST a raw SIWX header to the session route and parse the answer. */
async function postSession(header?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await server.request(SESSION_ROUTE, {
    method: "POST",
    ...(header === undefined ? {} : { headers: { [SIGN_IN_WITH_X]: header } }),
  });
  return { status: response.status, body: JSON.parse(response.text) as Record<string, unknown> };
}

/** Sign in over a real 402 challenge, and insist it worked. */
async function signIn(reelId = OWNED): Promise<SignInResult> {
  const result = await server.signIn({ reelId });
  expect(result.response.status, `sign-in failed: ${result.response.text}`).toBe(201);
  return result;
}

/** A paid-frame request carrying a session cookie. */
function withSession(cookie: string, reelId: string, index: number): Promise<HttpResult> {
  return server.paidFrame(reelId, index, { headers: { Cookie: cookie } });
}

/** The same, against a server other than the shared one. */
function withSessionOn(target: BioscopeTestServer, cookie: string, reelId: string, index: number): Promise<HttpResult> {
  return target.paidFrame(reelId, index, { headers: { Cookie: cookie } });
}

describe("one signature opens the rest of the reel", () => {
  it("serves every remaining frame of a purchased reel from a single session", async () => {
    const { cookie } = await signIn();
    const reel = server.catalog.get(OWNED);
    if (reel === null) {
      throw new Error("The catalog lost the reel this suite buys.");
    }

    const verifyBefore = server.facilitator.verifyCalls;
    const settleBefore = server.facilitator.settleCalls;
    const rowsBefore = server.ledger.countPurchases();

    const indices = reel.frames.map((frame) => frame.index).filter((index) => index > 0);
    expect(indices.length, "this reel has too few paid frames to prove anything").toBeGreaterThan(2);

    for (const index of indices) {
      const response = await withSession(cookie, OWNED, index);
      expect(response.status, `frame ${index} of ${OWNED} was not served from the session`).toBe(200);
      const expected = server.paidFrameBytes.get(`${OWNED}/${index}`);
      expect(expected, `the fixture is missing frame ${index}`).toBeDefined();
      expect(response.bytes.equals(expected as Buffer)).toBe(true);
      // A session must not loosen the private-media story by even one header.
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("x-bioscope-frame-kind")).toBe("paid");
      expect(response.headers.get("x-bioscope-settlement-mode")).toBe("simulated");
      expect(response.headers.get("x-bioscope-frame-index")).toBe(String(index));
    }

    // No facilitator contact and no new rows: the session replaced signatures, not
    // money.
    expect(server.facilitator.verifyCalls).toBe(verifyBefore);
    expect(server.facilitator.settleCalls).toBe(settleBefore);
    expect(server.ledger.countPurchases()).toBe(rowsBefore);
  });

  it("spends the signature that minted it, at both doors", async () => {
    const minted = await signIn();

    // The same header again, at the session door.
    const rowsBefore = server.sessions.countSessions();
    const replay = await postSession(minted.header);
    expect(replay.status, "a spent challenge minted a second session").toBe(401);
    expect(replay.body.reason).toBe("challenge-already-used");
    expect(server.sessions.countSessions(), "a refused sign-in wrote a row").toBe(rowsBefore);

    // And the same header at the frame gate, where T5 proved nonces are single-use.
    // Both doors read one table, so one signature cannot serve both.
    const atFrameGate = await server.paidFrame(OWNED, 3, { headers: { [SIGN_IN_WITH_X]: minted.header } });
    expect(atFrameGate.status, "a spent challenge still opened a frame").toBe(402);
  });

  it("cannot reach another reel the same wallet has not bought", async () => {
    const { cookie } = await signIn();
    expect(server.ledger.hasPurchased(buyer, NOT_OWNED)).toBe(false);

    const response = await withSession(cookie, NOT_OWNED, 2);
    expect(response.status, "a session for one reel opened another").toBe(402);
    // The 402 is the ordinary one, price and all: a session that cannot buy anything
    // is indistinguishable from having no session.
    expect(response.headers.get("payment-required")).not.toBeNull();
  });

  it("reaches a second reel only after buying it, with no new signature", async () => {
    // Its own server, so which reels this wallet owns is decided here and not by
    // what an earlier test happened to buy. Sharing the outer server would make
    // this an assertion about test order.
    const fresh = await startBioscopeTestServer();
    try {
      const owner = fresh.wallet.address;
      await fresh.buyFrame(OWNED, 1, owner);
      const minted = await fresh.signIn({ reelId: OWNED });
      expect(minted.response.status).toBe(201);
      expect(minted.body.reels).toEqual([OWNED]);

      expect((await withSessionOn(fresh, minted.cookie, NOT_OWNED, 2)).status).toBe(402);

      await fresh.buyFrame(NOT_OWNED, 1, owner);
      const afterPurchase = await withSessionOn(fresh, minted.cookie, NOT_OWNED, 2);

      expect(afterPurchase.status, "the session did not notice a new purchase").toBe(200);
      expect(afterPurchase.bytes.equals(fresh.paidFrameBytes.get(`${NOT_OWNED}/2`) as Buffer)).toBe(true);
    } finally {
      await fresh.cleanup();
    }
  });

  it("answers 404, not a crash, when a paid frame file is missing from disk", async () => {
    // A session authorizes a request; it does not guarantee the bytes exist. When
    // the store cannot deliver, the answer has to be the same 404 the x402 path
    // gives - and in particular it must not be forwarded as an Express error into
    // the payment middleware, which is where a `next(error)` from this gate would
    // land.
    const brief = await startBioscopeTestServer();
    try {
      await brief.buyFrame(OWNED, 1, brief.wallet.address);
      const minted = await brief.signIn({ reelId: OWNED });
      expect(minted.response.status).toBe(201);

      const target = join(brief.root, "paid-frames", OWNED, "frame-002.svg");
      const original = await readFile(target);
      await rm(target);
      try {
        const gone = await withSessionOn(brief, minted.cookie, OWNED, 2);
        expect(gone.status, "a missing file behind a session was not a 404").toBe(404);
        expect(gone.text).toContain("frame-missing");
      } finally {
        await writeFile(target, original);
      }

      // The session still works for the frames that do exist, so the refusal above
      // was about the file and not about the session.
      const fine = await withSessionOn(brief, minted.cookie, OWNED, 3);
      expect(fine.status).toBe(200);
    } finally {
      await brief.cleanup();
    }
  });

  it("grants a wallet with no purchases nothing at all", async () => {
    // A session is identity, not entitlement. This wallet signs a real challenge,
    // gets a real session, and buys nothing - so every paid frame is still a 402.
    const stranger = createEphemeralWallet();
    const result = await server.signIn({ reelId: OWNED, signer: stranger });
    expect(result.response.status).toBe(201);
    expect(result.body.wallet).toBe(stranger.address);
    expect(result.body.reels, "a session with no purchases claimed some").toEqual([]);

    const response = await withSession(result.cookie, OWNED, 2);
    expect(response.status, "an unpaid wallet walked in with a session").toBe(402);
  });
});

describe("no endpoint will tell you about somebody else's wallet", () => {
  it("answers nothing useful when asked about another address", async () => {
    // The session is a bearer credential, so the obvious question a reviewer asks is
    // whether the *reverse* also works: can a stranger look up whether some address
    // has bought a reel? There is no route that takes a wallet, and this walks the
    // plausible shapes to prove it rather than asserting it in prose.
    //
    // Two wallets exist in this server: `buyer`, who paid, and the freshly generated
    // `stranger`, who has not. Every probe below asks about the buyer while
    // presenting no session, and the answer must be the same 200/`signedIn: false`
    // an anonymous visitor already gets.
    const stranger = createEphemeralWallet();
    const anonymous = await server.whoami();
    expect(JSON.parse(anonymous.text)).toMatchObject({ signedIn: false, reels: [] });

    const probes: Array<{ path: string; init?: RequestInit }> = [
      { path: `${SESSION_ROUTE}?wallet=${buyer}` },
      { path: `${SESSION_ROUTE}/${buyer}` },
      { path: `${SESSION_ROUTE}/${buyer}/reels` },
      { path: `/api/reels?wallet=${buyer}` },
      { path: `/api/reels/${OWNED}?wallet=${buyer}` },
      { path: `/api/reels/${OWNED}/purchased?wallet=${buyer}` },
      { path: `/api/reels/${OWNED}/entitlement?address=${buyer}` },
      { path: `/api/purchases?wallet=${buyer}` },
      { path: `/api/wallet/${buyer}/reels` },
    ];

    for (const probe of probes) {
      const response = await server.request(probe.path, probe.init);
      // The 404 handler echoes the request path in `detail`, and several of these
      // probes put words like "purchased" and a wallet address *in* the path
      // themselves. So the echo is dropped before anything is asserted: the claim is
      // about what the server says, not about what the caller just typed at it.
      const { detail: _echo, ...answer } = JSON.parse(response.text) as Record<string, unknown>;
      const text = JSON.stringify(answer).toLowerCase();

      // No yes, and no list. Those are the two things an attacker is after.
      expect(text, `${probe.path} said "purchased"`).not.toContain("purchased");
      expect(text, `${probe.path} said "unlocked"`).not.toContain("unlocked");
      expect(text, `${probe.path} said "entitled"`).not.toContain("entitled");
      expect(text, `${probe.path} returned a purchase record`).not.toMatch(/amountatomic|transactionref|"payer"/);
      expect(text, `${probe.path} leaked a session cookie`).not.toContain("bioscope_session=");

      // A list of reel **ids** is the only shape in this API that means "these
      // belong to that wallet" - `GET /api/session` returns exactly that. The
      // catalogue also has a `reels` key, but its entries are objects describing
      // every reel in the box, which is public by design and not purchase state. So
      // the test is on the *element* type: an array of ids may be absent or empty,
      // and may never be full.
      const reels = answer.reels;
      if (Array.isArray(reels)) {
        const ids = reels.filter((entry): entry is string => typeof entry === "string");
        expect(ids, `${probe.path} listed reel ids for a queried wallet`).toEqual([]);
      }
    }

    // The same probes with a token that is not a session: still nothing. The echo
    // is dropped here too, for the same reason.
    const fake = "A".repeat(43);
    for (const probe of probes) {
      const response = await server.request(probe.path, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${fake}` },
      });
      const { detail: _echo, ...answer } = JSON.parse(response.text) as Record<string, unknown>;
      const text = JSON.stringify(answer).toLowerCase();
      expect(text, `${probe.path} with a fake cookie`).not.toContain("purchased");
      expect(text, `${probe.path} with a fake cookie`).not.toContain("signedin\":true");
      expect(text, `${probe.path} with a fake cookie echoed the token`).not.toContain(fake.toLowerCase());
    }

    // The one route that does report a wallet reports *the caller's own*, and only
    // because the caller proved it with a signature.
    const theirs = await server.signIn({ reelId: OWNED, signer: stranger });
    expect(theirs.response.status).toBe(201);
    expect(theirs.body.wallet).toBe(stranger.address);
    expect(theirs.body.reels, "a stranger was shown the buyer's purchases").toEqual([]);
  });
});

describe("a session is only ever as good as the wallet it was minted for", () => {
  it("names the wallet recovered from the signature, not one the client claims", async () => {
    const stranger = createEphemeralWallet();
    // A perfectly good signature over a message that claims to be somebody else.
    // Recovery yields the stranger, the claim yields `SOME_WALLET`, and only one of
    // them is ever used.
    const readdressed = await server.signChallenge(
      await server.requirementFor(OWNED),
      { address: SOME_WALLET },
      stranger,
    );
    const result = await postSession(readdressed);
    expect(result.status, "a re-addressed challenge was accepted").toBe(401);
    expect(result.body.reason).toBe("signature-rejected");

    // The control: the same key, claiming itself, is accepted - and the wallet in
    // the session is the recovered (lowercase) address, not whatever spelling the
    // payload happened to carry.
    const honest = await postSession(
      await server.signChallenge(await server.requirementFor(OWNED), {}, stranger),
    );
    expect(honest.status).toBe(201);
    expect(honest.body.wallet).toBe(stranger.address);
  });

  it("ignores a wallet, reel or unlock flag sent in the query", async () => {
    const minted = await signIn();

    // Nothing a client can put on the wire adds an entitlement.
    const greedy = await server.request(
      `${SESSION_ROUTE}?wallet=${SOME_WALLET}&paid=1&unlocked=true&reels=*`,
      { method: "POST", headers: { [SIGN_IN_WITH_X]: minted.header, Cookie: minted.cookie } },
    );
    expect(greedy.status).toBe(401);

    // And the session that does exist still only reaches what was bought.
    expect((await withSession(minted.cookie, NOT_OWNED, 2)).status).toBe(402);
    expect((await withSession(minted.cookie, OWNED, 2)).status).toBe(200);
  });

  it("does not let one wallet's session carry another's entitlement", async () => {
    // Two real keys, two real sessions, one server. The second wallet has bought
    // nothing, so its cookie is a valid credential for nothing at all.
    const other = createEphemeralWallet();
    const theirs = await server.signIn({ reelId: OWNED, signer: other });
    expect(theirs.response.status).toBe(201);
    expect(theirs.body.wallet).toBe(other.address);
    expect(theirs.body.reels).toEqual([]);

    const crossed = await withSession(theirs.cookie, OWNED, 2);
    expect(crossed.status, "an unpaid wallet's session opened a paid frame").toBe(402);
    expect(server.ledger.hasPurchased(other.address, OWNED)).toBe(false);

    // The buyer's own session is untouched by the neighbour's.
    const mine = await signIn();
    expect((await withSession(mine.cookie, OWNED, 2)).status).toBe(200);
  });
});

describe("a session cannot be forged, edited, or used after it dies", () => {
  it("stores only a hash, and issues an unguessable token", async () => {
    const { token } = await signIn();
    expect(token, "the token is not the shape this server issues").toMatch(SESSION_TOKEN_PATTERN);
    // 43 base64url characters is 32 bytes of entropy, and the row holds the hash.
    expect(token).toHaveLength(43);

    const row = server.sessions
      .listForWallet(buyer)
      .find((session) => session.tokenHash === hashSessionToken(token));
    expect(row, "no row for the token that was just issued").toBeDefined();
    expect(JSON.stringify(row), "the row leaked the token").not.toContain(token);
    expect(row?.wallet).toBe(buyer);
  });

  it("issues a different token every time", async () => {
    const first = await signIn();
    const second = await signIn();
    expect(first.token).not.toBe(second.token);
  });

  it("refuses a token nobody issued", async () => {
    // Generated exactly the way the server generates them, by a party that is not
    // the server. This is the stolen-jar case: right shape, wrong provenance.
    const forged = generateSessionToken();
    const response = await withSession(server.cookieFor(forged), OWNED, 2);
    expect(response.status, "a made-up token opened a frame").toBe(402);

    // The control: a real token, same request, same server.
    expect((await withSession((await signIn()).cookie, OWNED, 2)).status).toBe(200);
  });

  it("refuses a token with one character changed", async () => {
    const { cookie, token } = await signIn();
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    const response = await withSession(server.cookieFor(tampered), OWNED, 2);
    expect(response.status, "a tampered token opened a frame").toBe(402);
    expect((await withSession(cookie, OWNED, 2)).status, "the control request failed").toBe(200);
  });

  it("refuses a token that is not even the right shape", async () => {
    for (const junk of ["", "x", "not-a-token", "a".repeat(44), "a".repeat(42), "../../etc/passwd"]) {
      const response = await withSession(server.cookieFor(junk), OWNED, 2);
      expect(response.status, `a junk cookie ${JSON.stringify(junk)} opened a frame`).toBe(402);
    }
  });

  it("expires on schedule, and use does not extend it", async () => {
    // A clock the session store reads, so a 60-second lifetime can be crossed in a
    // millisecond. The config loader refuses a TTL under 60s, so sleeping is not an
    // option a test can afford.
    const epoch = Date.parse("2026-01-01T00:00:00.000Z");
    let clock = new Date(epoch);
    const brief = await startBioscopeTestServer({ sessionTtlSeconds: 60, now: () => clock });
    try {
      const owner = brief.wallet.address;
      await brief.buyFrame(OWNED, 1, owner);
      const minted = await brief.signIn({ reelId: OWNED });
      expect(minted.response.status).toBe(201);
      expect(minted.body.expiresAt).toBe(new Date(epoch + 60_000).toISOString());

      const open = () => brief.paidFrame(OWNED, 2, { headers: { Cookie: minted.cookie } });

      clock = new Date(epoch + 59_000);
      expect((await open()).status, "the session died early").toBe(200);

      // Asking again on the last second does not buy another second.
      expect((await open()).status).toBe(200);

      clock = new Date(epoch + 60_000);
      expect((await open()).status, "the session outlived its lifetime").toBe(402);

      const reason = brief.sessions.resolve(minted.token, brief.origin);
      expect(reason.ok).toBe(false);
      if (!reason.ok) {
        expect(reason.reason).toBe("expired");
      }
    } finally {
      await brief.cleanup();
    }
  });

  it("stops working the moment it is revoked", async () => {
    const minted = await signIn();
    expect((await withSession(minted.cookie, OWNED, 2)).status).toBe(200);

    const out = await server.signOut(minted.cookie);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.text).revoked).toBe(true);

    const response = await withSession(minted.cookie, OWNED, 2);
    expect(response.status, "a revoked session still opened a frame").toBe(402);

    // Revocation is one-directional, and the row keeps the timestamp for an operator.
    const row = server.sessions
      .listForWallet(buyer)
      .find((session) => session.tokenHash === hashSessionToken(minted.token));
    expect(row?.revokedAt).not.toBeNull();

    // Signing in again is how a viewer comes back, and it costs a fresh signature.
    const again = await signIn();
    expect(again.token).not.toBe(minted.token);
    expect((await withSession(again.cookie, OWNED, 2)).status).toBe(200);
  });

  it("refuses a session minted for a different origin", async () => {
    // Two servers, one database file, two origins. The token is real, live and
    // unrevoked - it simply belongs to another origin, which is what the binding is
    // for. Every test server reserves a fresh port, so this is also the shape a
    // restart on a new port takes.
    const root = await mkdtemp(join(tmpdir(), "bioscope-session-origin-"));
    const dbPath = join(root, "purchases.db");
    const storageRoot = join(root, "frames");
    let first: BioscopeTestServer | null = null;
    let second: BioscopeTestServer | null = null;
    try {
      const { seedFrames } = await import("../src/media/seed-frames.js");
      const { createReelCatalog } = await import("../src/domain/reels.js");
      await seedFrames({ root: storageRoot, catalog: createReelCatalog("1000") });

      const holder = createEphemeralWallet();
      first = await startBioscopeTestServer({ dbPath, storageRoot, siwxSigner: holder });
      await first.buyFrame(OWNED, 1, holder.address);
      const minted = await first.signIn({ reelId: OWNED });
      expect(minted.response.status).toBe(201);
      expect((await withSessionOn(first, minted.cookie, OWNED, 2)).status).toBe(200);

      // The same database, a different process, a different origin.
      second = await startBioscopeTestServer({ dbPath, storageRoot, siwxSigner: holder });
      expect(second.origin).not.toBe(first.origin);
      expect(second.sessions.countSessions(), "the session row did not survive").toBe(1);

      const crossed = await second.paidFrame(OWNED, 2, { headers: { Cookie: minted.cookie } });
      expect(crossed.status, "a session crossed an origin boundary").toBe(402);

      // The store says exactly why, which is the difference between "refused" and
      // "understood".
      const reason = second.sessions.resolve(minted.token, second.origin);
      expect(reason.ok).toBe(false);
      if (!reason.ok) {
        expect(reason.reason).toBe("wrong-origin");
      }
      // The row itself is intact and unrevoked: only the origin check refuses it.
      const sameOrigin = first.sessions.resolve(minted.token, first.origin);
      expect(sameOrigin.ok).toBe(true);

      // Signing in again on the new origin works, and reaches the same purchase.
      const fresh = await second.signIn({ reelId: OWNED });
      expect(fresh.response.status).toBe(201);
      expect(fresh.body.wallet).toBe(holder.address);
      expect((await second.paidFrame(OWNED, 2, { headers: { Cookie: fresh.cookie } })).status).toBe(200);
    } finally {
      await first?.cleanup();
      await second?.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a session survives a store reopen, because the row is the session", () => {
  it("resolves from the same file after every handle is closed", async () => {
    // The persistence claim at its narrowest: no process, no memory, just the file.
    const dbPath = join(await mkdtemp(join(tmpdir(), "bioscope-session-db-")), "sessions.db");
    const origin = "http://127.0.0.1:9999";

    const opened = new SqliteSessionStore({ databasePath: dbPath });
    const created = opened.create({ wallet: SOME_WALLET, origin, ttlSeconds: 60 });
    expect(opened.resolve(created.token, origin).ok).toBe(true);
    opened.close();

    const reopened = new SqliteSessionStore({ databasePath: dbPath });
    try {
      const resolved = reopened.resolve(created.token, origin);
      expect(resolved.ok, "a session did not survive the file being closed").toBe(true);
      expect(reopened.countSessions()).toBe(1);
      // Same file, different origin: still refused, so persistence is not the same
      // thing as portability.
      expect(reopened.resolve(created.token, "http://elsewhere.test").ok).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("prunes dead sessions when a new one is minted, and keeps revoked rows", async () => {
    // Housekeeping, asserted because a table that only grows is a slow leak.
    const dbPath = join(await mkdtemp(join(tmpdir(), "bioscope-session-prune-")), "sessions.db");
    const origin = "http://127.0.0.1:9999";
    const store = new SqliteSessionStore({ databasePath: dbPath });
    try {
      const dead = store.create({ wallet: SOME_WALLET, origin, ttlSeconds: 60 }, new Date(0));
      const revoked = store.create({ wallet: SOME_WALLET, origin, ttlSeconds: 60 }, new Date(0));
      store.revoke(revoked.token, new Date(0));
      expect(store.countSessions()).toBe(2);

      store.pruneExpired(new Date(120_000));
      const remaining = store.listForWallet(SOME_WALLET);
      expect(remaining.map((row) => row.tokenHash)).toEqual([hashSessionToken(revoked.token)]);
      expect(remaining[0]?.revokedAt).not.toBeNull();
      expect(store.resolve(dead.token, origin, new Date(120_000)).ok).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("a session can only come from a signature that is still good", () => {
  it("refuses an expired challenge", async () => {
    const result = await server.signIn({
      reelId: OWNED,
      overrides: { expirationTime: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(result.response.status).toBe(401);
    expect(result.body.reason).toBe("challenge-rejected");
    expect(result.cookie).toBe("");
  });

  it("refuses a challenge bound to another origin, however well it is signed", async () => {
    const foreign = "http://127.0.0.1:1";
    const result = await server.signIn({
      reelId: OWNED,
      overrides: { domain: foreign, uri: `${foreign}/reels/${OWNED}/unlock` },
    });
    expect(result.response.status).toBe(401);
    expect(result.body.reason).toBe("challenge-rejected");
  });

  it("refuses an unsigned header, a wrong key, and nonsense", async () => {
    const rowsBefore = server.sessions.countSessions();
    const requirements = await server.requirementFor(OWNED);

    // A non-signature, claiming the buyer, over a genuine challenge.
    const unsigned = server.unverifiedHeader(requirements, "0xtest", buyer);
    expect((await postSession(unsigned)).status).toBe(401);

    // A real signature by a real key that has bought nothing, claiming the buyer.
    const stranger = createEphemeralWallet();
    const wrongKey = await server.signChallenge(
      requirements,
      { address: buyer as `0x${string}` },
      stranger,
    );
    expect((await postSession(wrongKey)).status).toBe(401);

    for (const junk of ["", "not-base64!!", Buffer.from("{not json").toString("base64")]) {
      expect((await postSession(junk)).status, `junk header ${JSON.stringify(junk)} was accepted`).toBe(401);
    }

    expect(server.sessions.countSessions(), "a refused sign-in wrote a row").toBe(rowsBefore);
  });

  it("reports a missing challenge as a missing challenge", async () => {
    const response = await postSession();
    expect(response.status).toBe(401);
    expect(response.body.reason).toBe("no-challenge");
  });
});

describe("the cookie is as locked down as the token", () => {
  it("sets HttpOnly, SameSite=Strict, Path=/ and a Max-Age, and omits Secure on http", async () => {
    const minted = await signIn();
    const cookie = minted.setCookie;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${minted.token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=900");
    // The documented localhost exception: this demo is served over plain http, where
    // a Secure cookie is dropped by the browser and every session would look broken.
    expect(cookie).not.toContain("Secure");
    expect(server.origin.startsWith("http://")).toBe(true);
    // Host-only: no Domain attribute, so a sibling subdomain cannot present it.
    expect(cookie.toLowerCase()).not.toContain("domain=");
  });

  it("adds Secure when, and only when, the configured origin is https", async () => {
    // Asserted on the pure function rather than over a socket, because there is no
    // TLS in this suite and faking one would be theatre. The flag is derived from
    // configuration, and `loadConfig` guarantees an http(s) origin, so the
    // derivation is the whole behaviour.
    const overHttp = loadConfig({ BIOSCOPE_ORIGIN: "http://localhost:8787" });
    const overHttps = loadConfig({ BIOSCOPE_ORIGIN: "https://bioscope.example" });

    expect(sessionCookieHeader("token", overHttp)).not.toContain("Secure");
    expect(sessionCookieHeader("token", overHttps)).toContain("Secure");
    // The other flags are identical either way: TLS is not a reason to relax
    // HttpOnly, and there is no reason to relax them on localhost.
    for (const config of [overHttp, overHttps]) {
      const header = sessionCookieHeader("token", config);
      expect(header).toContain("HttpOnly");
      expect(header).toContain("SameSite=Strict");
      expect(header).toContain(`Max-Age=${config.sessionTtlSeconds}`);
    }
    expect(clearedSessionCookie(overHttp)).toContain("Max-Age=0");
    expect(clearedSessionCookie(overHttps)).toContain("Secure");
  });

  it("clears the cookie on sign-out, whatever was presented", async () => {
    const minted = await signIn();
    const cleared = setCookies(await server.signOut(minted.cookie));
    expect(cleared.join(";")).toContain("Max-Age=0");
    expect(cleared.join(";")).toContain("HttpOnly");

    const nothing = await server.signOut();
    expect(nothing.status).toBe(200);
    expect(JSON.parse(nothing.text).revoked).toBe(false);
  });

  it("reports who is signed in, without a session failing the request", async () => {
    const none = await server.whoami();
    expect(none.status).toBe(200);
    expect(JSON.parse(none.text)).toMatchObject({ ok: true, signedIn: false, reels: [] });

    const minted = await signIn();
    const who = await server.whoami(minted.cookie);
    expect(who.status).toBe(200);
    expect(JSON.parse(who.text)).toMatchObject({ ok: true, signedIn: true, wallet: buyer, reels: [OWNED] });
  });

  it("reports nobody signed in once the session is gone", async () => {
    const minted = await signIn();
    await server.signOut(minted.cookie);
    expect(JSON.parse((await server.whoami(minted.cookie)).text)).toMatchObject({ signedIn: false });
  });
});
