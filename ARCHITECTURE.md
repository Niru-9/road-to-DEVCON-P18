# Architecture

Four decisions carry this project. Each one is a property of the control flow
rather than a promise in a comment, and each has a test that fails if it is undone.

---

## 1. The private-frame boundary is structural, not procedural

The product rule is *"nobody sees a paid frame without paying for it."* There are
two ways to get there. The obvious one is to be careful: keep the paid directory out
of the served paths, remember not to add it later, do not create a static mount by
accident. The other is to make the mistake impossible.

P3 does the second.

**There is no `express.static` anywhere in `src/`.** Not for the frames, not for
the browser UI. Every frame — free or paid — leaves the disk through
`src/media/frame-store.ts`, and the store has two methods with two rules:

```ts
readFreeFrame(reelId, index)   // refuses any index but 0
readPaidFrame(reelId, index)   // refuses index 0
```

The wrong method fails on the first call with `MediaError("frame-outside-scope")`.
So the guarantee does not live in a route, a middleware order, or a list of mounted
directories. It lives in the one object that can open a file.

The consequence is that a paid frame has **no URL to guess at**. The catalog hands
an unpaid viewer a `previewUrl` and no other frame URL, and the paid route exists
only at the canonical spelling `frame-00N.svg`. The other spellings (`frame-3.svg`,
`frame-0003.svg`, `frame-0030.svg`) are 404, for the same reason
`src/domain/amount.ts` accepts exactly one spelling of an amount: six spellings of
one frame is six chances to serve the wrong file.

**The browser UI is an allow-list, not a mount either.** `public/` holds three
hand-written files, and `src/ui/assets.ts` serves them by exact name. A traversal
costs one map lookup, because the requested name has to equal a key in a map before
anything is read from disk. `public/bioscope-core.d.ts` sits in that directory on
purpose — it is what lets `tsc` check the test that drives the browser client — and
its absence from the served set is asserted by a test rather than assumed.

What is checked, and by which test:

| Claim | Test |
|---|---|
| Both frame directories hold exactly the files they should | `tests/private-media.test.ts` — a filesystem walk of both |
| No URL reaches a paid frame, including raw `..` | the same file — 20 probes, some written to the socket verbatim because `fetch` normalises `..` away |
| No `express.static` in any source file | the same file, plus `tests/ui-shell.test.ts` — a source scan of every `.ts` in `src/` |
| `public/` holds UI files only | `tests/ui-shell.test.ts` — walks it, serves everything in it, asserts the served set equals the allow-list |
| The free frame is reachable at one URL and no second path | `tests/preview-frame.test.ts` — `?index=7` returns frame 0 byte-for-byte |

The last one deserves a note. The preview route has **no index parameter at all**.
There is nothing to read, so there is nothing to abuse.

### The 402 is not an oracle

A 402 says "this exists, and here is what it costs". If an unknown reel id, frame
`0`, or frame `9999` of an eight-frame reel all produced a 402, the payment
middleware would have become a free catalogue of the server's frame counts.

So validation runs **before** x402:

```
gate          404, with no PAYMENT-REQUIRED header and no price
middleware    402 with a price, or next() if payment was good
handler       read the frame through the store, serve it privately
```

Every 402 therefore corresponds to a frame that genuinely exists and genuinely
costs something, and every invalid request answers 404 with no price header at all
— so the 402 cannot be used to probe what the server has.

---

## 2. The two ways to prove you are you

Payment proves you *paid*. A signature proves you *are the wallet*. They are
different claims and this project needs both, so it uses the SDK's own machinery for
each rather than inventing one.

### Payment — x402 V2, `exact` / EIP-3009

`src/payment/routes.ts` builds one priced, protected route per reel. The obvious
cheap design — a single `GET /api/reels/:reelId/frames/*` with one price — is wrong,
because the x402 `resource` is what a purchase is recorded against, so a shared
route means one coin buys every reel. That is the exact failure this project exists
to avoid, so the route table pins the reel id in the pattern, the resource URL and
the price, all per reel.

One thing there is load-bearing and was found late. An `exact` payment is authorised
by an EIP-712 signature whose **domain names the token**, and `@x402/evm`'s client
refuses to build a payment without `extra.name` and `extra.version`:

```
Error: EIP-712 domain parameters (name, version) are required in payment
requirements for asset 0x036CbD…
```

A route without them produces a 402 that **no conforming x402 client can pay** —
only one that hard-codes which token it is about to authorise. The values are read
from the SDK's own asset table, and `eip712DomainFor()` refuses to build if that
table and `config.asset` ever disagree.

It survived T4's 27 green tests, because the test harness built its own payload and
the simulated facilitator never checks a signature. The tests measured the server's
tolerance, not the client's requirements. `tests/browser-client.test.ts` now closes
that gap: it builds the payload with the *actual* browser module, signs it with a
real secp256k1 key, and the server has to accept it.

### Sign-in — Sign-In-With-X, and what it is for

`src/payment/siwx.ts` registers the SDK's SIWX extension over a path-aware
`SIWxStorage`. The adapter's whole job is a naming mismatch: the settle hook passes
the *resource* path (`/reels/<id>/unlock`) and the request hook passes the *request*
path (`/api/reels/<id>/frames/frame-00N.svg`). The adapter maps a request path to
its reel and delegates to one ledger, so the two agree and the lookup still lives in
one place.

The challenge is **server-issued, origin-bound, expiring and single-use**: a random
16-byte nonce per 402, `expirationTime` from configuration, `domain` and `uri`
checked against the configured origin, and the nonce spent in SQLite — which is also
what makes a restart not forget it.

**There is no way to substitute the verifier.** T4 had an `evmVerifier` option so
tests could inject a deterministic stand-in. T5 deleted it, from the application
*and* from the harness, because a verifier that cannot be defeated cannot be tested:
every "refused" assertion was really only asserting that the double said no.
`tests/siwx-no-double.test.ts` scans every `.ts` file in `src/` and `tests/support/`
and fails if the option ever comes back. Verification is now a real secp256k1
recovery by viem, and it needs no RPC for an EOA.

### Why a session, and why it is not an unlock

T5 made sign-in per-frame, because nonces are single-use and the gate asks for a
challenge on every protected request. Seven frames meant seven wallet prompts.

So T6 mints a session — and the rule it exists to keep is:

> **A session is an identity credential, never an entitlement.**

The row holds a wallet, an origin, a lifetime and a revocation timestamp. It holds
**no reel list**, because a cached list would be a second source of truth that could
disagree with the ledger and could not be revoked. Every paid-frame request
re-derives the answer with `decideEntitlement(session wallet, requested reel)`
against SQLite. That is why "a session for reel A must not unlock reel B" is not a
special case in the code — it is the absence of one.

The three properties that make it safe, each mutation-checked in
`tests/session.test.ts`:

| Property | Broken how | Caught by |
|---|---|---|
| Entitlement is re-checked per reel | remove `decideEntitlement` from the gate | *"a session for one reel opened another"* |
| A session is bound to its origin | drop the origin check on resolve | 10 failures |
| One signature is one signature | stop consuming the nonce at mint time | *"a spent challenge minted a second session"* |

The token is 32 bytes from `crypto.randomBytes`; the database stores only its
SHA-256, so a leaked database yields no live session. It travels in an `HttpOnly`
cookie with `SameSite=Strict`, and `Secure` **iff** `BIOSCOPE_ORIGIN` is https —
the one localhost-specific decision in the project, derived from configuration
because a browser silently drops a `Secure` cookie over plain http and hard-coding
it either way would be wrong somewhere.

---

## 3. The durable stores, and what "remembered" means

Everything that must survive a restart is in one SQLite file, `BIOSCOPE_DB_PATH`,
through Node's `node:sqlite` builtin — so there is no native module to build.

**`src/db/purchase-store.ts` — purchases and spent nonces.** Three constraints do
the real work, in the schema rather than in TypeScript, so they hold for every
writer including a future one:

- `UNIQUE (wallet, reel_id)` — one row per wallet per reel. This is what makes
  `recordPurchase` idempotent and what stops a second row appearing for a reel that
  is already unlocked.
- a `CHECK` forcing lowercase `0x`-prefixed addresses, so one viewer cannot end up
  with two accounts' worth of history under two spellings of one address.
- `UNIQUE (transaction_ref) WHERE transaction_ref IS NOT NULL` — one row per
  settlement, so replaying a settlement cannot mint a second entitlement.

The amount `CHECK` is worth singling out. A plain "all digits" test lets `"01000"`
through — a second spelling of `1000`. A test caught it, and the constraint now
mirrors `CANONICAL_AMOUNT` exactly. The schema is a backstop, and a backstop has to
be tested rather than written.

`siwx_nonces` is a `nonce TEXT PRIMARY KEY` with a one-directional `COALESCE`
update, so a race between two requests still leaves a nonce spent.

**`src/db/session-store.ts` — sessions.** Its own handle on the same file, its own
schema, seven columns and no more. Widening the purchase store into "the store for
purchases, nonces and sessions" would make one class the place where every schema
decision in the project lives, and would make its `execRawForTest` a much larger
door. SQLite in WAL mode is happy with two handles on one file.

Sharing the *file* is the deliberate part: `BIOSCOPE_DB_PATH` stays the only database
setting, and "did the session survive the restart" is answered by the same file the
purchase survived in.

---

## 4. The simulation boundary, and how it is kept visible

The x402 server SDK does not verify or settle anything itself. `ExactEvmScheme`
parses a price, advertises requirements, and hands both `verify` and `settle` to a
`FacilitatorClient`. So substituting one substitutes **the only component that
touches a chain**, and everything else — route matching, the 402, the headers, the
settle lifecycle, the after-settle hooks — is the real SDK running for real. That is
a much stronger test than stubbing the middleware, and it is why the stand-in
(`src/payment/simulated-facilitator.ts`) still refuses a payment that disagrees with
what the server advertised.

It is not a licence to be quiet about it, so the simulation is loud in five places:

1. the class name says `Simulated` in every log line and every error;
2. the transaction hash is a SHA-256 of the payment behind a zero word, so it cannot
   be looked up on any explorer;
3. `GET /api/health` and **every** paid response carry
   `X-Bioscope-Settlement-Mode`;
4. the 402 body carries `settlementMode` in plain text;
5. the page renders the mode from the same function the client uses
   (`settlementSentence`), above the fold, and the receipt after an unlock says
   *"No chain was contacted and no funds moved."*

The same sentence renders the page and travels with the client, so the banner and
the payment flow cannot describe two different worlds — and a test compares the
rendered HTML against that function.

**Where the boundary is, precisely:** the facilitator, and nothing else. Wallet
signatures are real cryptography, verified in this process. Access decisions are
real, from a real database. What is simulated is the settlement of a payment.

`BIOSCOPE_PAYMENT_MODE=testnet` swaps the facilitator for an HTTP one and is
validated at boot — a testnet mode with no recipient or no facilitator URL refuses
to start rather than starting into a state where every unlock silently fails. It has
never been run.

---

## Where the tests are, and what they do not cover

`npm test` is 293 tests over 20 files, with no network, no wallet and no chain.
Four of them are worth knowing about:

- `tests/siwx-real-signatures.test.ts` — real signatures, and every negative case is
  a differential pair (a refusal plus a positive control differing in one field), so
  a 402 cannot be confused with a broken server.
- `tests/session.test.ts` — the session, with four mutation checks listed in §2.
- `tests/browser-client.test.ts` — the *actual* `public/bioscope-core.js` module
  driven against a real server: the SIWE message compared byte-for-byte with the
  SDK's own `formatSIWEMessage`, a real EIP-712 payment the server accepts, and a
  whole unlock with one cookie and no second signature.
- `tests/credential-scan.test.ts` — the scanner, shown a real secret (assembled at
  runtime) and every line it once falsely flagged.

**Not covered, and worth saying out loud:** the DOM half of the UI. Rendering,
focus order, the wallet dialog and the playback animation are verified by reading
them, not by running them; a DOM emulator would test the emulator. Live testnet
settlement is unverified. Both are on the list in the README's limitations and in
`P3_PLAN.md`, and the browser pass is T9.
