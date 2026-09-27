/**
 * Object graph for the server: config in, listening HTTP server out.
 *
 * ## Why this is not a constructor
 *
 * Two things have to be true before the app can be built, and neither is
 * synchronous:
 *
 * - The payment layer's `initialize()` asks the facilitator what it supports and
 *   validates every route against the answer. A route the facilitator cannot
 *   settle has to fail here, at boot, not when a viewer tries to unlock a reel.
 * - The SIWX extension binds its challenge to the *browser-visible* origin, which
 *   a test only knows once a socket is listening on a real port.
 *
 * So the runtime is an async factory that returns everything it built, and the
 * caller closes it. `close()` is idempotent and releases the SQLite handle,
 * which matters in tests that open a dozen of these in one file - and on Windows
 * specifically, where a leaked handle is a locked file a later test run cannot
 * delete.
 *
 * ## Nothing here reads `process.env`
 *
 * Configuration arrives as a finished `BioscopeConfig`. That is what makes the
 * test suite hermetic: a developer with a `.env` full of credentials cannot make
 * a test behave differently from CI.
 *
 * The same reasoning removed the last other seam. `CreateRuntimeOptions` no longer
 * accepts an EVM signature verifier, so a test cannot swap the real one out - the
 * application and its tests verify wallet signatures through exactly the same code.
 */

import type { Express } from "express";
import type { Server } from "node:http";

import { assertAssetMatchesUsdc, loadConfig, type BioscopeConfig } from "./config.js";
import { SqlitePurchaseStore } from "./db/purchase-store.js";
import { SqliteSessionStore } from "./db/session-store.js";
import type { ReelCatalog } from "./domain/reels.js";
import { createReelCatalog } from "./domain/reels.js";
import { buildApp } from "./http/app.js";
import { createFrameStore, type FrameStore } from "./media/frame-store.js";
import { createPaymentLayer, type PaymentLayer } from "./payment/index.js";

export interface BioscopeRuntime {
  readonly config: BioscopeConfig;
  readonly catalog: ReelCatalog;
  readonly frames: FrameStore;
  readonly ledger: SqlitePurchaseStore;
  /**
   * Sign-in sessions, on the same database file as the ledger.
   *
   * Exposed so a test can assert what was stored - that a refused challenge wrote
   * no row, that a minted session's token is nowhere in the database - rather than
   * inferring it from status codes.
   */
  readonly sessions: SqliteSessionStore;
  readonly payment: PaymentLayer;
  readonly app: Express;
  /**
   * Release the ledger, the session store and the facilitator.
   *
   * Idempotent, and safe to call without having listened on a port. Tests call it
   * in `afterEach`; the entrypoint calls it from the shutdown handlers.
   */
  readonly close: () => Promise<void>;
}

export interface CreateRuntimeOptions {
  /** Defaults to `process.env`. Tests pass an explicit record. */
  readonly env?: NodeJS.ProcessEnv;
  /** An already-built catalog. Defaults to the three seeded reels. */
  readonly catalog?: ReelCatalog;
  /** Notified once per successful settlement, for diagnostics. */
  readonly onRecorded?: Parameters<typeof createPaymentLayer>[0]["onRecorded"];
  /**
   * Injectable clock for the session store.
   *
   * Present so a test can watch a session *expire* over HTTP instead of sleeping
   * through its lifetime - which, at the 60-second floor the config enforces, is
   * not a test anyone would write. It deliberately does **not** reach the purchase
   * ledger: freezing `created_at` on real purchase rows would quietly change what
   * the T4 suites are asserting. Defaults to the wall clock everywhere else.
   */
  readonly now?: () => Date;
}

/**
 * Build everything.
 *
 * @throws {ConfigError} for a bad environment, naming every problem at once.
 * @throws from the payment layer if a route does not match what the facilitator
 * supports. Both are boot failures on purpose: a server that starts and then
 * cannot take a payment is worse than one that refuses to start.
 */
export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<BioscopeRuntime> {
  const config = options.env === undefined ? loadConfig() : loadConfig(options.env);
  assertAssetMatchesUsdc();

  const catalog = options.catalog ?? createReelCatalog(config.reelPriceAtomic);

  // The frame store is given an explicit root so the media layout and the config
  // cannot disagree about where the frames are.
  const frames = createFrameStore({ root: config.storageRoot });

  const ledger = new SqlitePurchaseStore({ databasePath: config.dbPath });

  // Same file, own handle, own schema. See the module comment in
  // `src/db/session-store.ts` for why it is not folded into the ledger.
  const sessions = new SqliteSessionStore({
    databasePath: config.dbPath,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let payment: PaymentLayer;
  try {
    payment = await createPaymentLayer({
      config,
      catalog,
      ledger,
      ...(options.onRecorded === undefined ? {} : { onRecorded: options.onRecorded }),
    });
  } catch (error) {
    // These are real file handles. If the payment layer refuses to build, leaving
    // them open would leak connections and, on Windows, a locked file that a later
    // test run cannot delete.
    sessions.close();
    ledger.close();
    throw error;
  }

  const app = buildApp({
    catalog,
    frames,
    payment: payment.middleware,
    settlementMode: config.paymentMode,
    sessions,
    ledger,
    nonces: payment.siwxStorage,
    config,
  });

  let closed = false;
  return {
    config,
    catalog,
    frames,
    ledger,
    sessions,
    payment,
    app,
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      // Sessions first: the app is already down by the time anything calls this,
      // and a session row outliving its store would be a row nobody can revoke.
      sessions.close();
      ledger.close();
    },
  };
}

/**
 * Listen, and resolve once the socket is actually accepting connections.
 *
 * Written out rather than left to a bare `listen(port)` callback because the
 * tests need the real port: SIWX binds its challenge to the origin, and a port of
 * `0` is only known after the listen callback fires.
 */
export function listen(app: Express, port: number, host = "127.0.0.1"): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}
