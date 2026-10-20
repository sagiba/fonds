import { Buffer } from "node:buffer";
import { connect } from "node:http2";
import { request as httpsRequest } from "node:https";

import {
  ISRACARD_LEGACY_HOST,
  ISRACARD_WEB_HOSTS,
  type IsracardHttpClient,
  type IsracardHttpResponse,
} from "./transport.js";

/**
 * Node 24 browser-compatible TLS ordering.
 * Acceptance is empirical and can change; certificate validation stays enabled.
 * This does not solve a challenge, retry a blocked login or change egress.
 */
export const ISRACARD_TLS_OPTIONS = {
  rejectUnauthorized: true,
  minVersion: "TLSv1.2" as const,
  ciphers:
    "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-RSA-AES128-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA",
  sigalgs:
    "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
  ecdhCurve: "X25519MLKEM768:X25519:P-256:P-384",
};

type IsracardRequestOptions = Parameters<IsracardHttpClient["request"]>[0];

function isAllowedDestination(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    ISRACARD_WEB_HOSTS.has(url.hostname)
  );
}

function requestBody(options: IsracardRequestOptions): Buffer | undefined {
  return options.body === undefined ? undefined : Buffer.from(options.body);
}

function requestOverHttp2(
  url: URL,
  options: IsracardRequestOptions,
): Promise<IsracardHttpResponse> {
  return new Promise<IsracardHttpResponse>((resolve, reject) => {
    const session = connect(url.origin, {
      ...ISRACARD_TLS_OPTIONS,
      ALPNProtocols: ["h2"],
      settings: { enablePush: false },
    });
    let returned = false;
    // Chrome's pseudo-header order. Node otherwise appends :scheme and
    // :authority after :path, which the provider's edge blocks on the
    // login POST while still admitting GETs.
    const stream = session.request({
      ":method": options.method,
      ":authority": url.host,
      ":scheme": "https",
      ":path": url.pathname + url.search,
      ...options.headers,
    });

    function close(): void {
      options.signal.removeEventListener("abort", onAbort);
      stream.destroy();
      session.destroy();
    }

    function fail(): void {
      if (!returned) {
        reject(new Error("Isracard connection failed"));
      }
      close();
    }

    function onAbort(): void {
      fail();
    }

    options.signal.addEventListener("abort", onAbort, { once: true });
    session.on("error", fail);
    stream.on("error", fail);
    stream.on("aborted", fail);
    stream.once("close", () => {
      if (!returned) {
        fail();
      }
    });
    stream.once("response", (headers) => {
      returned = true;
      resolve({
        status: Number(headers[":status"]),
        headers: headers as IsracardHttpResponse["headers"],
        body: stream,
        close,
      });
    });
    stream.end(requestBody(options));
  });
}

function requestOverHttps(
  url: URL,
  options: IsracardRequestOptions,
): Promise<IsracardHttpResponse> {
  return new Promise<IsracardHttpResponse>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: options.method,
        headers: options.headers,
        rejectUnauthorized: true,
        agent: false,
        signal: options.signal,
      },
      (response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          close() {
            response.destroy();
            request.destroy();
          },
        });
      },
    );
    request.on("error", () => {
      request.destroy();
      reject(new Error("Isracard connection failed"));
    });
    request.end(requestBody(options));
  });
}

/** Only the two fixed provider origins can reach a socket. Redirects are not followed. */
export function createIsracardHttpClient(): IsracardHttpClient {
  return {
    async request(options) {
      const url = new URL(options.url);
      if (!isAllowedDestination(url)) {
        throw new Error("Isracard destination rejected");
      }
      if (options.signal.aborted) {
        throw new Error("Isracard request cancelled");
      }
      // The legacy host admits the login POST only with browser-compatible
      // TLS and HTTP/2 behavior; see source-notes.md.
      if (url.hostname === ISRACARD_LEGACY_HOST) {
        return requestOverHttp2(url, options);
      }
      return requestOverHttps(url, options);
    },
  };
}
