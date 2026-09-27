/**
 * Durable session storage, on SQLite, beside the purchase ledger.
 *
 * ## Why its own connection to the same file
 *
 * The purchase store owns its `DatabaseSync` handle and its schema, and T2 gave it
 * exactly the surface a ledger needs plus the two nonce methods the SIWX
 * extension asks for. Widening it into "the store for purchases, nonces and
 * sessions" would make one class the place where every schema decision in the
 * project lives, and its `execRawForTest` would become a much larger door.
 *
 * So this is a second class with a second handle on the same file. SQLite in WAL
 * mode is happy with that: readers do not block the writer, and every write here
 * is a single autocommit. The one thing that *is* shared is the file, chosen
 * deliberately - `BIOSCOPE_DB_PATH` remains the only database setting, and "did
 * the session survive the restart" is answered by the same file the purchase
 * survived in.
 *
 * ## The row is small on purpose
 *
 * `token_hash`, `wallet`, `origin`, `siwx_nonce`, `created_at`, `expires_at`,
 * `revoked_at`. No reel list, no entitlements, no last-seen IP, nothing that a
 * later feature could grow into a second source of truth. Entitlement is the
 * ledger's job, and this table's only claim is "this request is this wallet, at
 * this origin, until this moment".
 *
 * ## Three constraints, doing the work in the database
 *
 * - `token_hash` is the primary key, so a token cannot be reissued to two wallets.
 * - the wallet `CHECK` mirrors `purchases_wallet_normalized`, so a session cannot
 *   hold a spelling of an address that the ledger would not recognize.
 * - `expires_at > created_at` is a lexicographic comparison on ISO-8601 UTC, which
 *   is chronologically correct, so a zero-length or inverted session cannot be
 *   written at all.
 *
 * `revoked_at` is one-directional in the same spirit as the nonce store: a
 * second call cannot un-revoke a row, so logout cannot be raced into a no-op.
 */

import { DatabaseSync } from "./sqlite.js";
import {
  generateSessionToken,
  hashSessionToken,
  type SessionRecord,
  type SessionResolution,
} from "../domain/session.js";
import { normalizeWalletAddress } from "../domain/wallet.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bioscope_sessions (
  token_hash TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  origin     TEXT NOT NULL,
  siwx_nonce TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,

  CONSTRAINT sessions_wallet_normalized CHECK (
    length(wallet) = 42
    AND substr(wallet, 1, 2) = '0x'
    AND substr(wallet, 3) NOT GLOB '*[^0-9a-f]*'
  ),

  -- The origin is a value this server wrote, not one a caller supplied, so this
  -- only has to reject the impossible: an empty string, or control characters
  -- that would end up in a log line or a Set-Cookie.
  CONSTRAINT sessions_origin_is_plausible CHECK (
    length(origin) > 0
    AND length(origin) <= 300
    AND origin NOT GLOB '*[^a-zA-Z0-9:/._-]*'
  ),

  -- ISO-8601 UTC sorts lexicographically in the order it happens.
  CONSTRAINT sessions_expires_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS sessions_by_wallet ON bioscope_sessions (wallet);
`;

interface SessionRow {
  token_hash: string;
  wallet: string;
  origin: string;
  siwx_nonce: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface SqliteSessionStoreOptions {
  /** The same path the purchase ledger uses. `:memory:` works for unit tests. */
  readonly databasePath: string;
  /** Injectable clock, so expiry and revocation are assertable without sleeping. */
  readonly now?: () => Date;
}

export interface NewSession {
  /** Already verified. Normalized here anyway, because the ledger will be. */
  readonly wallet: string;
  /** The origin this session is bound to. */
  readonly origin: string;
  /** The SIWX nonce consumed to mint it. Recorded, never trusted for anything. */
  readonly siwxNonce?: string | null | undefined;
  readonly ttlSeconds: number;
}

export interface CreatedSession {
  /**
   * The one and only time the raw token is available.
   *
   * It is not stored, so it cannot be recovered - a lost token means a new
   * session, which is the intended failure mode.
   */
  readonly token: string;
  readonly record: SessionRecord;
}

export class SqliteSessionStore {
  readonly #db: InstanceType<typeof DatabaseSync>;
  readonly #now: () => Date;

  public constructor(options: SqliteSessionStoreOptions) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#db = new DatabaseSync(options.databasePath);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }

  public close(): void {
    this.#db.close();
  }

  /**
   * Mint a session.
   *
   * @returns the raw token, which the caller must hand to the wallet and then
   * forget. The store keeps only its hash.
   * @throws when the lifetime is not a positive whole number of seconds - a
   * caller that cannot say how long a session lives should not be able to create
   * one that outlives every other session.
   */
  public create(input: NewSession, now: Date = this.#now()): CreatedSession {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
      throw new Error(`Refusing to create a session with a lifetime of ${input.ttlSeconds}s.`);
    }
    const wallet = normalizeWalletAddress(input.wallet);
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();

    this.#db
      .prepare(
        `INSERT INTO bioscope_sessions
           (token_hash, wallet, origin, siwx_nonce, created_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(tokenHash, wallet, input.origin, input.siwxNonce ?? null, createdAt, expiresAt);

    return {
      token,
      record: {
        tokenHash,
        wallet,
        origin: input.origin,
        siwxNonce: input.siwxNonce ?? null,
        createdAt,
        expiresAt,
        revokedAt: null,
      },
    };
  }

  /**
   * Resolve a presented token to a live session.
   *
   * The order of the checks is the order of the refusals a reader would guess,
   * and every one of them denies. Nothing here can succeed on a partial match:
   * the row must exist, be unrevoked, be unexpired, and have been minted for the
   * origin now serving the request.
   *
   * @param expectedOrigin the configured origin. A session minted for a different
   * one is refused even if it is live, which is what stops a session surviving a
   * change of `BIOSCOPE_ORIGIN` or a move to another host.
   */
  public resolve(token: string, expectedOrigin: string, now: Date = this.#now()): SessionResolution {
    const row = this.#find(hashSessionToken(token));
    if (row === null) {
      return { ok: false, reason: "unknown-token" };
    }
    if (row.revoked_at !== null) {
      return { ok: false, reason: "revoked" };
    }
    // ISO strings compare correctly as strings, so this is a real time comparison
    // rather than a formatting coincidence.
    if (row.expires_at <= now.toISOString()) {
      return { ok: false, reason: "expired" };
    }
    if (row.origin !== expectedOrigin) {
      return { ok: false, reason: "wrong-origin" };
    }
    return { ok: true, session: toRecord(row) };
  }

  /**
   * Revoke a session. Idempotent, and one-directional.
   *
   * @returns `true` when this call is the one that revoked it, `false` when there
   * was no such session or it was already revoked.
   */
  public revoke(token: string, now: Date = this.#now()): boolean {
    const tokenHash = hashSessionToken(token);
    const row = this.#find(tokenHash);
    if (row === null || row.revoked_at !== null) {
      return false;
    }
    this.#db
      .prepare("UPDATE bioscope_sessions SET revoked_at = ? WHERE token_hash = ?")
      .run(now.toISOString(), tokenHash);
    return true;
  }

  /**
   * Delete rows that expired before `now`.
   *
   * Called when a session is minted, not on a timer: a demo server has no
   * scheduler, and an unbounded table of dead sessions is a slow leak of nothing
   * but rows. Revoked rows are kept, because "this session was revoked at" is
   * worth more to an operator than the row costs.
   */
  public pruneExpired(now: Date = this.#now()): number {
    const result = this.#db
      .prepare("DELETE FROM bioscope_sessions WHERE expires_at <= ? AND revoked_at IS NULL")
      .run(now.toISOString());
    return Number(result.changes ?? 0);
  }

  /** Row count, for tests that assert nothing was written. */
  public countSessions(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM bioscope_sessions").get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /** Every session for a wallet, newest first. Diagnostics; the UI does not need it. */
  public listForWallet(wallet: string): readonly SessionRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM bioscope_sessions WHERE wallet = ? ORDER BY created_at DESC, rowid DESC")
      .all(normalizeWalletAddress(wallet)) as unknown as SessionRow[];
    return rows.map(toRecord);
  }

  #find(tokenHash: string): SessionRow | null {
    const row = this.#db
      .prepare("SELECT * FROM bioscope_sessions WHERE token_hash = ?")
      .get(tokenHash) as unknown as SessionRow | undefined;
    return row ?? null;
  }
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    tokenHash: row.token_hash,
    wallet: row.wallet,
    origin: row.origin,
    siwxNonce: row.siwx_nonce,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
