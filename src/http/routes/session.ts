/**
 * Sign-in sessions over HTTP: three endpoints, and one gate in front of x402.
 *
 * ```
 *   GET    /api/session    who am I, if anyone          (never fails; `signedIn: false`)
 *   POST   /api/session    mint one, from a SIWX header (401 unless the signature verifies)
 *   DELETE /api/session    revoke the one presented     (idempotent; always clears the cookie)
 *   sessionFrameGate       answer a paid frame from a live session, or get out of the way
 * ```
 *
 * ## The only way a session comes into existence
 *
 * `POST /api/session`, with a `sign-in-with-x` header the server verifies itself:
 * parsed by the SDK, origin-checked against the configured origin, signature
 * recovered by viem, nonce checked and then consumed. There is no second mint
 * path - not on payment, not on a first visit, not from a query parameter - and
 * that is the point. One creation site means one place to audit, and it means a
 * session can never exist for a wallet whose signature was not checked.
 *
 * The nonce is consumed whether or not the session is useful: presenting a
 * challenge that has already been spent is a 401 and *still* burns nothing twice,
 * because it was already burnt. Presenting a fresh one always costs the viewer
 * their nonce, which is what stops a captured header from being replayed to mint a
 * session after it was replayed once at the frame gate.
 *
 * ## What a session is not
 *
 * It is not an entitlement. `POST /api/session` succeeds for a wallet that has
 * bought nothing, and the response says so by listing zero reels. Every paid-frame
 * request re-runs `decideEntitlement` against the ledger with the session's wallet
 * and the *requested* reel, so the answer cannot come from the cookie, from a
 * query parameter, or from anything the client holds. The cookie is a key; the
 * ledger is the lock.
 *
 * ## The cookie, and the one localhost-specific decision
 *
 * ```
 *   bioscope_session=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<ttl>[; Secure]
 * ```
 *
 * - `HttpOnly` - script cannot read it, so an XSS on this origin cannot exfiltrate
 *   a session. There is no client-side JavaScript in P3 today; T7 must not need
 *   any, and this is the flag that keeps that true.
 * - `SameSite=Strict` - the cookie is not attached to cross-site requests, so a
 *   link from another site cannot spend a viewer's session.
 * - `Secure` **only when the configured origin is https**. This is the
 *   localhost-specific setting: the demo runs on `http://localhost`, where a
 *   `Secure` cookie is silently dropped by the browser and every session would
 *   appear broken. The decision is derived from `BIOSCOPE_ORIGIN` rather than
 *   hard-coded, so putting the app behind TLS switches it on with no code change
 *   and no way to leave it off in production by accident.
 * - No `Domain` attribute - host-only, so a sibling subdomain cannot present it.
 *
 * ## The token never appears in a response body
 *
 * It is in the `Set-Cookie` header, which is where a browser needs it, and nowhere
 * else. A token in a JSON body is a token in a log, a screenshot, or a support
 * transcript. `curl -i` still shows it, because the header is right there.
 */

import { Router, type NextFunction, type Request, type Response } from "express";

import {
  SIGN_IN_WITH_X,
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
} from "@x402/extensions/sign-in-with-x";

import type { BioscopeConfig } from "../../config.js";
import type { SqliteSessionStore } from "../../db/session-store.js";
import { decideEntitlement, type PurchaseLedger, type SettlementMode } from "../../domain/entitlement.js";
import type { ReelCatalog } from "../../domain/reels.js";
import { SESSION_COOKIE_NAME, isCanonicalSessionToken, type SessionRecord } from "../../domain/session.js";
import { tryNormalizeWalletAddress } from "../../domain/wallet.js";
import type { FrameStore } from "../../media/frame-store.js";
import { paidAreaOf, resolvePaidFrame, respondToFrameError, servePaidFrame } from "./paid-frame.js";

/** The one route prefix that deals in sessions. */
export const SESSION_ROUTE = "/api/session";

/**
 * Why a session could not be created.
 *
 * Reported to the client, unlike `SessionRefusal`: the caller already knows what
 * it sent, so naming the step that failed is a debugging aid rather than a leak.
 * The values are fixed strings - no address, no origin, no row content.
 */
export type SessionCreationFailure =
  | "no-challenge"
  | "malformed-challenge"
  | "challenge-rejected"
  | "signature-rejected"
  | "challenge-already-used";

function signInRefused(res: Response, failure: SessionCreationFailure): void {
  res.status(401).json({
    ok: false,
    error: "sign-in-required",
    reason: failure,
    detail:
      "POST a `sign-in-with-x` header carrying a signature over a challenge this server issued, " +
      "for this origin, that has not been used yet.",
  });
}

/** Read our cookie out of a `Cookie` header, or `null`. */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header === "") {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    // A value we would never have issued is refused before it reaches the store,
    // so a mangled cookie cannot become a database lookup, and cannot become a
    // 43-character timing oracle either.
    return isCanonicalSessionToken(value) ? value : null;
  }
  return null;
}

/**
 * `Secure` exactly when the configured origin is https. See the module comment.
 *
 * Derived from configuration rather than hard-coded, because the answer is not a
 * property of the code but of where the app is served: a browser silently drops a
 * `Secure` cookie over plain http, so hard-coding it would make every session on
 * `http://localhost` fail in a way that looks like a bug in the session logic.
 * Switching `BIOSCOPE_ORIGIN` to https is the only thing that turns it on.
 */
export function cookieIsSecure(config: BioscopeConfig): boolean {
  return config.origin.startsWith("https://");
}

/**
 * The `Set-Cookie` value for a live session.
 *
 * Exported, and a pure function, so the flag policy can be asserted without
 * standing up a server or faking TLS. It is the only place a session cookie is
 * written, so there is no second rendering to drift.
 */
export function sessionCookieHeader(token: string, config: BioscopeConfig): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${config.sessionTtlSeconds}`,
  ];
  if (cookieIsSecure(config)) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

/** The `Set-Cookie` value that removes a session cookie. Same flags, zero lifetime. */
export function clearedSessionCookie(config: BioscopeConfig): string {
  return sessionCookieHeader("", { ...config, sessionTtlSeconds: 0 });
}

function setSessionCookie(res: Response, token: string, config: BioscopeConfig): void {
  res.setHeader("Set-Cookie", sessionCookieHeader(token, config));
}

function clearSessionCookie(res: Response, config: BioscopeConfig): void {
  res.setHeader("Set-Cookie", clearedSessionCookie(config));
}

export interface SessionRouterDeps {
  readonly config: BioscopeConfig;
  readonly sessions: SqliteSessionStore;
  /** The same nonce store the SIWX extension uses, so one nonce has one home. */
  readonly siwxStorage: { hasUsedNonce(nonce: string): boolean; recordNonce(nonce: string): void };
  readonly ledger: PurchaseLedger;
}

/**
 * Mint a session, if and only if a signature over a live, unused, origin-bound
 * challenge verifies here.
 *
 * Note what is *not* read from the request besides the header: no body, no query,
 * no `wallet` field. The wallet in the response is the one recovered from the
 * signature, which is the only wallet this endpoint is capable of naming.
 */
async function createSession(req: Request, res: Response, deps: SessionRouterDeps): Promise<void> {
  const header = req.get(SIGN_IN_WITH_X);
  if (header === undefined || header === "") {
    signInRefused(res, "no-challenge");
    return;
  }

  let payload;
  try {
    payload = parseSIWxHeader(header);
  } catch {
    signInRefused(res, "malformed-challenge");
    return;
  }

  // Origin, issuedAt, expiration, notBefore. The same check the extension's
  // request hook runs, against the same configured origin, so a challenge this
  // endpoint accepts is one the frame gate would also accept.
  const validation = await validateSIWxMessage(payload, new URL(deps.config.origin));
  if (!validation.isValid) {
    signInRefused(res, "challenge-rejected");
    return;
  }

  // Real recovery. There is no `evmVerifier` to inject, and `tests/siwx-no-double.test.ts`
  // fails if one comes back, so "verified" here means cryptographically verified.
  const verification = await verifySIWxSignature(payload);
  const wallet = verification.isValid ? tryNormalizeWalletAddress(verification.payer) : null;
  if (wallet === null) {
    signInRefused(res, "signature-rejected");
    return;
  }

  // Single use, checked *before* anything is written and consumed exactly once.
  // This is what makes a challenge unusable for both purposes: a header already
  // spent at the frame gate cannot come here and mint a session, and a header
  // spent here cannot be replayed at the frame gate.
  if (deps.siwxStorage.hasUsedNonce(payload.nonce)) {
    signInRefused(res, "challenge-already-used");
    return;
  }
  deps.siwxStorage.recordNonce(payload.nonce);

  // Opportunistic cleanup, so a long-running demo does not accumulate dead rows.
  deps.sessions.pruneExpired();

  const created = deps.sessions.create({
    wallet,
    origin: deps.config.origin,
    siwxNonce: payload.nonce,
    ttlSeconds: deps.config.sessionTtlSeconds,
  });

  setSessionCookie(res, created.token, deps.config);
  res.status(201).json({
    ok: true,
    signedIn: true,
    wallet,
    createdAt: created.record.createdAt,
    expiresAt: created.record.expiresAt,
    // Informational only, and the reason it is here rather than guessed at: the UI
    // needs to say "you already own these". Access is still decided per request.
    reels: reelsFor(deps.ledger, wallet),
  });
}

function reelsFor(ledger: PurchaseLedger, wallet: string): string[] {
  return ledger.listPurchases(wallet).map((purchase) => purchase.reelId);
}

function describeSession(session: SessionRecord, deps: SessionRouterDeps): Record<string, unknown> {
  return {
    ok: true,
    signedIn: true,
    wallet: session.wallet,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    reels: reelsFor(deps.ledger, session.wallet),
  };
}

export function buildSessionRouter(deps: SessionRouterDeps): Router {
  const router = Router();

  // Introspection, for the UI's "already watching" state. Deliberately answers
  // 200 with `signedIn: false` rather than 401: "nobody is signed in" is not an
  // error condition for a page that has to render either way, and a 401 here
  // would train clients to treat one as normal.
  router.get(SESSION_ROUTE, (req, res) => {
    const token = readSessionCookie(req);
    if (token === null) {
      res.json({ ok: true, signedIn: false, reels: [] });
      return;
    }
    const resolved = deps.sessions.resolve(token, deps.config.origin);
    if (!resolved.ok) {
      res.json({ ok: true, signedIn: false, reels: [] });
      return;
    }
    res.json(describeSession(resolved.session, deps));
  });

  router.post(SESSION_ROUTE, (req, res, next) => {
    void createSession(req, res, deps).catch(next);
  });

  // Logout. Idempotent, and it clears the cookie whatever it found: a client that
  // presents a stale token should still end up with no cookie, not with a cookie
  // it believes it just deleted.
  router.delete(SESSION_ROUTE, (req, res) => {
    const token = readSessionCookie(req);
    const revoked = token === null ? false : deps.sessions.revoke(token);
    clearSessionCookie(res, deps.config);
    res.json({ ok: true, signedIn: false, revoked });
  });

  return router;
}

export interface SessionFrameGateDeps extends SessionRouterDeps {
  readonly catalog: ReelCatalog;
  readonly frames: FrameStore;
  readonly settlementMode: SettlementMode;
}

/**
 * Serve a paid frame for a live session, or step aside.
 *
 * Mounted after `paidFrameGate` and before the x402 middleware. It answers only
 * when all four of these hold, and each one is a separate lookup rather than a
 * combined check, so the code reads as the four questions it is actually asking:
 *
 * 1. Is this a paid-frame request at all? (No - step aside.)
 * 2. Is there a live session for *this* origin? (No - step aside, and the 402
 *    that follows is exactly what a stranger without a session gets.)
 * 3. Has that session's wallet bought *this* reel? (No - step aside. This is the
 *    answer to "a session for reel A must not unlock reel B": the reel comes from
 *    the request, never from the session.)
 * 4. Then, and only then, the frame is read and written by the one shared
 *    function the x402 path uses.
 *
 * Stepping aside rather than refusing is deliberate: a session is an additional
 * way to prove identity, not a new gate that sits in front of the old one. A
 * viewer with no session and a viewer with a useless session get the same 402.
 */
export function sessionFrameGate(deps: SessionFrameGateDeps) {
  return function gate(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    const area = paidAreaOf(req.path);
    if (area === null || area.file === null) {
      next();
      return;
    }

    // Re-resolved, not trusted. `paidFrameGate` already refused anything
    // malformed, and this is what keeps the two middlewares from being swapped
    // without consequence.
    const resolution = resolvePaidFrame(deps.catalog, area.reelId, area.file);
    if (!resolution.ok) {
      next();
      return;
    }

    const token = readSessionCookie(req);
    if (token === null) {
      next();
      return;
    }

    const resolved = deps.sessions.resolve(token, deps.config.origin);
    if (!resolved.ok) {
      next();
      return;
    }

    const decision = decideEntitlement({
      ledger: deps.ledger,
      catalog: deps.catalog,
      wallet: resolved.session.wallet,
      reelId: resolution.reelId,
    });
    if (!decision.granted) {
      next();
      return;
    }

    // Answered here, so nothing downstream of `next` runs - and a media failure is
    // mapped rather than forwarded. Handing an error to `next` from here would pass
    // it to the x402 middleware as if it were a request, which is the kind of
    // accident that turns a missing file into a 500 from somewhere else entirely.
    void servePaidFrame(res, deps.frames, resolution, deps.settlementMode).catch((error: unknown) => {
      if (!respondToFrameError(res, error)) {
        next(error);
      }
    });
  };
}
