/**
 * The durable purchase ledger.
 *
 * ## Schema notes
 *
 * Three constraints do the real work, and they are in the schema rather than in
 * TypeScript so that they hold for every writer, including a future one:
 *
 * - `UNIQUE (wallet, reel_id)` - one row per wallet per reel. This is what makes
 *   `recordPurchase` idempotent and what stops a second row appearing for a
 *   reel that is already unlocked.
 * - `purchases_wallet_normalized` - stored wallets must be `0x` + 40 *lowercase*
 *   hex. Normalization is a database invariant, not a convention, so a returning
 *   viewer cannot end up with two accounts' worth of history under two spellings
 *   of one address.
 * - `UNIQUE (transaction_ref) WHERE transaction_ref IS NOT NULL` - one row per
 *   settlement hash, so replaying a settlement cannot mint a second entitlement.
 *
 * Amounts are stored as decimal strings and parsed as `bigint` on the way out.
 * SQLite has no wide integer type and a JS `number` would lose precision on a
 * large balance, so the text is the source of truth and the `bigint` is derived.
 */

import { formatAtomicAmount, parseAtomicAmount, type AtomicAmount } from "../domain/amount.js";
import type {
  NewPurchase,
  PurchaseLedger,
  PurchaseRecord,
  RecordPurchaseResult,
  SettlementMode,
} from "../domain/entitlement.js";
import { normalizeWalletAddress } from "../domain/wallet.js";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "./sqlite.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet          TEXT    NOT NULL,
  reel_id         TEXT    NOT NULL,
  resource        TEXT    NOT NULL,
  amount_atomic   TEXT    NOT NULL,
  asset           TEXT    NOT NULL,
  network         TEXT    NOT NULL,
  payer           TEXT    NOT NULL,
  settlement_mode TEXT    NOT NULL,
  transaction_ref TEXT,
  created_at      TEXT    NOT NULL,

  CONSTRAINT purchases_one_row_per_wallet_per_reel UNIQUE (wallet, reel_id),

  CONSTRAINT purchases_wallet_normalized CHECK (
    length(wallet) = 42
    AND substr(wallet, 1, 2) = '0x'
    AND substr(wallet, 3) NOT GLOB '*[^0-9a-f]*'
  ),

  CONSTRAINT purchases_payer_normalized CHECK (
    length(payer) = 42
    AND substr(payer, 1, 2) = '0x'
    AND substr(payer, 3) NOT GLOB '*[^0-9a-f]*'
  ),

  -- The last clause is the leading-zero rule, and it is here because a plain
  -- "all digits" test is not enough: '01000' is all digits and would otherwise
  -- get in as a second spelling of 1000. This mirrors CANONICAL_AMOUNT in
  -- src/domain/amount.ts exactly.
  CONSTRAINT purchases_amount_is_base_units CHECK (
    length(amount_atomic) > 0
    AND amount_atomic NOT GLOB '*[^0-9]*'
    AND (amount_atomic = '0' OR substr(amount_atomic, 1, 1) != '0')
  ),

  CONSTRAINT purchases_settlement_mode_known CHECK (
    settlement_mode IN ('simulated', 'testnet')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS purchases_one_row_per_settlement
  ON purchases (transaction_ref)
  WHERE transaction_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS purchases_by_wallet ON purchases (wallet);

CREATE TABLE IF NOT EXISTS siwx_nonces (
  nonce       TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  consumed_at TEXT
);
`;

interface PurchaseRow {
  id: number;
  wallet: string;
  reel_id: string;
  resource: string;
  amount_atomic: string;
  asset: string;
  network: string;
  payer: string;
  settlement_mode: string;
  transaction_ref: string | null;
  created_at: string;
}

function toRecord(row: PurchaseRow): PurchaseRecord {
  // Parse rather than trust: if a row ever reached the table in a shape the
  // CHECK constraints do not allow, this throws here instead of handing a
  // malformed price to a settlement decision further up.
  const amountAtomic: AtomicAmount = formatAtomicAmount(parseAtomicAmount(row.amount_atomic));
  const settlementMode = row.settlement_mode;
  if (settlementMode !== "simulated" && settlementMode !== "testnet") {
    throw new Error(`Row ${row.id} has an unknown settlement mode: ${settlementMode}`);
  }
  return {
    id: row.id,
    wallet: row.wallet,
    reelId: row.reel_id,
    resource: row.resource,
    amountAtomic,
    asset: row.asset,
    network: row.network,
    payer: row.payer,
    settlementMode,
    transactionRef: row.transaction_ref,
    createdAt: row.created_at,
  };
}

/**
 * `node:sqlite` types a result row as `Record<string, SQLOutputValue>`, which
 * says nothing about which columns came back. The narrowing is sound because
 * every query below names its columns with `SELECT *` against a table whose
 * shape is fixed by `SCHEMA` above and guarded by its CHECK constraints.
 *
 * It is done here, in one place, rather than as a cast at every call site, so
 * that the one place to re-audit when the schema changes is obvious.
 */
function rowOrNull<T = PurchaseRow>(
  row: Record<string, SQLOutputValue> | undefined,
): T | null {
  return row === undefined ? null : (row as unknown as T);
}

function allRows(rows: Record<string, SQLOutputValue>[]): PurchaseRow[] {
  return rows as unknown as PurchaseRow[];
}


export interface SqlitePurchaseStoreOptions {
  /** `":memory:"` for tests, or a file path under `data/`. */
  readonly databasePath: string;
  /** Injectable clock, so `createdAt` is assertable. */
  readonly now?: () => Date;
}

/**
 * A `PurchaseLedger` on SQLite, plus the small amount of extra surface the
 * Sign-In-With-X nonce store needs.
 */
export class SqlitePurchaseStore implements PurchaseLedger {
  readonly #db: InstanceType<typeof DatabaseSync>;
  readonly #now: () => Date;

  public constructor(options: SqlitePurchaseStoreOptions) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#db = new DatabaseSync(options.databasePath);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
  }

  public close(): void {
    this.#db.close();
  }

  public findPurchase(wallet: string, reelId: string): PurchaseRecord | null {
    const row = rowOrNull(
      this.#db
        .prepare("SELECT * FROM purchases WHERE wallet = ? AND reel_id = ?")
        .get(normalizeWalletAddress(wallet), reelId),
    );
    return row === null ? null : toRecord(row);
  }

  public hasPurchased(wallet: string, reelId: string): boolean {
    return this.findPurchase(wallet, reelId) !== null;
  }

  /**
   * Record a purchase, or return the one that is already there.
   *
   * The read happens before the write and the unique index is the backstop, so a
   * retried settlement reports `already-purchased` rather than inserting a
   * duplicate entitlement.
   */
  public recordPurchase(input: NewPurchase): RecordPurchaseResult {
    const wallet = normalizeWalletAddress(input.wallet);
    const payer = normalizeWalletAddress(input.payer ?? input.wallet);
    const amountAtomic = formatAtomicAmount(parseAtomicAmount(input.amountAtomic));

    const existing = this.findPurchase(wallet, input.reelId);
    if (existing !== null) {
      return { outcome: "already-purchased", purchase: existing };
    }

    this.#db
      .prepare(
        `INSERT INTO purchases
           (wallet, reel_id, resource, amount_atomic, asset, network, payer,
            settlement_mode, transaction_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wallet,
        input.reelId,
        input.resource,
        amountAtomic,
        input.asset,
        input.network,
        payer,
        input.settlementMode,
        input.transactionRef ?? null,
        this.#now().toISOString(),
      );

    const written = this.findPurchase(wallet, input.reelId);
    if (written === null) {
      throw new Error(`Purchase for reel ${input.reelId} did not persist.`);
    }
    return { outcome: "recorded", purchase: written };
  }

  public listPurchases(wallet: string): readonly PurchaseRecord[] {
    const rows = allRows(
      this.#db
        .prepare("SELECT * FROM purchases WHERE wallet = ? ORDER BY id")
        .all(normalizeWalletAddress(wallet)),
    );
    return rows.map(toRecord);
  }

  public countPurchases(): number {
    const row = rowOrNull<{ n: number }>(
      this.#db.prepare("SELECT COUNT(*) AS n FROM purchases").get(),
    );
    return row?.n ?? 0;
  }

  /**
   * Run one statement against the raw connection.
   *
   * This exists so the test suite can assert that the schema's CHECK and UNIQUE
   * constraints genuinely bite, instead of taking the comments in `SCHEMA` on
   * trust. The application must not call it: it bypasses wallet normalization,
   * amount validation and idempotency, which is exactly what those constraints
   * exist to back up.
   */
  public execRawForTest(sql: string, ...params: SQLInputValue[]): void {
    this.#db.prepare(sql).run(...params);
  }

  // --- Sign-In-With-X nonce tracking -------------------------------------
  //
  // Storage-contract support for the x402 SIWX extension. Enforcement of *when*
  // a nonce may be consumed is the sign-in flow's job, not this store's; what
  // belongs here is the durable, restart-proof answer to "has this nonce already
  // been used", plus the record that it has been.

  public hasUsedNonce(nonce: string): boolean {
    const row = this.#db
      .prepare("SELECT consumed_at FROM siwx_nonces WHERE nonce = ?")
      .get(assertNonce(nonce)) as { consumed_at: string | null } | undefined;
    return row?.consumed_at != null;
  }

  /**
   * Mark a nonce used. Idempotent, and one-directional: a second call cannot
   * un-consume a nonce, so a race between two requests still leaves it spent.
   */
  public recordNonce(nonce: string, now: Date = this.#now()): void {
    this.#db
      .prepare(
        `INSERT INTO siwx_nonces (nonce, recorded_at, consumed_at)
         VALUES (?, ?, ?)
         ON CONFLICT (nonce) DO UPDATE SET consumed_at = COALESCE(consumed_at, excluded.consumed_at)`,
      )
      .run(assertNonce(nonce), now.toISOString(), now.toISOString());
  }
}

const NONCE_PATTERN = /^[\x21-\x7e]{8,256}$/;

/** A nonce has to be a bounded, printable token - it is attacker-supplied. */
function assertNonce(nonce: unknown): string {
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    throw new Error(`Malformed sign-in nonce: ${JSON.stringify(String(nonce))}`);
  }
  return nonce;
}

/** Narrow re-export so callers can build a ledger without importing the domain. */
export type { SettlementMode };
