/**
 * `npm start` and `npm run dev`.
 *
 * ## What this file is responsible for
 *
 * Loading configuration, building the runtime, listening, printing a summary a
 * human can check, and shutting down cleanly. All of the actual wiring lives in
 * `src/runtime.ts`; this is the part that talks to the terminal and the OS.
 *
 * ## The startup banner says whether money can move
 *
 * Printed before the first request is served, and it names the settlement mode in
 * plain words. A demo whose default configuration takes no money has to say so
 * loudly at startup, because "it gave me a 402 with a price" is not the same claim
 * as "someone paid me". See `settlementModeLabel` in `src/config.ts`.
 *
 * ## Failing loudly on a bad configuration
 *
 * A `ConfigError` lists every problem at once and exits non-zero. It does not
 * fall back to a default, because a server that silently starts with a broken
 * environment is how a demo ends up charging in `simulated` mode while everyone
 * believes it settled for real.
 *
 * ## Seeding on demand
 *
 * The frames are generated, so a fresh clone has the directory structure and
 * nothing in it. Without this, `npm start` on a clean checkout boots happily and
 * then 404s every frame, which reads as a broken app rather than a missing step -
 * and the first person to hit it is a judge with a stopwatch.
 *
 * So the server checks the free directory before it listens, and seeds if it is
 * empty. Generating them takes well under a second, needs no credentials and
 * touches no network, so there is nothing to ask permission for. It only seeds
 * when the directory is *empty*: a partial tree is left alone, because
 * overwriting somebody's half-finished directory to fix a missing file would be
 * worse than the problem.
 *
 * ## Shutdown
 *
 * SIGINT and SIGTERM both close the HTTP server first, then the runtime, so an
 * in-flight request finishes and the SQLite handle is released. Without this, a
 * Ctrl-C on Windows leaves the WAL files locked and the next run fails on a
 * database it cannot open.
 */

import { readdir } from "node:fs/promises";

import { describeConfig, ConfigError, settlementModeLabel } from "./config.js";
import { createRuntime, listen } from "./runtime.js";

/** True when the free directory does not exist or holds no reel folders. */
async function needsSeeding(publicFramesDir: string): Promise<boolean> {
  try {
    const entries = await readdir(publicFramesDir, { withFileTypes: true });
    return !entries.some((entry) => entry.isDirectory());
  } catch {
    // Any read failure - a missing directory on a fresh clone, or permissions -
    // means there is nothing to serve, so try seeding. If the directory exists
    // but is unreadable, the seed reports it far more clearly than this could.
    return true;
  }
}

async function main(): Promise<void> {
  const runtime = await createRuntime();

  if (await needsSeeding(runtime.frames.publicFramesDir)) {
    const { seedFrames } = await import("./media/seed-frames.js");
    const { createReelCatalog } = await import("./domain/reels.js");
    const result = await seedFrames({
      root: runtime.config.storageRoot,
      catalog: createReelCatalog(runtime.config.reelPriceAtomic),
    });
    process.stdout.write(
      `\n  No frames found in ${runtime.frames.publicFramesDir}, so they were generated.\n` +
        `  ${result.freeFrameCount} free and ${result.paidFrameCount} paid. ` +
        `Run "npm run seed" yourself to see the full report.\n\n`,
    );
  }

  let server;
  try {
    server = await listen(runtime.app, runtime.config.port);
  } catch (error) {
    // The port is the one thing that fails at bind time rather than at boot, so
    // it gets its own message. The runtime is closed on the way out.
    await runtime.close();
    const reason = error instanceof Error && "code" in error ? ` (${String(error.code)})` : "";
    process.stderr.write(
      `Could not listen on port ${runtime.config.port}${reason}: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `Set PORT to a free port and try again.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : runtime.config.port;

  process.stdout.write(
    [
      "",
      "  the-bioscope",
      "  " + "-".repeat(60),
      describeConfig(runtime.config),
      `  listening on     http://127.0.0.1:${boundPort}`,
      `  open             http://localhost:${runtime.config.port}`,
      `  settlement       ${settlementModeLabel(runtime.config)}`,
      "",
      "  free             GET /api/reels",
      "                   GET /api/reels/:reelId/preview",
      "  paid (x402)      GET /api/reels/:reelId/frames/frame-001.svg",
      "",
      "  Open the address above in a browser. The page walks the payment and the",
      "  sign-in itself; it asks your wallet for two signatures and nothing else.",
      "",
      `  Note: BIOSCOPE_ORIGIN is ${runtime.config.origin}, which is what Sign-In-With-X ` +
        `challenges are bound to.`,
      "  If that does not match the origin the browser uses, SIWX sign-in will not work.",
      "",
    ].join("\n"),
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`\n${signal} received, closing.\n`);

    // Close the listener first so in-flight requests finish, then the runtime so
    // the SQLite handle is released.
    server.close(() => {
      void runtime.close().then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          process.stderr.write(`Error while closing: ${String(error)}\n`);
          process.exitCode = 1;
        },
      );
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    // Already a complete, actionable message. Do not wrap it.
    process.stderr.write(`${error.message}\n\nSee .env.example for every supported setting.\n`);
  } else {
    process.stderr.write(
      `The bioscope could not start.\n\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  process.exitCode = 1;
});
