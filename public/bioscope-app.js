/**
 * bioscope-app.js — the only file here that is allowed to assume a browser exists.
 *
 * ## What it does, in order
 *
 * 1. Reads the server-rendered configuration block. Never a hard-coded chain, price
 *    or mode; the page and the API cannot disagree because both come from one
 *    `BioscopeConfig`.
 * 2. Fetches `GET /api/reels` and draws the cabinet, each reel with its free peek.
 * 3. Asks `GET /api/session` who is signed in, and marks the reels that wallet owns.
 * 4. On "unlock": walks the x402 flow with the viewer's own wallet — read the 402,
 *    build an EIP-3009 authorisation, ask the wallet to sign it, send it back — and
 *    then asks for one signature to be signed in, so the rest of the reel needs no
 *    further prompts.
 * 5. Plays the reel's frames in order, the free one first, from the session cookie.
 *
 * ## What it deliberately does not do
 *
 * - It has no privileged control. There is no input for a price, a network, a
 *   wallet or an "unlocked" flag, and nothing it renders can talk the server into
 *   anything: every decision is a server response to a request the browser made.
 * - It never reads the session token. `bioscope_session` is `HttpOnly`, so
 *   `document.cookie` cannot see it and this file never asks. Signing in and signing
 *   out are HTTP verbs, and the browser attaches the cookie on its own.
 * - It never writes to `localStorage` or `sessionStorage`. There is nothing to
 *   cache: a session is a server-side row, and the browser's copy is a cookie the
 *   server minted.
 * - It does not read the chain out of the Sign-In-With-X challenge. The payment
 *   chain comes from the x402 `payment-required`, and both are checked against the
 *   server-rendered configuration before anything is signed.
 *
 * ## Wallet support, honestly stated
 *
 * `window.ethereum` is the only wallet interface this speaks, because it is the only
 * one a page can rely on without shipping a library. In `simulated` mode the wallet
 * is asked for two signatures and no coin moves; in `testnet` mode the same two
 * signatures authorise a real transfer of test USDC on Ethereum Sepolia, and the wallet
 * must be on that chain. If there is no wallet, the reel stays locked and the page
 * says so, which is the correct outcome rather than a fallback.
 *
 * ## Keyboard
 *
 * Every control is a real `<button>`, so Tab and Enter work without any code. The two
 * shortcuts below are additive and are suppressed whenever focus is in a text field
 * or a modifier is held, so they cannot steal a keystroke.
 */

import {
  buildExactPayment,
  challengeFrom,
  decodeJsonHeader,
  decodeSettlementHeader,
  encodeJsonHeader,
  formatUnits,
  networkLabel,
  paidFrameUrl,
  randomNonceHex,
  siweMessage,
  siwxHeaderValue,
  utf8ToHex,
} from "./bioscope-core.js";

/**
 * Look up an element the shell is supposed to have rendered.
 *
 * A plain `getElementById` would return `null` and every later use would throw a
 * `TypeError` about an unrelated line. This throws once, at boot, naming the id that
 * is missing — which is the difference between a blank page and a sentence about
 * which element drifted. The shell and this file are one contract, kept in
 * `tests/ui-shell.test.ts`.
 */
function must(id) {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The page is missing #${id}. The shell and the app have drifted apart.`);
  }
  return found;
}

/** The same, for a selector rather than an id. */
function mustQuery(selector) {
  const found = document.querySelector(selector);
  if (found === null) {
    throw new Error(`The page is missing ${selector}. The shell and the app have drifted apart.`);
  }
  return found;
}

/** The server's own view of the world. Read once; never written. */
const config = JSON.parse(must("bioscope-config").textContent);

const CATALOG_URL = "/api/reels";
const SESSION_URL = "/api/session";

/** One reel, with the state the server last told us about. */
const reels = new Map();
/** What the server says about the cookie on this browser. */
let session = { signedIn: false, wallet: null, reels: [] };

const el = {
  identity: must("identity"),
  identityLine: must("identity-line"),
  signOut: must("sign-out"),
  catalogStatus: must("catalog-status"),
  list: must("reel-list"),
  gate: must("gate"),
  gateTitle: must("gate-title"),
  gateMeta: must("gate-meta"),
  gateStatus: must("gate-status"),
  gateReceipt: must("gate-receipt"),
  figure: mustQuery(".film"),
  image: must("frame-image"),
  caption: must("frame-caption"),
  announcement: must("frame-announcement"),
  counter: must("frame-counter"),
  strip: must("frame-strip"),
  play: must("frame-play"),
  prev: must("frame-prev"),
  next: must("frame-next"),
};

/* --- small helpers -------------------------------------------------------- */

function say(node, message, tone) {
  node.textContent = message;
  if (tone === undefined) {
    node.removeAttribute("data-tone");
  } else {
    node.dataset.tone = tone;
  }
}

/** Turn anything thrown into something a person can act on. */
function explain(error) {
  if (error && typeof error === "object" && "code" in error && error.code === 4001) {
    return "You declined in your wallet, so nothing happened. The reel is still locked.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function provider() {
  const candidate = globalThis.ethereum;
  if (!candidate) {
    throw new Error(
      "No browser wallet found. Install one (MetaMask, Rabby, or any EIP-1193 wallet) on this origin, " +
        "then try again — the payment and the sign-in both have to come from a real wallet.",
    );
  }
  return candidate;
}

async function accounts() {
  const found = await provider().request({ method: "eth_accounts" });
  if (!Array.isArray(found) || found.length === 0) {
    const asked = await provider().request({ method: "eth_requestAccounts" });
    if (!Array.isArray(asked) || asked.length === 0) {
      throw new Error("Your wallet did not share an account, so there is nothing to pay or sign with.");
    }
    return asked[0];
  }
  return found[0];
}

async function ensureChain(wallet) {
  const wanted = `0x${config.chainId.toString(16)}`;
  const current = await wallet.request({ method: "eth_chainId" });
  if (String(current).toLowerCase() === wanted.toLowerCase()) {
    return;
  }
  try {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: wanted }] });
  } catch (error) {
    throw new Error(
      `This server only settles on ${config.networkLabel} (${config.network}). Your wallet is on ` +
        `${current}. Switch it and try again — the payment cannot be signed for another chain. ` +
        explain(error),
    );
  }
}

/* --- the cabinet ---------------------------------------------------------- */

function priceLabel(amountAtomic) {
  return `${formatUnits(amountAtomic, 6)} ${config.assetName}`;
}

function stateOf(reel) {
  if (session.signedIn && session.reels.includes(reel.id)) {
    return "owned";
  }
  if (session.signedIn) {
    return "signed-in";
  }
  return "locked";
}

function renderReel(reel) {
  const state = stateOf(reel);
  const item = document.createElement("li");
  item.className = "reel";
  item.dataset.state = state;
  item.dataset.reelId = reel.id;

  const peek = document.createElement("div");
  peek.className = "reel__peek";
  const image = document.createElement("img");
  image.src = reel.previewUrl;
  image.alt = `First frame of ${reel.title}: ${reel.blurb}`;
  image.width = 960;
  image.height = 600;
  image.loading = "lazy";
  image.decoding = "async";
  peek.append(image);

  const title = document.createElement("h3");
  title.className = "reel__title";
  title.id = `reel-${reel.id}-title`;
  title.textContent = reel.title;

  const meta = document.createElement("p");
  meta.className = "reel__meta";
  for (const value of [String(reel.year), reel.place, `${reel.paidFrameCount} paid frames`]) {
    const span = document.createElement("span");
    span.textContent = value;
    meta.append(span);
  }

  const blurb = document.createElement("p");
  blurb.className = "reel__blurb";
  blurb.textContent = reel.blurb;

  const price = document.createElement("p");
  price.className = "reel__price";
  price.textContent = state === "owned" ? "In your cabinet" : `One payment: ${priceLabel(reel.priceAtomic)}`;

  const stateLine = document.createElement("p");
  stateLine.className = "reel__state";
  stateLine.textContent =
    state === "owned"
      ? "Yours — no payment, no signature."
      : state === "signed-in"
        ? "Signed in, and you have not paid for this one."
        : "Not signed in.";

  const action = document.createElement("div");
  action.className = "reel__action";
  const button = document.createElement("button");
  button.type = "button";
  button.className = state === "owned" ? "button button--yours" : "button button--primary";
  button.textContent =
    state === "owned" ? "Watch it" : `Unlock — ${priceLabel(reel.priceAtomic)}`;
  button.setAttribute("aria-describedby", `reel-${reel.id}-title`);
  button.addEventListener("click", () => {
    void startReel(reel, button);
  });
  action.append(button);

  item.append(peek, title, meta, blurb, price, stateLine, action);
  return item;
}

function renderCabinet() {
  el.list.replaceChildren(...[...reels.values()].map(renderReel));
}

function renderIdentity() {
  if (session.signedIn) {
    el.identity.dataset.state = "signed-in";
    el.identityLine.textContent = `Signed in as ${session.wallet} for ${Math.round(
      config.sessionTtlSeconds / 60,
    )} minutes. Your cabinet holds ${session.reels.length} ${
      session.reels.length === 1 ? "reel" : "reels"
    }.`;
    el.signOut.hidden = false;
  } else {
    el.identity.dataset.state = "signed-out";
    el.identityLine.textContent = "Not signed in. Anyone can watch the first frame; signing in is how the server knows which reels are already yours.";
    el.signOut.hidden = true;
  }
}

async function loadCatalog() {
  say(el.catalogStatus, "Opening the cabinet…");
  const response = await fetch(CATALOG_URL, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`The catalog could not be read (HTTP ${response.status}).`);
  }
  const body = await response.json();
  reels.clear();
  for (const reel of body.reels) {
    reels.set(reel.id, reel);
  }
  renderCabinet();
  say(el.catalogStatus, `${body.count} reels. The first frame of each is free.`);
}

async function refreshSession() {
  // No credentials, no headers: the cookie is attached by the browser because it is
  // HttpOnly, and this call cannot influence it either way.
  const response = await fetch(SESSION_URL, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`The sign-in state could not be read (HTTP ${response.status}).`);
  }
  session = await response.json();
  renderIdentity();
  renderCabinet();
}

/* --- paying, and signing in ---------------------------------------------- */

/** The 402 for a paid frame, or `null` when the server served it. */
async function quoteFor(reelId, index) {
  const response = await fetch(paidFrameUrl(reelId, index), { redirect: "manual" });
  if (response.status !== 402) {
    return { response, requirements: null };
  }
  const header = response.headers.get("payment-required");
  if (!header) {
    throw new Error("The server asked for money but sent no price, so there is nothing to pay.");
  }
  return { response, requirements: decodeJsonHeader(header) };
}

/**
 * The one check that keeps a stale page honest: the chain in the price must be the
 * chain this page was rendered for. A server that changed networks under a cached
 * tab would otherwise be paid on whatever it last advertised.
 */
function assertChainFromServer(requirements) {
  const accepted = requirements.accepts?.[0];
  if (!accepted || accepted.network !== config.network) {
    throw new Error(
      `This page was rendered for ${config.network}, but the server is asking for ` +
        `${accepted?.network ?? "an unknown network"}. Reload before paying.`,
    );
  }
  const label = networkLabel(accepted.network);
  if (label !== accepted.network) {
    throw new Error(`Unexpected network: ${accepted.network}.`);
  }
}

/** Pay for a reel: read the 402, sign it, send it, report what came back. */
async function pay(reel, address, wallet) {
  const { response, requirements } = await quoteFor(reel.id, 1);
  if (requirements === null) {
    // Already yours, or a session is live: the server served the frame instead of
    // a price. Nothing to pay.
    return { paid: false, settlement: null };
  }
  assertChainFromServer(requirements);

  const built = buildExactPayment({
    requirements,
    address,
    nowSeconds: Math.floor(Date.now() / 1000),
    nonce: randomNonceHex(),
  });

  say(el.gateStatus, `Waiting for your wallet to authorise ${priceLabel(built.authorization.value)}…`, "working");
  const signature = await wallet.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(built.typedData)],
  });

  say(el.gateStatus, "Sending the payment to the server…", "working");
  const paidResponse = await fetch(paidFrameUrl(reel.id, 1), {
    headers: {
      "PAYMENT-SIGNATURE": encodeJsonHeader({
        ...built.paymentPayload,
        payload: { ...built.paymentPayload.payload, signature },
      }),
    },
  });
  if (paidResponse.status !== 200) {
    throw new Error(
      `The server did not accept that payment (HTTP ${paidResponse.status}). Nothing was charged. ` +
        (await paidResponse.text()).slice(0, 200),
    );
  }
  return { paid: true, settlement: decodeSettlementHeader(paidResponse.headers.get("payment-response")) };
}

/** One signature, exchanged for a session cookie the browser will hold for us. */
async function signIn(reel, address, wallet) {
  const { requirements } = await quoteFor(reel.id, 1);
  if (requirements === null) {
    return;
  }
  const challenge = challengeFrom(requirements);
  const message = siweMessage(challenge.info, address);
  say(el.gateStatus, "Waiting for your wallet to sign you in…", "working");
  const signature = await wallet.request({
    method: "personal_sign",
    params: [utf8ToHex(message), address],
  });

  const response = await fetch(SESSION_URL, {
    method: "POST",
    headers: { "sign-in-with-x": siwxHeaderValue(challenge, address, signature) },
  });
  if (response.status !== 201) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      `Sign-in was refused (${body.reason ?? response.status}). The reel is still yours to pay for; ` +
        "nothing was charged for this attempt.",
    );
  }
}

/** A receipt a person can check, worded so it cannot overstate what happened. */
function receiptFor(reel, settlement) {
  if (settlement === null) {
    return null;
  }
  const head =
    config.settlementMode === "testnet"
      ? `Paid ${priceLabel(reel.priceAtomic)} on ${config.networkLabel}.`
      : `Simulated payment recorded. No chain was contacted and no funds moved.`;
  const hash = settlement?.transaction;
  const tail =
    typeof hash === "string" && hash.length > 0
      ? config.settlementMode === "testnet"
        ? ` Transaction ${hash}.`
        : ` Receipt ${hash} — a fingerprint of your payment, not a transaction on a chain.`
      : "";
  return head + tail;
}

/* --- the player ----------------------------------------------------------- */

const player = {
  reel: null,
  index: 0,
  timer: null,
  token: 0,
};

function stopPlayback() {
  if (player.timer !== null) {
    clearInterval(player.timer);
    player.timer = null;
  }
  el.play.textContent = "Play";
  el.play.setAttribute("aria-pressed", "false");
}

function showFrame(index) {
  const reel = player.reel;
  if (reel === null) {
    return;
  }
  // One outstanding request at a time: a slow frame must never be overwritten by a
  // fast one, which is how a player ends up showing the wrong frame.
  const token = (player.token += 1);
  player.index = index;

  el.figure.dataset.loading = "true";
  const image = new Image();
  image.decoding = "async";
  // No caption in the alt text for a paid frame, because the catalog does not carry
  // one: the caption is printed into the generated artwork instead, so a sighted
  // viewer reads it off the film. Reading paid frames aloud before they are paid for
  // would also give the reel away.
  image.alt =
    index === 0
      ? `${reel.title}, the free first frame. ${reel.blurb}`
      : `${reel.title}, frame ${index + 1} of ${reel.frameCount}.`;
  image.addEventListener("load", () => {
    if (token !== player.token) {
      return;
    }
    el.figure.dataset.loading = "false";
    el.image.src = image.src;
    el.image.alt = image.alt;
  });
  image.addEventListener("error", () => {
    if (token !== player.token) {
      return;
    }
    el.figure.dataset.loading = "false";
    say(el.gateStatus, "That frame could not be loaded. Try the next one.", "bad");
  });
  image.src = index === 0 ? reel.previewUrl : paidFrameUrl(reel.id, index);

  el.caption.textContent = index === 0 ? reel.blurb : paidCaptionFor(reel);
  el.counter.textContent = `Frame ${index + 1} of ${reel.frameCount}${index === 0 ? " — the free peek" : ""}`;
  // Announced rather than shown twice: the position is already on screen, and the
  // caption is part of the image.
  el.announcement.textContent = `Frame ${index + 1} of ${reel.frameCount}${index === 0 ? ", the free peek" : ""}`;

  for (const notch of el.strip.children) {
    notch.setAttribute("aria-current", String(Number(notch.dataset.index) === index));
  }
  el.prev.disabled = index === 0;
  el.next.disabled = index === reel.frameCount - 1;
}

/** One line for the whole paid run, set once per reel rather than per frame. */
function paidCaptionFor(reel) {
  return `Frames 1 to ${reel.frameCount - 1} of this reel. Each caption is printed into the frame itself.`;
}

function startPlayback() {
  stopPlayback();
  if (player.reel === null || player.index >= player.reel.frameCount - 1) {
    showFrame(0);
  }
  player.timer = setInterval(() => {
    if (player.index >= player.reel.frameCount - 1) {
      // The reel runs out, so it stops rather than looping without being asked.
      stopPlayback();
      return;
    }
    showFrame(player.index + 1);
  }, config.frameIntervalMs);
  el.play.textContent = "Pause";
  el.play.setAttribute("aria-pressed", "true");
}

function openGate(reel, receipt) {
  player.reel = reel;
  el.gate.hidden = false;
  el.gateTitle.textContent = reel.title;
  el.gateMeta.textContent = `${reel.place} · ${reel.year} · ${reel.frameCount} frames`;

  el.strip.replaceChildren(
    ...Array.from({ length: reel.frameCount }, (_, index) => {
      const notch = document.createElement("span");
      notch.className = "strip__notch";
      notch.dataset.index = String(index);
      notch.dataset.kind = index === 0 ? "free" : "paid";
      notch.setAttribute("role", "listitem");
      notch.setAttribute("aria-label", `Frame ${index + 1}`);
      return notch;
    }),
  );

  if (receipt !== null) {
    el.gateReceipt.dataset.tone = "paid";
    el.gateReceipt.textContent = receipt;
  } else if (session.signedIn && session.reels.includes(reel.id)) {
    el.gateReceipt.dataset.tone = "yours";
    el.gateReceipt.textContent = "Already yours — no payment and no signature for this one.";
  } else {
    el.gateReceipt.textContent = "";
  }

  el.gate.scrollIntoView({ block: "nearest" });
  showFrame(0);
}

/** The whole flow for one reel, from whichever state the server says we are in. */
async function startReel(reel, button) {
  const wasPlaying = player.timer !== null;
  if (wasPlaying) {
    stopPlayback();
  }
  button.disabled = true;
  el.gate.hidden = false;
  el.gateTitle.textContent = reel.title;
  el.gateMeta.textContent = `${reel.place} · ${reel.year} · ${reel.frameCount} frames`;

  try {
    const state = stateOf(reel);

    if (state === "owned") {
      // A returning viewer: no wallet call at all.
      say(el.gateStatus, "Opening from your cabinet…");
      openGate(reel, null);
      startPlaybackOrLeave();
      return;
    }

    const wallet = provider();
    const address = await accounts();
    say(el.gateStatus, `Connected as ${address}.`, "working");
    await ensureChain(wallet);

    let receipt = null;
    if (state === "locked") {
      const { paid, settlement } = await pay(reel, address, wallet);
      if (paid) {
        receipt = receiptFor(reel, settlement);
        await refreshSession();
      }
    }

    // One signature buys the whole reel. Its nonce is spent, so this cannot be
    // replayed, and the server re-checks the purchase on every frame it serves.
    await signIn(reel, address, wallet);
    await refreshSession();

    openGate(reel, receipt);
    startPlaybackOrLeave();
  } catch (error) {
    say(el.gateStatus, explain(error), "bad");
    el.gateReceipt.textContent = "";
  } finally {
    button.disabled = false;
  }
}

/** Autoplay only counts as started once a frame is actually on screen. */
function startPlaybackOrLeave() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.play.focus();
    return;
  }
  startPlayback();
}

el.play.addEventListener("click", () => {
  if (player.timer === null) {
    startPlayback();
  } else {
    stopPlayback();
  }
});

el.prev.addEventListener("click", () => {
  stopPlayback();
  showFrame(Math.max(0, player.index - 1));
});

el.next.addEventListener("click", () => {
  stopPlayback();
  showFrame(Math.min((player.reel?.frameCount ?? 1) - 1, player.index + 1));
});

el.signOut.addEventListener("click", async () => {
  stopPlayback();
  el.signOut.disabled = true;
  try {
    await fetch(SESSION_URL, { method: "DELETE" });
    await refreshSession();
    say(el.identityLine, "Signed out. The reels you paid for are still yours — sign in again to watch them.");
  } catch (error) {
    say(el.gateStatus, explain(error), "bad");
  } finally {
    el.signOut.disabled = false;
  }
});

/* --- keyboard, additively -------------------------------------------------- */

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
    return;
  }
  if (el.gate.hidden || player.reel === null) {
    return;
  }
  if (event.key === " " || event.key === "Spacebar") {
    event.preventDefault();
    el.play.click();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    el.prev.click();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    el.next.click();
  }
});

/* --- boot ------------------------------------------------------------------ */

(async () => {
  try {
    await loadCatalog();
  } catch (error) {
    say(el.catalogStatus, explain(error), "bad");
    return;
  }
  try {
    await refreshSession();
  } catch (error) {
    // Not being able to read the session is not fatal: the reels are still browsable
    // and still payable, it just costs a second signature.
    renderIdentity();
  }
})();
