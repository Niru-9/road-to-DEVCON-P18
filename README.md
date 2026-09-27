# The Bioscope

A paywall for old hand-cranked reels. Anyone can peek at the first frame of a
reel for free; one small coin unlocks the whole thing, which then plays frame by
frame. Come back next week and the bioscope remembers you — you never pay twice
for a reel you have already watched.

Three reels are seeded: a Calcutta tram, a Durga Puja procession, and a circus
elephant. Each is an ordered sequence of eight frames; frame 1 is the free peek
and frames 2–8 are the paid ones.

- **Network:** Ethereum Sepolia (`eip155:11155111`, chain id 11155111)
- **Token:** Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, 6 decimals
- **Scheme:** x402 `exact`, EIP-712 domain `name: "USDC"`, `version: "2"`
- **Facilitator:** `https://facilitator.x402.rs`
- **Default price:** `1000` base units = 0.001 USDC per reel

## Install and run

Requires Node 20.12+ (22 LTS recommended).

```powershell
npm install
npm run seed      # optional - the server seeds on first run if frames are missing
npm start
```

Open **http://localhost:8787** — and open *exactly* that origin. Sign-in
challenges are bound to the configured origin, so `http://127.0.0.1:8787` is
refused. If you change the port, change the origin with it. Stop with `Ctrl-C`.

**No `.env` and no credentials are needed** for the default simulated mode.

## The viewer flow

1. The page lists the reels, each showing its free first frame.
2. Click **Unlock**. Your wallet asks you to sign **two** things: an EIP-712
   payment authorisation for 0.001 USDC, then a sign-in message. If your wallet is
   on another chain it will also ask you to switch to Ethereum Sepolia.
3. The reel plays frame by frame and you get a receipt.
4. Reload the page: the masthead shows you are signed in, and reels you own now
   read **Watch it**. Opening one again needs **no** new payment and **no** new
   signature.

Repeat access is granted from a server-side purchase record keyed to your wallet
address and the specific reel, which is itself only trusted after a server
verifies your signature. Frames 2–8 are stored outside every publicly served
directory and are reachable only through the gated handler.

## Simulated mode vs live Sepolia

This is the important distinction.

**Simulated (the default).** The wallet signatures are real cryptography and the
server verifies both of them, but **no chain is contacted and no funds move**.
Your purchase is recorded **only in this app's local SQLite database**, and the
receipt carries a fingerprint — not a transaction hash. The mode band above the
fold says so, and nothing in the interface claims otherwise.

**Testnet.** `BIOSCOPE_PAYMENT_MODE=testnet` is wired and configuration-checked
against Ethereum Sepolia. **It has never been run.** No live payment has been
made and there is **no transaction hash**.

## Tests

```powershell
npm run verify
```

That runs the typecheck, a check over the browser JavaScript, the credential
scan and the test suite. Results on the code in this repository:

| Step | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run check:browser-js` | exit 0 |
| `npm run scan:credentials` | **PASS**, 184 files, 0 findings |
| `npm test` | **293 / 293 passing**, 20 files |

A migrated server was also started in simulated mode and checked over HTTP: the
free preview returned `200`, a paid frame returned `402`, and the banner named no
chain.

## Environment

Copy `.env.example` to `.env` if you need it. `.env` is gitignored. Nothing is
required for simulated mode.

| Variable | Required | Purpose |
|---|---|---|
| `BIOSCOPE_PAYMENT_MODE` | no | `simulated` (default) or `testnet` |
| `BIOSCOPE_RECIPIENT_ADDRESS` | only for `testnet` | Your **public** Ethereum Sepolia address, `0x` + 40 hex. Not a secret. |
| `BIOSCOPE_FACILITATOR_URL` | only for `testnet` | Must settle `eip155:11155111` |
| `BIOSCOPE_ORIGIN` | no | Must match the origin you open. Defaults to `http://localhost:8787` |
| `PORT` | no | Defaults to `8787` |
| `BIOSCOPE_REEL_PRICE_ATOMIC` | no | Base units. Defaults to `1000` (0.001 USDC) |

**The payer is your browser wallet.** No payer private key, seed phrase or wallet
export belongs in this project, and the server never signs anything — it only
verifies what your wallet signed. `BIOSCOPE_PAYER_PRIVATE_KEY` is deliberately
**absent from `.env.example`**: the config loader shape-checks that variable so a
mistyped key is reported at startup, but the server has no use for it, because
the x402 client is the browser. Leave it unset.

## Limitations

1. **Live settlement is unverified.** `testnet` mode has never been executed
   against a live facilitator, so there is no transaction hash to show.
2. **The browser client hand-rolls the x402 payload** — it imports nothing from
   `@x402/*` and encodes the payment itself, so there is no build step. The
   trade-off is that the wire format is not checked against the SDK at compile
   time, so expect a first real payment to be where a first-attempt bug appears.
3. The SDK has no default asset for `eip155:11155111` — `getDefaultAsset` throws
   for it — so the token, decimals and EIP-712 domain are declared in
   `src/config.ts` from values read off the token contract.
4. **No browser testing was performed.** The checks above are automated tests and
   plain HTTP requests only.

## License

MIT.
