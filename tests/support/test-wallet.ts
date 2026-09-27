/**
 * An ephemeral test wallet. Real key, no secrets.
 *
 * ## Why this file exists
 *
 * T4's tests proved the *plumbing* around Sign-In-With-X: that the header was
 * parsed, that the origin binding was enforced, that a nonce could not be
 * replayed, that the ledger lookup was scoped to `(wallet, reel)`. They proved it
 * by injecting a deterministic verifier, which is the right way to test plumbing
 * and the wrong way to test cryptography - a double cannot be defeated by a bad
 * signature, so every "refused" assertion was really only asserting that the
 * double said no.
 *
 * T5 replaces that with real ECDSA. This module is what makes that possible: a
 * real secp256k1 key, signing a real EIP-4361 (SIWE) message, verified by viem's
 * `verifyMessage`.
 *
 * ## Why the key is generated, never configured
 *
 * The key is created **in process, per test run**, by `generatePrivateKey()`.
 *
 * It is never read from the environment, never written to a file, never
 * committed, and never printed. A test key that had to be supplied as
 * `BIOSCOPE_TEST_PRIVATE_KEY` would be one forgotten `.env` away from being a
 * committed key, and a key in an `.env.example` is a key that ends up on a judge's
 * disk and, eventually, in a git history. A generated key has no such failure
 * mode: it cannot outlive the test process, so there is nothing to leak and
 * nothing to rotate.
 *
 * This also means the tests need no credentials from you. See the T5 report for
 * the exact statement of what is and is not covered.
 *
 * ## Why the happy path and the attacks use different helpers
 *
 * The happy path goes through the SDK's own `createSIWxPayload`, which is the
 * supported client path and calls `assertSIWxChallengeBoundToOrigin` first. If
 * that throws, our challenge is not signable by a real wallet the way the SDK
 * intends, and the test should fail rather than route around it.
 *
 * The attack cases build the SIWE message with `formatSIWEMessage` and sign it
 * directly, because `createSIWxPayload` would refuse to sign a challenge bound to
 * a foreign origin - which is exactly the thing an attacker would do. Their
 * signatures are *genuinely valid*. That is the point: a server that only ever
 * sees honest signatures is not being tested.
 */

import {
  createSIWxPayload,
  formatSIWEMessage,
  type CompleteSIWxInfo,
  type SIWxPayload,
} from "@x402/extensions/sign-in-with-x";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** A server-issued challenge, with the chain selected. This is what a wallet signs. */
export type SignableChallenge = CompleteSIWxInfo;

/**
 * Fields a test may replace before signing.
 *
 * `Partial<CompleteSIWxInfo>` under `exactOptionalPropertyTypes` permits a key to
 * be *absent* but not to be present-and-`undefined`, which is the opposite of
 * what an override wants. This mapped type allows both, so a test can write
 * `{ expirationTime: undefined }` to strip a field the server sent.
 */
export type ChallengeOverrides = {
  [K in keyof CompleteSIWxInfo]?: CompleteSIWxInfo[K] | undefined;
} & {
  /**
   * The address to claim.
   *
   * Not part of the server-issued challenge - the server names no address, which
   * is correct, since it does not yet know who is asking. It is a field of the
   * *signed* payload, and overriding it is the sharpest attack available: sign
   * with your own key while claiming to be somebody else.
   */
  address?: `0x${string}` | undefined;
};

export interface EphemeralWallet {
  /**
   * The generated key. Held in memory for the life of the process.
   *
   * Exposed so a test can prove the key is *not* the one it is pretending to be,
   * and so a second wallet can be derived when a test needs two parties. Never
   * logged, never serialized into an assertion failure by accident - the failure
   * messages in the T5 suite name the *address*, not this.
   */
  readonly privateKey: `0x${string}`;
  /** Lowercase address, as the server's ledger stores it. */
  readonly address: `0x${string}`;
  /** A viem account, which satisfies the SDK's `EVMSigner`. */
  readonly account: ReturnType<typeof privateKeyToAccount>;
  /**
   * Sign a server-issued challenge exactly as a wallet would.
   *
   * Goes through the SDK's supported client helper, `createSIWxPayload`, so the
   * origin assertion a real wallet performs is performed here too.
   *
   * @param info the `sign-in-with-x` block from a 402, with `chainId` and `type`
   * filled in from `supportedChains`.
   * @throws when the challenge is not bound to the origin it claims - which is
   * what makes it useless for the attack cases.
   */
  signChallenge(info: SignableChallenge): Promise<SIWxPayload>;
  /**
   * Sign an *arbitrary* challenge, with no origin check.
   *
   * This is the adversarial primitive. It produces a cryptographically valid
   * SIWX payload for a message the honest client path would refuse to sign -
   * bound to another origin, already expired, or issued for a different reel. Use
   * it to prove the *server* refuses them, which the honest path cannot test.
   */
  signForgedChallenge(overrides: ChallengeOverrides): Promise<SIWxPayload>;
}

/**
 * Create a real, throwaway secp256k1 wallet.
 */
export function createEphemeralWallet(): EphemeralWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  // viem returns a checksummed address; the ledger stores lowercase, and most
  // assertions in the suite compare against the ledger's spelling.
  const address = account.address.toLowerCase() as `0x${string}`;

  const signMessage = async (message: string): Promise<SIWxPayload["signature"]> =>
    (await account.signMessage({ message })) as SIWxPayload["signature"];

  return {
    privateKey,
    address,
    account,
    async signChallenge(info) {
      // The SDK's own client path, not a hand-rolled reimplementation of it. It
      // asserts the challenge is bound to the URL it came from before signing, so
      // this throws on a foreign-origin challenge - which is precisely why the
      // attack cases below cannot use it. `info.uri` is the URL, and for a
      // challenge this server minted, `domain` is that URL's host by
      // construction, so the assertion is the real one and not a tautology.
      return createSIWxPayload(info, account, new URL(info.uri));
    },
    async signForgedChallenge(overrides) {
      const info = overrides as SignableChallenge;
      // The claimed address is part of the *message*, so an override has to be
      // applied before it is formatted. Overwriting it afterwards - which an
      // earlier version of this helper did - silently replaced the sharpest attack
      // in the suite with a harmless one: the payload ended up claiming the
      // signer's own address, and the server refused it for owning nothing rather
      // than for a bad signature.
      const claimed = overrides.address ?? address;
      const message = formatSIWEMessage(info, claimed);
      return { ...info, address: claimed, signature: await signMessage(message) };
    },
  };
}
