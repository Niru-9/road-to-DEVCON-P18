/**
 * Configuration is read once, validated completely, and never leaks (checks 1 and 3).
 *
 * ## Why this file exists
 *
 * Up to T8 the only automated coverage of `src/config.ts` was incidental: two range
 * refusals reached through the test harness, and one test that read a config to
 * check a cookie flag. Everything this module exists to guarantee was untested:
 *
 * - **A misconfiguration is one error listing every problem**, before the port is
 *   bound. One problem per restart is a bad afternoon; one list is a fixed minute.
 * - **`testnet` mode is a claim that real settlement can happen**, so it is refused
 *   without a recipient and a facilitator rather than started into a state where
 *   every unlock silently fails.
 * - **Secrets come from the environment, and nothing renders one.** `describeConfig`
 *   is the only intended way to print a config to a human, and the payer key exists
 *   in that object. That it is reported as present-or-absent is a check-3 claim with
 *   no test behind it until now.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The error *messages* are asserted by substring, not by equality. They are written
 * to be read by an operator at 2am, so their wording is allowed to improve; what
 * must not change is that a variable is named, that every problem appears, and that
 * a rejected private key is never echoed back.
 *
 * No test here reads the real environment. Every case passes an explicit record, so
 * a developer with a populated `.env` cannot make this file behave differently from
 * CI — which is the property `loadConfig(env)` exists to provide.
 */

import { describe, expect, it } from "vitest";

import {
  ETHEREUM_SEPOLIA,
  ETHEREUM_SEPOLIA_CHAIN_ID,
  ETHEREUM_SEPOLIA_USDC,
  ETHEREUM_SEPOLIA_USDC_DECIMALS,
  ConfigError,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_SESSION_TTL_SECONDS,
  assertAssetMatchesUsdc,
  describeConfig,
  loadConfig,
  payToFor,
  settlementModeLabel,
  SIMULATED_RECIPIENT,
} from "../src/config.js";

/** A well-formed recipient. A public address, holding nothing, used only as a value. */
const RECIPIENT = "0x1111111111111111111111111111111111111111";
/** A well-formed facilitator URL. Never contacted by any test here. */
const FACILITATOR = "https://facilitator.example";

/** The problems a record produces, or `[]` when it is accepted. */
function problemsIn(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
}

describe("an empty environment gets the documented defaults", () => {
  const config = loadConfig({});

  it("is simulated, on localhost, with a whole-number price", () => {
    expect(config.paymentMode).toBe("simulated");
    expect(config.port).toBe(8787);
    expect(config.origin).toBe("http://localhost:8787");
    expect(config.reelPriceAtomic).toBe("1000");
    expect(config.maxTimeoutSeconds).toBe(DEFAULT_MAX_TIMEOUT_SECONDS);
    expect(config.sessionTtlSeconds).toBe(DEFAULT_SESSION_TTL_SECONDS);
  });

  it("is testnet-only, and says which chain", () => {
    expect(config.network).toBe(ETHEREUM_SEPOLIA);
    expect(ETHEREUM_SEPOLIA).toBe("eip155:11155111");
    expect(ETHEREUM_SEPOLIA_CHAIN_ID).toBe(11155111);
    expect(config.asset).toBe(ETHEREUM_SEPOLIA_USDC);
    expect(config.assetDecimals).toBe(ETHEREUM_SEPOLIA_USDC_DECIMALS);
  });

  it("has no recipient, no facilitator and no key, and defaults the paths", () => {
    expect(config.recipient).toBeNull();
    expect(config.facilitatorUrl).toBeNull();
    expect(config.payerPrivateKey).toBeNull();
    expect(config.dbPath).toBe("./data/bioscope.db");
    // Storage is a single root that already contains the frame store's layout, so
    // one variable cannot disagree with another about where frames live.
    expect(config.storageRoot.endsWith("storage")).toBe(true);
  });

  it("agrees with the SDK about which token USDC is", () => {
    expect(() => assertAssetMatchesUsdc()).not.toThrow();
  });
});

describe("every problem is reported at once", () => {
  it("lists all of them, not the first", () => {
    // The whole point of the problems array. An operator fixes one thing, restarts,
    // and finds the next - which is how a demo ends up serving 402s that no client
    // can satisfy while the operator is looking at the wrong variable.
    const problems = problemsIn({
      BIOSCOPE_PAYMENT_MODE: "testnet",
      BIOSCOPE_REEL_PRICE_ATOMIC: "1000.5",
      BIOSCOPE_SIWX_EXPIRATION_SECONDS: "5",
      BIOSCOPE_SESSION_TTL_SECONDS: "99999",
    });

    // Two from the cross-field testnet rule, one each from the rest.
    expect(problems.length).toBe(5);
    expect(problems.join("\n")).toMatch(/BIOSCOPE_RECIPIENT_ADDRESS is required/);
    expect(problems.join("\n")).toMatch(/BIOSCOPE_FACILITATOR_URL is required/);
    expect(problems.join("\n")).toMatch(/BIOSCOPE_REEL_PRICE_ATOMIC/);
    expect(problems.join("\n")).toMatch(/BIOSCOPE_SIWX_EXPIRATION_SECONDS must be between 30 and 3600/);
    expect(problems.join("\n")).toMatch(/BIOSCOPE_SESSION_TTL_SECONDS must be between 60 and 86400/);
  });

  it("is one error whose message carries the list, not a stack of exceptions", () => {
    let thrown: unknown;
    try {
      loadConfig({ BIOSCOPE_PAYMENT_MODE: "mainnet" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).name).toBe("ConfigError");
    // The message a boot failure prints, verbatim.
    expect((thrown as ConfigError).message).toMatch(/cannot start/i);
    expect((thrown as ConfigError).message).toMatch(/BIOSCOPE_PAYMENT_MODE/);
  });

  it("never starts in a state where every unlock would silently fail", () => {
    // The cross-field rule, in isolation. `testnet` with no recipient and no
    // facilitator is a server that advertises a price it cannot settle.
    expect(problemsIn({ BIOSCOPE_PAYMENT_MODE: "testnet" }).length).toBe(2);
    // Either one alone is still incomplete: a recipient with no facilitator still
    // cannot settle, and a facilitator with nowhere to send the coin is not a
    // working configuration. Both are required, so both are named.
    expect(problemsIn({ BIOSCOPE_PAYMENT_MODE: "testnet", BIOSCOPE_RECIPIENT_ADDRESS: RECIPIENT })).toEqual([
      "BIOSCOPE_FACILITATOR_URL is required when BIOSCOPE_PAYMENT_MODE=testnet.",
    ]);
    expect(problemsIn({ BIOSCOPE_PAYMENT_MODE: "testnet", BIOSCOPE_FACILITATOR_URL: FACILITATOR })).toEqual([
      "BIOSCOPE_RECIPIENT_ADDRESS is required when BIOSCOPE_PAYMENT_MODE=testnet.",
    ]);
    // With both, it starts.
    expect(
      problemsIn({
        BIOSCOPE_PAYMENT_MODE: "testnet",
        BIOSCOPE_RECIPIENT_ADDRESS: RECIPIENT,
        BIOSCOPE_FACILITATOR_URL: FACILITATOR,
      }),
    ).toEqual([]);
  });
});

describe("prices are integers, and only one spelling of an integer", () => {
  it("accepts a canonical base-unit amount", () => {
    for (const amount of ["0", "1", "1000", "1000000000000"]) {
      expect(problemsIn({ BIOSCOPE_REEL_PRICE_ATOMIC: amount }), `rejected ${amount}`).toEqual([]);
      expect(loadConfig({ BIOSCOPE_REEL_PRICE_ATOMIC: amount }).reelPriceAtomic).toBe(amount);
    }
  });

  it("refuses every other spelling of the same number", () => {
    // "01000" is all digits and is a *second* spelling of 1000, which would make
    // the ledger hold two different strings for one price. The SQLite CHECK mirrors
    // this rule exactly, so the two cannot drift.
    for (const amount of ["01000", "00", "1000.5", "1e3", "-1", "0x10", "abc", "1_000"]) {
      const problems = problemsIn({ BIOSCOPE_REEL_PRICE_ATOMIC: amount });
      expect(problems.length, `accepted ${JSON.stringify(amount)}`).toBeGreaterThan(0);
      expect(problems.join("\n")).toMatch(/BIOSCOPE_REEL_PRICE_ATOMIC/);
    }
  });

  it("normalizes surrounding whitespace rather than refusing it", () => {
    // A pasted value with a trailing newline is a person, not an attack, and the
    // leading-zero rule above is the one that matters for a ledger key. So `" 1000"`
    // is trimmed to the canonical `1000` - one spelling, one stored string - while
    // `"01000"` is still refused, because trimming cannot reach that.
    expect(loadConfig({ BIOSCOPE_REEL_PRICE_ATOMIC: " 1000 " }).reelPriceAtomic).toBe("1000");
    expect(problemsIn({ BIOSCOPE_REEL_PRICE_ATOMIC: " 01000 " }).length).toBeGreaterThan(0);
  });

  it("refuses an empty value by falling back to the default, quietly", () => {
    // An empty string is "unset", not "wrong", so the default stands and no problem
    // is reported. A variable set to whitespace is the same thing.
    expect(problemsIn({ BIOSCOPE_REEL_PRICE_ATOMIC: "   " })).toEqual([]);
    expect(loadConfig({ BIOSCOPE_REEL_PRICE_ATOMIC: "   " }).reelPriceAtomic).toBe("1000");
  });
});

describe("the origin has to be an origin", () => {
  it("accepts a bare http or https origin and normalizes it", () => {
    expect(loadConfig({ BIOSCOPE_ORIGIN: "http://localhost:8787/" }).origin).toBe("http://localhost:8787");
    expect(loadConfig({ BIOSCOPE_ORIGIN: "https://bioscope.example" }).origin).toBe("https://bioscope.example");
    // The default port is dropped, so two spellings of one origin cannot disagree.
    expect(loadConfig({ BIOSCOPE_ORIGIN: "http://localhost:80" }).origin).toBe("http://localhost");
  });

  it("refuses a path, a query or a fragment, and says why", () => {
    // The comparison is against the browser's own origin, so a path here would make
    // every Sign-In-With-X challenge unsatisfiable - and the error says so.
    for (const origin of [
      "http://localhost:8787/api",
      "http://localhost:8787/?x=1",
      "http://localhost:8787/#top",
      "localhost:8787",
      "not a url",
    ]) {
      const problems = problemsIn({ BIOSCOPE_ORIGIN: origin });
      expect(problems.length, `accepted ${origin}`).toBeGreaterThan(0);
      expect(problems.join("\n")).toMatch(/BIOSCOPE_ORIGIN/);
    }
  });

  it("refuses a non-http protocol", () => {
    expect(problemsIn({ BIOSCOPE_ORIGIN: "ftp://localhost" }).join("\n")).toMatch(/must be http or https/);
  });
});

describe("the facilitator URL and the recipient are checked, not trusted", () => {
  it("refuses a facilitator URL that is not http(s)", () => {
    for (const url of ["ftp://facilitator.example", "facilitator.example", "  "]) {
      const problems = problemsIn({ BIOSCOPE_FACILITATOR_URL: url });
      // Whitespace is "unset", which is allowed; the others are refused.
      if (url.trim() === "") {
        expect(problems).toEqual([]);
      } else {
        expect(problems.join("\n"), `accepted ${url}`).toMatch(/BIOSCOPE_FACILITATOR_URL/);
      }
    }
  });

  it("normalizes a recipient to lowercase, so one address is one account", () => {
    const mixed = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
    const config = loadConfig({ BIOSCOPE_RECIPIENT_ADDRESS: mixed });
    expect(config.recipient).toBe(mixed.toLowerCase());
  });

  it("refuses a recipient that is not a 20-byte address", () => {
    for (const recipient of ["0x1234", "not-an-address", `${"f".repeat(64)}`]) {
      expect(problemsIn({ BIOSCOPE_RECIPIENT_ADDRESS: recipient }).join("\n")).toMatch(
        /BIOSCOPE_RECIPIENT_ADDRESS must be/,
      );
    }
  });

  it("charges the zero address when no recipient is configured, and says so", () => {
    // Only reachable in simulated mode. Every other choice is worse: a real address
    // would imply coins are going somewhere, and a made-up one would produce a 402
    // a real client could not satisfy.
    const config = loadConfig({});
    expect(payToFor(config)).toBe(SIMULATED_RECIPIENT);
    expect(SIMULATED_RECIPIENT).toBe(`0x${"0".repeat(40)}`);
    expect(describeConfig(config)).toContain(SIMULATED_RECIPIENT);
  });
});

describe("a malformed private key is refused without being echoed", () => {
  it("names the variable and the shape, never the value", () => {
    // A 64-character secret is not a typo report, so the message describes the shape
    // instead of echoing what was typed. A wrong key in a log is a leaked key.
    const problems = problemsIn({ BIOSCOPE_PAYER_PRIVATE_KEY: "0xdeadbeef" });
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/BIOSCOPE_PAYER_PRIVATE_KEY/);
    expect(problems[0]).toContain("64 hex characters");
    expect(problems[0]).not.toContain("deadbeef");
  });

  it("accepts a well-formed key and keeps it out of every rendering", () => {
    const key = `0x${"a".repeat(64)}`;
    const config = loadConfig({ BIOSCOPE_PAYER_PRIVATE_KEY: key });
    expect(config.payerPrivateKey).toBe(key);

    const rendered = describeConfig(config);
    expect(rendered, "the key reached the startup summary").not.toContain(key);
    expect(rendered).not.toContain("aaaa");
    expect(rendered).toMatch(/payer key\s+present \(not shown\)/);
  });

  it("reports an absent key as absent, and explains what it is for", () => {
    const rendered = describeConfig(loadConfig({}));
    expect(rendered).toMatch(/payer key\s+absent/);
    expect(rendered).toMatch(/a client that pays will need one/);
  });
});

describe("lifetimes are bounded, and refusing beats clamping", () => {
  it("refuses a session lifetime nobody could use", () => {
    for (const seconds of ["0", "59", "86401"]) {
      expect(problemsIn({ BIOSCOPE_SESSION_TTL_SECONDS: seconds }).join("\n"), `accepted ${seconds}`).toMatch(
        /BIOSCOPE_SESSION_TTL_SECONDS must be between 60 and 86400/,
      );
    }
    expect(problemsIn({ BIOSCOPE_SESSION_TTL_SECONDS: "60" })).toEqual([]);
    expect(problemsIn({ BIOSCOPE_SESSION_TTL_SECONDS: "86400" })).toEqual([]);
  });

  it("refuses a challenge lifetime outside 30..3600", () => {
    for (const seconds of ["29", "3601"]) {
      expect(problemsIn({ BIOSCOPE_SIWX_EXPIRATION_SECONDS: seconds }).join("\n")).toMatch(
        /BIOSCOPE_SIWX_EXPIRATION_SECONDS must be between 30 and 3600/,
      );
    }
  });

  it("refuses a non-numeric value rather than guessing", () => {
    expect(problemsIn({ BIOSCOPE_SESSION_TTL_SECONDS: "15m" }).join("\n")).toMatch(/must be a whole number/);
    expect(problemsIn({ PORT: "eighty" }).join("\n")).toMatch(/PORT must be a whole number/);
    expect(problemsIn({ PORT: "70000" }).join("\n")).toMatch(/PORT must be between/);
  });

  it("refuses an unknown payment mode instead of falling back to simulated", () => {
    // Falling back would be the dangerous direction: a typo in the mode would come
    // up looking like a demo while the operator believed they were on testnet.
    expect(problemsIn({ BIOSCOPE_PAYMENT_MODE: "live" }).join("\n")).toMatch(/must be "simulated" or "testnet"/);
    expect(problemsIn({ BIOSCOPE_PAYMENT_MODE: "TESTNET" }).length, "the mode is case-insensitive").toBe(2);
  });
});

describe("the startup summary says whether money can move", () => {
  it("names the mode, the chain, the origin, the price and the sign-in terms", () => {
    const rendered = describeConfig(loadConfig({}));
    for (const expected of [
      "simulated",
      ETHEREUM_SEPOLIA,
      "http://localhost:8787",
      "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      "frame store",
      "SIWX challenge lifetime 300s",
      "single use",
      "verified locally",
      "900s, HttpOnly cookie",
    ]) {
      expect(rendered, `the summary is missing ${expected}`).toContain(expected);
    }
  });

  it("uses different words for the two modes, and neither overstates", () => {
    const simulated = settlementModeLabel(loadConfig({}));
    expect(simulated).toMatch(/simulated/);
    expect(simulated).toMatch(/no chain is contacted and no funds move/);
    expect(simulated).not.toMatch(/settles real/i);

    const testnet = settlementModeLabel(
      loadConfig({
        BIOSCOPE_PAYMENT_MODE: "testnet",
        BIOSCOPE_RECIPIENT_ADDRESS: "0x1111111111111111111111111111111111111111",
        BIOSCOPE_FACILITATOR_URL: "https://facilitator.example",
      }),
    );
    expect(testnet).toMatch(/testnet/);
    expect(testnet).toMatch(/real x402 settlement on Ethereum Sepolia/);
  });

  it("never contains a private key, whatever the config holds", () => {
    // Belt to the one test above: this is the function every operator's terminal
    // will print, so it is the last place a key could leak from.
    const key = `0x${"b".repeat(64)}`;
    const rendered = [
      describeConfig(loadConfig({ BIOSCOPE_PAYER_PRIVATE_KEY: key })),
      describeConfig(
        loadConfig({
          BIOSCOPE_PAYER_PRIVATE_KEY: key,
          BIOSCOPE_PAYMENT_MODE: "testnet",
          BIOSCOPE_RECIPIENT_ADDRESS: "0x1111111111111111111111111111111111111111",
          BIOSCOPE_FACILITATOR_URL: "https://facilitator.example",
        }),
      ),
    ].join("\n");

    expect(rendered).not.toContain(key);
    expect(rendered).not.toContain("bbbb");
    // The recipient is not a secret, so it *should* appear - this is the control
    // that proves the assertion above is about the key and not about redaction.
    expect(rendered).toContain("0x1111111111111111111111111111111111111111");
  });
});
