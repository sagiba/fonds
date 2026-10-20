import { randomBytes, timingSafeEqual } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";

import {
  CallbackEndpointError,
  isValidCallbackUrl,
  type SignedWebhookInput,
} from "../application/events.js";

const maximumBody = 256 * 1024;
const maximumResponse = 16 * 1024;
/** Statuses whose Response must have a null body. */
const NULL_BODY_STATUSES = [204, 205, 304];

/** Public unicast only, including normalization of IPv4-mapped IPv6 addresses. */
export function isPublicWebhookAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function callbackUrl(value: string): URL {
  if (!isValidCallbackUrl(value)) {
    throw new CallbackEndpointError("invalid_url");
  }
  return new URL(value);
}

async function publicDestination(url: URL, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  signal.throwIfAborted();
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
        const abort = () => reject(new CallbackEndpointError("timeout"));
        signal.addEventListener("abort", abort, { once: true });
        lookup(hostname, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
      });
  // Reject mixed public/private answers rather than permitting fallback to a private address.
  if (
    !records.length ||
    records.some((record) => !isPublicWebhookAddress(record.address))
  ) {
    throw new CallbackEndpointError("invalid_url");
  }
  return records[0]!;
}

/**
 * Resolve on every delivery and pin that address while retaining hostname/TLS
 * verification. Only callback verification reads a bounded response body; an
 * event delivery resolves on its status and discards the body.
 */
async function postCallback(
  url: URL,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  readResponse: boolean,
): Promise<Response> {
  const destination = await publicDestination(url, signal);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "POST",
        headers,
        signal,
        // No reused socket can bypass the address validation above.
        agent: false,
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [destination]);
          } else {
            callback(null, destination.address, destination.family);
          }
        },
      },
      (incoming) => {
        // Redirects are returned as failures; they are never followed.
        const status = incoming.statusCode ?? 0;
        incoming.on("error", () =>
          reject(new CallbackEndpointError("unreachable")),
        );
        // Response cannot represent other statuses; treat them as a failed exchange.
        if (status < 200 || status > 599) {
          incoming.destroy();
          reject(new CallbackEndpointError("challenge_failed"));
          return;
        }
        if (!readResponse) {
          resolve(new Response(null, { status }));
          incoming.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maximumResponse) {
            incoming.destroy();
            reject(new CallbackEndpointError("challenge_failed"));
          } else {
            chunks.push(chunk);
          }
        });
        incoming.on("end", () => {
          resolve(
            new Response(
              NULL_BODY_STATUSES.includes(status)
                ? null
                : Buffer.concat(chunks),
              { status },
            ),
          );
        });
      },
    );
    request.on("error", () =>
      reject(
        new CallbackEndpointError(signal.aborted ? "timeout" : "unreachable"),
      ),
    );
    request.end(body);
  });
}

/** The library signs the exact serialized bytes, including both keys during rotation. */
async function postSignedWebhook(
  input: SignedWebhookInput,
  readResponse: boolean,
  log: (entry: object) => void,
): Promise<Response> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const started = performance.now();
  let status = 0;
  try {
    const url = callbackUrl(input.url);
    const body = JSON.stringify(input.body);
    if (Buffer.byteLength(body) > maximumBody) {
      throw new CallbackEndpointError("challenge_failed");
    }
    const signedAt = new Date();
    const signatures = [
      input.secret,
      ...(input.previousSecret ? [input.previousSecret] : []),
    ]
      .map((key) => new Webhook(key).sign(input.eventId, signedAt, body))
      .join(" ");
    const response = await postCallback(
      url,
      body,
      {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        "webhook-id": input.eventId,
        "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
        "webhook-signature": signatures,
        "X-MCP-Subscription-Id": input.subscriptionId,
      },
      signal,
      readResponse,
    );
    status = response.status;
    return response;
  } catch (error) {
    if (error instanceof CallbackEndpointError) {
      throw error;
    }
    throw new CallbackEndpointError(signal.aborted ? "timeout" : "unreachable");
  } finally {
    // Operational metadata only: never include callback URLs, keys or event data.
    log({
      event: "fonds_webhook_request",
      kind: input.body.type === "verification" ? "verification" : "event",
      status,
      durationMs: Math.round(performance.now() - started),
    });
  }
}

const stdoutLog = (entry: object) => console.info(JSON.stringify(entry));

/** Event delivery: the outcome is the HTTP status; any response body is discarded. */
export function sendSignedWebhook(
  input: SignedWebhookInput,
  log: (entry: object) => void = stdoutLog,
): Promise<Response> {
  return postSignedWebhook(input, false, log);
}

export async function verifyWebhookCallback(
  input: {
    url: string;
    secret: string;
    subscriptionId: string;
    signal?: AbortSignal;
  },
  log: (entry: object) => void = stdoutLog,
): Promise<void> {
  const challenge = randomBytes(32).toString("base64url");
  const response = await postSignedWebhook(
    {
      ...input,
      eventId: `verification_${randomBytes(16).toString("hex")}`,
      body: { type: "verification", challenge },
    },
    true,
    log,
  );
  if (!response.ok) {
    throw new CallbackEndpointError("challenge_failed");
  }
  let echoed: unknown;
  try {
    echoed = ((await response.json()) as { challenge?: unknown }).challenge;
  } catch {
    throw new CallbackEndpointError("challenge_failed");
  }
  if (
    typeof echoed !== "string" ||
    Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
    !timingSafeEqual(Buffer.from(challenge), Buffer.from(echoed))
  ) {
    throw new CallbackEndpointError("challenge_failed");
  }
}
