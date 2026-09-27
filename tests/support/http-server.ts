/**
 * A real HTTP server for the tests, on an ephemeral port.
 *
 * ## Why not supertest, and why not a request mock
 *
 * P1 uses `supertest`. P3 does not need it, for one specific reason: several of
 * these tests are about what is *not* reachable, and the strongest way to assert
 * that is to point a real client at a real socket and see a real 404. A mock of
 * `req`/`res` can only test the handler a mock happens to drive; a real server
 * also proves that nothing in the middleware chain, the router, or Express's own
 * path handling is quietly serving a file.
 *
 * So the suite boots the app on `127.0.0.1:0` and uses the global `fetch`. No
 * new dependency, and the assertions are about bytes on the wire.
 *
 * `rawGet` exists for one case `fetch` cannot help with: `fetch` normalizes `..`
 * out of a URL before it ever reaches the network, so a traversal attempt has to
 * be written to the socket verbatim to mean anything.
 */

import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Buffer;
  /** Body decoded as UTF-8. Convenient for asserting on SVG attributes. */
  readonly text: string;
}

export async function startTestServer(app: Express): Promise<TestServer> {
  const server = await new Promise<ReturnType<Express["listen"]>>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function toResult(response: Response): Promise<HttpResult> {
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text: bytes.toString("utf8"),
  };
}

export function get(baseUrl: string, path: string, init?: RequestInit): Promise<HttpResult> {
  return send(baseUrl, path, { redirect: "manual", ...init });
}

/**
 * `POST` and `DELETE` on a real socket, for the sign-in session endpoints.
 *
 * Written out rather than reaching for a one-line alias of `get`, so the verb is
 * visible at each call site in the session suite - a test that means to create a
 * session and a test that means to read one should not look alike.
 */
export function post(baseUrl: string, path: string, init?: RequestInit): Promise<HttpResult> {
  return send(baseUrl, path, { redirect: "manual", method: "POST", ...init });
}

export function del(baseUrl: string, path: string, init?: RequestInit): Promise<HttpResult> {
  return send(baseUrl, path, { redirect: "manual", method: "DELETE", ...init });
}

function send(baseUrl: string, path: string, init: RequestInit): Promise<HttpResult> {
  return fetch(`${baseUrl}${path}`, init).then(toResult);
}

/**
 * The session cookies on a response, as an array.
 *
 * `Headers.get("set-cookie")` folds multiple cookies into one comma-joined
 * string, which is wrong for `Expires=` in particular. `getSetCookie()` is the
 * correct accessor; the fallback is for runtimes without it, and there is only
 * ever one cookie here so folding is survivable.
 */
export function setCookies(response: HttpResult): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
}

/**
 * Node's `IncomingHttpHeaders` is `{ [k: string]: string | string[] | undefined }`,
 * while `Headers` wants a flat string record. Repeated headers are joined, which
 * is the same normalization `fetch` does.
 */
function toHeaders(incoming: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    }
  }
  return headers;
}

/**
 * Send a request target to the socket exactly as given, with no normalization.
 *
 * `GET /public-frames/../../storage/paid-frames/x/frame-001.svg` is the request
 * that would matter if anything were mounted carelessly. `fetch` would quietly
 * resolve the `..` segments before sending, so the test would prove nothing.
 */
export function rawGet(baseUrl: string, rawTarget: string): Promise<HttpResult> {
  const url = new URL(baseUrl);
  return new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        method: "GET",
        path: rawTarget,
        headers: { host: url.host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: toHeaders(res.headers),
            bytes,
            text: bytes.toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
