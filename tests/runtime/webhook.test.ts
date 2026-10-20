import { lookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";

import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isPublicWebhookAddress,
  sendSignedWebhook,
  verifyWebhookCallback,
} from "../../src/runtime/webhook.js";

const network = vi.hoisted(() => ({
  requests: [] as { url: URL; options: RequestOptions; body: string }[],
  status: 200,
  corruptChallenge: false,
  oversizedResponse: false,
}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({
  request: vi.fn(
    (
      url: URL,
      options: RequestOptions,
      response: (stream: PassThrough & { statusCode: number }) => void,
    ) => {
      const request = Object.assign(new EventEmitter(), {
        end(body: string) {
          network.requests.push({ url, options, body });
          queueMicrotask(() => {
            const incoming = Object.assign(new PassThrough(), {
              statusCode: network.status,
            });
            response(incoming);
            const sent = JSON.parse(body) as { challenge?: string };
            incoming.end(
              network.oversizedResponse
                ? "x".repeat(17 * 1024)
                : JSON.stringify({
                    challenge: network.corruptChallenge
                      ? "wrong"
                      : sent.challenge,
                  }),
            );
          });
        },
      });
      return request;
    },
  ),
}));

const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const previous = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const event = {
  eventId: "evt_synthetic",
  name: "changes.available",
  timestamp: "2040-01-01T00:00:00Z",
  data: { connectionId: "cal", after: 0, highWaterMark: 1 },
  cursor: null,
};
const input = {
  url: "https://receiver.example.invalid/events",
  secret,
  subscriptionId: "sub_synthetic",
  eventId: event.eventId,
  body: event,
};

beforeEach(() => {
  network.requests.length = 0;
  network.status = 200;
  network.corruptChallenge = false;
  network.oversizedResponse = false;
  vi.mocked(lookup).mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
  ] as never);
});
afterEach(() => vi.useRealTimers());

describe("public, pinned, signed webhook transport", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.2.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::127.0.0.1",
    "2001:db8::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });

  it("pins the validated address and preserves hostname, exact body and rotation signatures", async () => {
    expect(isPublicWebhookAddress("8.8.8.8")).toBe(true);
    expect(isPublicWebhookAddress("2606:4700:4700::1111")).toBe(true);
    const response = await sendSignedWebhook({
      ...input,
      previousSecret: previous,
    });
    expect(response.status).toBe(200);
    const sent = network.requests[0]!;
    expect(sent.url.hostname).toBe("receiver.example.invalid");
    expect(sent.options.agent).toBe(false);
    expect(sent.body).toBe(JSON.stringify(event));
    const headers = sent.options.headers as Record<string, string>;
    expect(new Webhook(secret).verify(sent.body, headers)).toEqual(event);
    expect(new Webhook(previous).verify(sent.body, headers)).toEqual(event);
    expect(headers["X-MCP-Subscription-Id"]).toBe(input.subscriptionId);
    const resolved = vi.fn();
    sent.options.lookup!("receiver.example.invalid", { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [
      { address: "8.8.8.8", family: 4 },
    ]);
  });

  it("revalidates DNS each time and refuses mixed answers and non-HTTPS URLs before sending", async () => {
    await sendSignedWebhook(input);
    vi.mocked(lookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(sendSignedWebhook(input)).rejects.toMatchObject({
      reason: "invalid_url",
    });
    for (const url of [
      "http://receiver.example.invalid",
      "https://user:pass@receiver.example.invalid",
      "https://receiver.example.invalid/#fragment",
      "https://127.0.0.1/",
    ]) {
      await expect(sendSignedWebhook({ ...input, url })).rejects.toMatchObject({
        reason: "invalid_url",
      });
    }
    expect(network.requests).toHaveLength(1);
  });

  it("verifies a fresh signed challenge and rejects a bad echo, redirect and oversized response", async () => {
    await verifyWebhookCallback(input);
    const first = network.requests[0]!;
    const payload = new Webhook(secret).verify(
      first.body,
      first.options.headers as Record<string, string>,
    ) as { type: string; challenge: string };
    expect(payload.type).toBe("verification");
    expect(payload.challenge.length).toBeGreaterThan(30);
    await verifyWebhookCallback(input);
    expect(JSON.parse(network.requests[1]!.body).challenge).not.toBe(
      payload.challenge,
    );
    network.corruptChallenge = true;
    await expect(verifyWebhookCallback(input)).rejects.toMatchObject({
      reason: "challenge_failed",
    });
    network.corruptChallenge = false;
    network.status = 302;
    await expect(verifyWebhookCallback(input)).rejects.toMatchObject({
      reason: "challenge_failed",
    });
    network.status = 200;
    network.oversizedResponse = true;
    await expect(verifyWebhookCallback(input)).rejects.toMatchObject({
      reason: "challenge_failed",
    });
  });

  it.each([199, 600, 999])(
    "fails an unrepresentable HTTP %s status without an uncaught exception",
    async (status) => {
      network.status = status;
      await expect(sendSignedWebhook(input)).rejects.toMatchObject({
        reason: "challenge_failed",
      });
      await expect(verifyWebhookCallback(input)).rejects.toMatchObject({
        reason: "challenge_failed",
      });
    },
  );

  it("acknowledges an event on 2xx status regardless of a large response body", async () => {
    network.oversizedResponse = true;
    const response = await sendSignedWebhook(input);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it("applies the shared callback URL length limit before sending", async () => {
    const base = "https://receiver.example.invalid/";
    await expect(
      sendSignedWebhook({
        ...input,
        url: base + "a".repeat(2049 - base.length),
      }),
    ).rejects.toMatchObject({ reason: "invalid_url" });
    expect(network.requests).toHaveLength(0);
    await sendSignedWebhook({
      ...input,
      url: base + "a".repeat(2048 - base.length),
    });
    expect(network.requests).toHaveLength(1);
  });

  it("bounds DNS waiting and sanitizes errors", async () => {
    const deadline = new AbortController();
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    const denied = expect(
      sendSignedWebhook({ ...input, signal: deadline.signal }),
    ).rejects.toMatchObject({ reason: "timeout" });
    deadline.abort();
    await denied;
    expect(network.requests).toHaveLength(0);
  });
});
