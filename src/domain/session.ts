/**
 * Sign-in sessions: an opaque, server-verified stand-in for a wallet signature.
 *
 * ## Why this exists
 *
 * T5 made wallet identity real - a secp256k1 signature over a server-issued,
 * origin-bound, single-use challenge - and paid for it in prompts. Nonces are
 * single-use by design (rubric check 8), so a returning viewer who has bought a
 * seven-frame reel needs **seven signatures** to watch it. That is not a security
 * property, it is a design gap, and T6 closes it.
 *
 * ## The rule this module exists to keep
 *
 * **A session is an identity credential, never an entitlement.**
 *
 * A session says "this request is from wallet 0xabc…". It says nothing about
 * which reels that wallet may watch. Every paid-frame request still performs a
 * server-side `decideEntitlement` lookup keyed on `(session wallet, requested
 * reel)`, so a session for reel A cannot open reel B unless the ledger has a row
 * for it. That is why the session row stores a wallet and *not* a list of reels:
 * a cached list would be a second source of truth that could disagree with the
 * ledger, and a revocation would not reach it.
 *
 * ## What is stored, and what is not
 *
 * The cookie carries a 32-byte random token in base64url. The database stores
 * only its SHA-256. A stolen database therefore does not hand over live sessions,
 * and a token that leaks from one place is not usable anywhere else - there is
 * nothing to look up but a hash, and the hash is not the token.
 *
 * `randomBytes`, not `Math.random` and not a counter: a guessable session token is
 * a session forgery, and it is the one thing in this design that has to be
 * unguessable rather than merely well-formed.
 */

import { createHash, randomBytes } from "node:crypto";

/** 32 bytes of entropy. 256 bits is not a tuning decision, it is the floor. */
export const SESSION_TOKEN_BYTES = 32;

/**
 * The only shape of token this server will even hash.
 *
 * 43 characters is exactly base64url of 32 bytes, unpadded. Anything else is
 * refused *before* it is hashed, so a caller cannot make the server hash an
 * arbitrarily long string, and a mangled cookie fails as "malformed" rather than
 * as a puzzling "unknown".
 */
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Cookie carrying the session token. Named, so a second cookie cannot collide. */
export const SESSION_COOKIE_NAME = "bioscope_session";

/** A fresh, unguessable session token. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/** True for exactly the token shape {@link generateSessionToken} produces. */
export function isCanonicalSessionToken(value: unknown): value is string {
  return typeof value === "string" && SESSION_TOKEN_PATTERN.test(value);
}

/**
 * The lookup key for a token: lowercase hex SHA-256, 64 characters.
 *
 * Deterministic, so it can be a primary key; one-way, so the row is useless to
 * anybody who reads the database.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** One row, as stored. Never contains the token itself. */
export interface SessionRecord {
  /** SHA-256 of the token, hex. The primary key. */
  readonly tokenHash: string;
  /** Normalized lowercase address, recovered from a verified signature. */
  readonly wallet: string;
  /** The origin the session was minted for. Checked on every use. */
  readonly origin: string;
  /** The SIWX nonce that was consumed to create it, for auditing. */
  readonly siwxNonce: string | null;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  /** ISO-8601 UTC. Hard limit; a session cannot outlive this. */
  readonly expiresAt: string;
  /** ISO-8601 UTC, or `null` while live. One-directional: never cleared. */
  readonly revokedAt: string | null;
}

/**
 * Why a session was not honoured.
 *
 * Every value denies. They are kept apart for tests and for logs, not for the
 * wire: an HTTP caller learns only whether it is signed in, never which of these
 * it hit, because distinguishing "expired" from "revoked" from "never existed" is
 * information about rows in somebody else's database.
 */
export type SessionRefusal =
  /** No session cookie on the request. */
  | "no-session"
  /** A cookie was present but its value is not a token we could ever have issued. */
  | "malformed-token"
  /** Well-formed, but no such session. */
  | "unknown-token"
  /** Exists, but was revoked. */
  | "revoked"
  /** Exists, but its lifetime has passed. */
  | "expired"
  /** Exists, but was minted for a different origin than the one serving now. */
  | "wrong-origin";

export type SessionResolution =
  | { readonly ok: true; readonly session: SessionRecord }
  | { readonly ok: false; readonly reason: SessionRefusal };

/** Bounds on `BIOSCOPE_SESSION_TTL_SECONDS`, mirrored in `src/config.ts`. */
export const MIN_SESSION_TTL_SECONDS = 60;
export const MAX_SESSION_TTL_SECONDS = 86_400;
