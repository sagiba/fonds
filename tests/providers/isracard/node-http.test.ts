import { EventEmitter } from "node:events";
import { Duplex, Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIsracardHttpClient,
  ISRACARD_TLS_OPTIONS,
} from "../../../src/providers/isracard/node-http.js";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), request: vi.fn() }));
vi.mock("node:http2", () => ({ connect: mocks.connect }));
vi.mock("node:https", () => ({ request: mocks.request }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Node Isracard HTTP clients", () => {
  it.each([
    "http://digital.isracard.co.il/services",
    "https://evil.invalid/",
    "https://digital.isracard.co.il:444/",
    "https://secret@web.isracard.co.il/",
  ])(
    "rejects nonfixed HTTPS destinations before creating sockets (%s)",
    async (url) => {
      await expect(
        createIsracardHttpClient().request({
          url,
          method: "GET",
          headers: {},
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("destination rejected");
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  it("routes digital through HTTP2 with certificate validation and closes session/stream after consuming", async () => {
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const destroy = vi.spyOn(stream, "destroy");
    const session = Object.assign(new EventEmitter(), {
      request: vi.fn((_headers: Record<string, string>) => stream),
      destroy: vi.fn(),
    });
    mocks.connect.mockReturnValue(session);
    const pending = createIsracardHttpClient().request({
      url: "https://digital.isracard.co.il/services/ProxyRequestHandler.ashx?reqName=performLogonI",
      method: "POST",
      headers: { cookie: "synthetic-private-cookie" },
      body: "synthetic-private-body",
      signal: new AbortController().signal,
    });
    stream.emit("response", {
      ":status": 200,
      "set-cookie": ["shared=synthetic-session"],
    });
    stream.push("synthetic-response");
    stream.push(null);
    const response = await pending;
    let text = "";
    for await (const chunk of response.body) {
      text += String(chunk);
    }
    expect(text).toBe("synthetic-response");
    expect(mocks.connect).toHaveBeenCalledWith(
      "https://digital.isracard.co.il",
      expect.objectContaining({
        ...ISRACARD_TLS_OPTIONS,
        rejectUnauthorized: true,
        ALPNProtocols: ["h2"],
      }),
    );
    expect(session.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ":method": "POST",
        ":path": "/services/ProxyRequestHandler.ashx?reqName=performLogonI",
      }),
    );
    expect(Object.keys(session.request.mock.calls[0]![0]).slice(0, 4)).toEqual([
      ":method",
      ":authority",
      ":scheme",
      ":path",
    ]);
    expect(response.status).toBe(200);
    response.close();
    expect(destroy).toHaveBeenCalled();
    expect(session.destroy).toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("cancels a connecting HTTP2 request and closes both handles without returning socket errors", async () => {
    const stream = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const destroy = vi.spyOn(stream, "destroy");
    const session = Object.assign(new EventEmitter(), {
      request: vi.fn(() => stream),
      destroy: vi.fn(),
    });
    mocks.connect.mockReturnValue(session);
    const controller = new AbortController();
    const pending = createIsracardHttpClient().request({
      url: "https://digital.isracard.co.il/services/ProxyRequestHandler.ashx",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("connection failed");
    expect(destroy).toHaveBeenCalled();
    expect(session.destroy).toHaveBeenCalled();
    await expect(
      createIsracardHttpClient().request({
        url: "https://digital.isracard.co.il/",
        method: "GET",
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("routes web through ordinary HTTPS, passes cancellation, disables pooling and closes both handles", async () => {
    const response = Object.assign(Readable.from(["synthetic-response"]), {
      statusCode: 200,
      headers: { "content-type": "application/json" },
    });
    const responseDestroy = vi.spyOn(response, "destroy");
    const request = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      destroy: vi.fn(),
    });
    mocks.request.mockImplementation((_url, _options, callback) => {
      queueMicrotask(() => callback(response));
      return request;
    });
    const controller = new AbortController();
    const result = await createIsracardHttpClient().request({
      url: "https://web.isracard.co.il/ocp/transactions/DigitalV3.Transactions/GetCardList",
      method: "POST",
      headers: {},
      body: "{}",
      signal: controller.signal,
    });
    expect(mocks.request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        rejectUnauthorized: true,
        agent: false,
        signal: controller.signal,
      }),
      expect.any(Function),
    );
    expect(result.status).toBe(200);
    result.close();
    expect(responseDestroy).toHaveBeenCalled();
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("returns a sanitized error when HTTPS fails", async () => {
    const request = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      destroy: vi.fn(),
    });
    mocks.request.mockImplementation(() => {
      queueMicrotask(() =>
        request.emit(
          "error",
          new Error("private-password reflected from socket"),
        ),
      );
      return request;
    });
    const error = await createIsracardHttpClient()
      .request({
        url: "https://web.isracard.co.il/",
        method: "GET",
        headers: {},
        signal: new AbortController().signal,
      })
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain("connection failed");
    expect(String(error)).not.toContain("private-password");
  });
});
