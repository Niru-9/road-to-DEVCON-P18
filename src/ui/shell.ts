/**
 * The page: a server-rendered shell with no reel data in it.
 *
 * ## What is here and what arrives later
 *
 * The HTML carries the things a viewer is supposed to *trust*: whether money
 * moves, which chain, what a reel costs, how long a sign-in lasts. Those come from
 * `BioscopeConfig` and are rendered here, so the page cannot disagree with the API
 * about any of them. The reels themselves are fetched from `GET /api/reels` by
 * `bioscope-app.js`, because they are the only part that changes.
 *
 * There is no template engine and no build step. This is a function that returns a
 * string, which keeps the whole page inspectable with `curl` - the same property
 * the rest of this project has.
 *
 * ## The embedded configuration block
 *
 * ```html
 * <script type="application/json" id="bioscope-config">{ ... }</script>
 * ```
 *
 * `type="application/json"` is inert: the browser does not execute it, so this is
 * not an injection vector, and `JSON.parse` on the text content gives the client a
 * typed object for free. The one real hazard is a value containing `</script`, so
 * `<` is escaped as `<` in the output. The value is a JSON *string*
 * being closed here - JSON.parse reads the escape back as `<`.
 *
 * Nothing in the browser may change what is in that block. There is no control
 * anywhere on the page that writes to it, sends it back, or asks the server to
 * honour it; the client reads it, and the server ignores anything a client claims.
 *
 * ## Accessibility, decided here rather than patched later
 *
 * - a skip link to the reels, because the masthead is not the point;
 * - landmarks (`header`/`main`/`footer`) and one `h1`, with the cabinet at `h2` and
 *   each reel at `h3`;
 * - a polite live region for status text, and an assertive one only for failures;
 * - every control that JS will add is described here in markup - a real `button`
 *   with a real label - so the page is legible with JavaScript disabled, and says
 *   so;
 * - `prefers-reduced-motion` is honoured in the stylesheet, not here.
 */


import { ETHEREUM_SEPOLIA_CHAIN_ID, ETHEREUM_SEPOLIA_USDC_NAME, type BioscopeConfig } from "../config.js";
import { formatUnits, networkLabel, settlementSentence } from "../../public/bioscope-core.js";
import { DEFAULT_SESSION_TTL_SECONDS } from "../config.js";

/** How long each frame is held, in milliseconds. A deliberate, unhurried pace. */
export const FRAME_INTERVAL_MS = 1100;

/**
 * Intrinsic size of every generated frame.
 *
 * Copied from `src/media/frame-artwork.ts` rather than hard-coded twice silently:
 * it is here so the `<img>` can carry `width`/`height` and reserve its box before
 * the bytes arrive, which is most of what stops the page jumping as a reel plays.
 */
export const FRAME_WIDTH = 960;
export const FRAME_HEIGHT = 600;

export interface UiConfig {
  readonly origin: string;
  readonly settlementMode: "simulated" | "testnet";
  readonly network: string;
  readonly networkLabel: string;
  readonly chainId: number;
  readonly asset: string;
  readonly assetName: string;
  readonly priceAtomic: string;
  /** Pre-formatted, so the client never does arithmetic on money. */
  readonly priceDisplay: string;
  readonly sessionTtlSeconds: number;
  readonly siwxExpirationSeconds: number;
  readonly frameIntervalMs: number;
}

/**
 * The page's view of the server's configuration.
 *
 * Every value here is read from `BioscopeConfig` or the SDK's own asset table. None
 * of it is a request parameter, and none of it is a default that could drift from
 * what the API will actually do - `networkLabel` and `settlementSentence` are the
 * same functions the client module uses, so the banner and the payment flow cannot
 * describe two different worlds.
 */
export function uiConfig(config: BioscopeConfig): UiConfig {
  return {
    origin: config.origin,
    settlementMode: config.paymentMode,
    network: config.network,
    networkLabel: networkLabel(config.network),
    chainId: ETHEREUM_SEPOLIA_CHAIN_ID,
    asset: config.asset,
    // From this module, not the SDK's default-asset table: that table has no
    // Ethereum Sepolia entry and `getDefaultAsset` throws for it. The values were
    // read from the token contract.
    assetName: ETHEREUM_SEPOLIA_USDC_NAME,
    priceAtomic: config.reelPriceAtomic,
    priceDisplay: formatUnits(config.reelPriceAtomic, config.assetDecimals),
    sessionTtlSeconds: config.sessionTtlSeconds,
    siwxExpirationSeconds: config.siwxExpirationSeconds,
    frameIntervalMs: FRAME_INTERVAL_MS,
  };
}

/** Escape text for element content and double-quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe to sit inside a `<script>` element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Render the shell.
 *
 * @param config the server's configuration. The page has no other inputs.
 */
export function renderShell(config: BioscopeConfig): string {
  const view = uiConfig(config);
  const simulated = view.settlementMode === "simulated";
  const modeWord = simulated ? "Simulated" : "Live testnet";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="referrer" content="same-origin">
<title>The Bioscope — peek at the first frame, pay once for the reel</title>
<link rel="stylesheet" href="/ui/bioscope.css">
<link rel="icon" href="data:,">
</head>
<body>
<a class="skip-link" href="#cabinet">Skip to the reels</a>

<header class="masthead">
  <p class="kicker">Forty brass boxes, three of them cranked</p>
  <h1>The Bioscope</h1>
  <p class="standfirst">
    Every reel shows you its first frame for nothing. The rest of the reel is one
    small ${escapeHtml(view.priceDisplay)} ${escapeHtml(view.assetName)} payment, once,
    and then it is yours to watch as often as you like — for as long as your sign-in
    lasts.
  </p>

  <div class="identity" id="identity" data-state="unknown">
    <p class="identity__line" id="identity-line">Checking for a sign-in…</p>
    <button type="button" class="button button--quiet" id="sign-out" hidden>Sign out</button>
  </div>
</header>

<!-- The truth about money, above the fold, in the server's own words. -->
<aside class="mode" data-mode="${escapeHtml(view.settlementMode)}" aria-labelledby="mode-heading">
  <h2 class="mode__heading" id="mode-heading">${escapeHtml(modeWord)} mode</h2>
  <p class="mode__sentence">${escapeHtml(settlementSentence(view.settlementMode, view.networkLabel))}</p>
  <dl class="mode__facts">
    <div><dt>Network</dt><dd>${escapeHtml(view.networkLabel)} <span class="mono">${escapeHtml(view.network)}</span></dd></div>
    <div><dt>Charged in</dt><dd>${escapeHtml(view.assetName)} <span class="mono">${escapeHtml(view.asset)}</span></dd></div>
    <div><dt>One reel costs</dt><dd>${escapeHtml(view.priceDisplay)} ${escapeHtml(view.assetName)}</dd></div>
    <div><dt>Sign-in lasts</dt><dd>${Math.round(view.sessionTtlSeconds / 60)} minutes</dd></div>
  </dl>
  ${
    simulated
      ? `<p class="mode__caveat">
    No coin moves anywhere in this demo. Payments are settled by a local stand-in that
    contacts no chain, and the transaction hash you will see is a fingerprint of your
    payment, not a transaction on a block explorer.
  </p>`
      : ""
  }
</aside>

<main id="cabinet">
  <h2 class="section-heading">The cabinet</h2>
  <p class="section-note" id="catalog-status" role="status">Opening the cabinet…</p>

  <ul class="reels" id="reel-list"></ul>

  <noscript>
    <p class="notice">
      This page needs JavaScript to talk to the payment and sign-in endpoints, because
      both of them are HTTP flows the browser has to walk. Everything the server
      decides still happens on the server — nothing about unlocking is decided here.
    </p>
  </noscript>
</main>

<section class="gate" id="gate" aria-labelledby="gate-heading" hidden>
  <h2 class="section-heading" id="gate-heading">Now showing</h2>
  <div class="gate__body">
    <div class="gate__frame">
      <figure class="film">
        <img id="frame-image" alt="" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}" decoding="async">
        <figcaption id="frame-caption"></figcaption>
      </figure>
      <p class="visually-hidden" id="frame-announcement" aria-live="polite"></p>
    </div>

    <div class="gate__panel">
      <h3 class="gate__title" id="gate-title"></h3>
      <p class="gate__meta mono" id="gate-meta"></p>

      <div class="gate__progress">
        <p class="counter" id="frame-counter">Frame 1 of 1</p>
        <div class="strip" id="frame-strip" role="list" aria-label="Frames in this reel"></div>
      </div>

      <div class="transport" role="group" aria-label="Playback">
        <button type="button" class="button button--quiet" id="frame-prev">Previous frame</button>
        <button type="button" class="button button--primary" id="frame-play" aria-pressed="false">Play</button>
        <button type="button" class="button button--quiet" id="frame-next">Next frame</button>
      </div>

      <p class="status" id="gate-status" role="status"></p>
      <p class="receipt" id="gate-receipt"></p>
      <p class="shortcuts">
        Keyboard: <kbd>Space</kbd> plays or pauses, <kbd>←</kbd> and <kbd>→</kbd> step a frame.
      </p>
    </div>
  </div>
</section>

<footer class="colophon">
  <h2 class="visually-hidden">About this demo</h2>
  <p>
    Frames are drawn by <code>npm run seed</code> from each reel's metadata — geometric
    placeholders, not photographs, and reproducible byte for byte. Paid frames are
    stored outside every served directory and are only ever returned by the gated
    handler after a payment or a verified wallet signature.
  </p>
  <p class="mono" id="colophon-origin">origin ${escapeHtml(view.origin)}</p>
</footer>

<script type="application/json" id="bioscope-config">${jsonForScript(view)}</script>
<script type="module" src="/ui/bioscope-app.js"></script>
</body>
</html>
`;
}

/** Re-exported so the route file does not have to know where the default came from. */
export { DEFAULT_SESSION_TTL_SECONDS };
