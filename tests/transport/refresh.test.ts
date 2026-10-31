import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ApplicationCapabilities,
  createApplication,
} from "../../src/application/operations.js";
import type {
  Refresh,
  RefreshResumeResult,
  RefreshStartResult,
} from "../../src/application/refreshes.js";
import { presentRefresh } from "../../src/application/wire-output.js";
import { NotFoundError } from "../../src/domain/errors.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import {
  createHttpService,
  type HttpRequestLog,
} from "../../src/transport/http.js";

const origin = "https://refresh.synthetic.invalid";
const connectionId = "private-account-identifier";

function refresh(status: "running" | "completed" | "partial"): Refresh {
  return {
    id: "synthetic-refresh",
    connectionId,
    trigger: "manual",
    status,
    skipReason: null,
    range: null,
    occurrence: null,
    scheduledAt: null,
    createdAt: "2040-01-01T00:00:00.000Z",
    startedAt: "2040-01-01T00:00:00.000Z",
    finishedAt: status === "running" ? null : "2040-01-01T00:01:00.000Z",
    requiresAttention: false,
    counts: {
      captures: 1,
      observed: 2,
      unchangedTransactions: 0,
      unlisted: 0,
      unchanged: 0,
      failures: 0,
      created: 2,
      updated: 0,
    },
    failureCodes: [],
    failureReason: null,
    missed: null,
    providerStopReason: "rate_limited",
    hasAcceptedEvidence: true,
    windows: [],
  };
}

/** The public summary of refresh(status), written out: internal fields never appear. */
function wire(status: "running" | "completed") {
  return {
    id: "synthetic-refresh",
    connectionId,
    trigger: "manual",
    status,
    skipReason: null,
    range: null,
    scheduledAt: null,
    createdAt: "2040-01-01T00:00:00.000Z",
    startedAt: "2040-01-01T00:00:00.000Z",
    finishedAt: status === "running" ? null : "2040-01-01T00:01:00.000Z",
    requiresAttention: false,
    counts: {
      captures: 1,
      observed: 2,
      unchangedTransactions: 0,
      unlisted: 0,
      unchanged: 0,
      failures: 0,
      created: 2,
      updated: 0,
    },
    failureCodes: [],
    failureReason: null,
    missed: null,
  };
}

const started = (value: Refresh): RefreshStartResult => ({
  connectionId,
  reason: null,
  refresh: value,
});

const encoder = new TextEncoder();
let endlessCancelled = false;
/** Unauthenticated synthetic responses whose body shape the request log must measure. */
const syntheticBodies: Record<string, () => Response> = {
  "/synthetic-body/fixed": () =>
    new Response("fixed-body", { headers: { "Content-Length": "10" } }),
  "/synthetic-body/stream": () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("first"));
          controller.enqueue(encoder.encode("-second"));
          controller.close();
        },
      }),
    ),
  "/synthetic-body/endless": () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("tick"));
        },
        cancel() {
          endlessCancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    ),
  "/synthetic-body/broken": () => {
    let sent = false;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (sent) {
            controller.error(new Error("synthetic-stream-failure"));
            return;
          }
          sent = true;
          controller.enqueue(encoder.encode("part"));
        },
      }),
    );
  },
};

describe("optional owner refresh interfaces and request diagnostics", () => {
  let db: Database;
  const services: ReturnType<typeof createHttpService>[] = [];
  const clients: Client[] = [];
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({
      id: connectionId,
      provider: "synthetic-provider",
    });
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(services.splice(0).map((service) => service.close()));
    await db.close();
  });

  function setup(
    capabilities: ApplicationCapabilities = {},
    onRequest?: (entry: HttpRequestLog) => void | Promise<void>,
  ) {
    const application = createApplication(db, capabilities);
    const service = createHttpService(application, {
      publicOrigin: origin,
      ownerId: "owner",
      authProvider: {
        issuer: `${origin}/api/auth`,
        endpoints: {
          authorization: `${origin}/api/auth/oauth2/authorize`,
          token: `${origin}/api/auth/oauth2/token`,
        },
        async authenticate(request) {
          const bearer = request.headers.get("authorization")?.slice(7);
          const scopes =
            bearer === "read"
              ? ["financial:read"]
              : bearer === "write"
                ? ["financial:write"]
                : bearer === "both"
                  ? ["financial:read", "financial:write"]
                  : [];
          return scopes.length
            ? {
                source: "synthetic",
                subject: "owner",
                ownerId: "owner",
                resource: `${origin}/mcp`,
                clientId: "synthetic",
                scopes,
              }
            : null;
        },
      },
      ...(onRequest ? { onRequest } : {}),
      publicRoutes: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/synthetic-login/")) {
          return new Response("Synthetic", { status: 400 });
        }
        return syntheticBodies[path]?.() ?? null;
      },
    });
    services.push(service);
    const request = (path: string, bearer: string, input?: unknown) =>
      service.app.request(`${origin}${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
    return { application, service, request };
  }

  it("serves no synchronous refresh endpoint, offers the start only with its capability and validates strict input", async () => {
    const defaults = setup();
    expect(
      defaults.application.operations.map((operation) => operation.name),
    ).toEqual(expect.arrayContaining(["get_refresh", "list_refreshes"]));
    expect(
      defaults.application.operations.some(
        (operation) => operation.name === "refresh_connection",
      ),
    ).toBe(false);
    const start = vi.fn(async () => started(refresh("completed")));
    const enabled = setup({ refreshes: { start, startAll: vi.fn() } });
    for (const { request } of [defaults, enabled]) {
      expect(
        (await request(`/v1/connections/${connectionId}/refresh`, "write", {}))
          .status,
      ).toBe(404);
    }
    const operation = enabled.application.operations.find(
      (candidate) => candidate.name === "refresh_connection",
    )!;
    expect(operation).toMatchObject({ readOnly: false, openWorld: true });
    for (const input of [
      { connectionId, password: "must-not-be-accepted" },
      { connectionId, from: "2040-01-01" },
      { connectionId, from: "2040-02-01", to: "2040-01-01" },
      { connectionId, from: "2020-01-01", to: "2040-01-01" },
      { connectionId, from: "2040-02-30", to: "2040-03-01" },
    ]) {
      await expect(operation.execute(input)).rejects.toThrow();
    }
    expect(start).not.toHaveBeenCalled();
    await operation.execute({
      connectionId,
      from: "2040-01-15",
      to: "2040-03-10",
    });
    expect(start).toHaveBeenCalledExactlyOnceWith(connectionId, {
      from: "2040-01-15",
      to: "2040-03-10",
    });
  });

  it("starts with write permission, answering 200 when finished, 202 while running and 409 when another is active", async () => {
    const start = vi.fn(async () => started(refresh("running")));
    const startAll = vi.fn(async () => [
      started(refresh("completed")),
      {
        connectionId: "other",
        reason: "cooldown" as const,
        refresh: refresh("completed"),
      },
    ]);
    const { request } = setup({ refreshes: { start, startAll } });
    const path = `/v1/connections/${connectionId}/refreshes`;
    for (const deniedPath of [path, "/v1/refreshes"]) {
      expect((await request(deniedPath, "read", {})).status).toBe(403);
    }
    expect(start).not.toHaveBeenCalled();
    expect(startAll).not.toHaveBeenCalled();
    const running = await request(path, "write", {});
    expect(running.status).toBe(202);
    expect(await running.json()).toEqual({
      refresh: { ...wire("running"), windows: [] },
    });
    expect(start).toHaveBeenLastCalledWith(connectionId, undefined);
    start.mockResolvedValueOnce(started(refresh("completed")));
    expect((await request(path, "write", {})).status).toBe(200);
    for (const [reason, code] of [
      ["busy", "refresh_in_progress"],
      ["requires_attention", "requires_attention"],
    ] as const) {
      start.mockResolvedValueOnce({
        connectionId,
        reason,
        refresh: refresh("running"),
      });
      const refused = await request(path, "write", {});
      expect(refused.status).toBe(409);
      expect((await refused.json()).error.code).toBe(code);
    }
    expect(
      (await request(path, "write", { connectionId: "override" })).status,
    ).toBe(400);
    expect((await request(path, "untrusted", {})).status).toBe(401);
    const all = await request("/v1/refreshes", "write", {
      from: "2040-01-01",
      to: "2040-01-31",
    });
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({
      refreshes: [
        {
          connectionId,
          reason: null,
          refresh: wire("completed"),
        },
        {
          connectionId: "other",
          reason: "cooldown",
          refresh: wire("completed"),
        },
      ],
    });
    expect(startAll).toHaveBeenCalledExactlyOnceWith({
      from: "2040-01-01",
      to: "2040-01-31",
    });
  });

  it("reads refreshes and the connection's latest refresh with read permission", async () => {
    const { request } = setup();
    expect(
      await (await request(`/v1/connections/${connectionId}`, "read")).json(),
    ).toMatchObject({ connection: { id: connectionId, latestRefresh: null } });
    const ranged = {
      ...refresh("partial"),
      id: "ranged",
      range: { from: "2040-01-15", to: "2040-02-10" },
      windows: [
        { from: "2040-02-01", to: "2040-02-10", status: "completed" as const },
        { from: "2040-01-15", to: "2040-01-31", status: "failed" as const },
      ],
    };
    await db.admitRefresh(ranged, { operator: true, now: Date.now() });
    expect((await request(`/v1/refreshes/${ranged.id}`, "write")).status).toBe(
      403,
    );
    expect(
      await (await request(`/v1/refreshes/${ranged.id}`, "read")).json(),
    ).toEqual({
      refresh: { ...presentRefresh(ranged), windows: ranged.windows },
    });
    expect((await request("/v1/refreshes/missing", "read")).status).toBe(404);
    expect(
      await (
        await request(`/v1/connections/${connectionId}/refreshes`, "read")
      ).json(),
    ).toEqual({
      data: [presentRefresh(ranged)],
      hasMore: false,
      nextCursor: null,
    });
    expect(
      (await (await request("/v1/connections", "read")).json()).data[0]
        .latestRefresh,
    ).toEqual(presentRefresh(ranged));
  });

  it("exposes the same contract over MCP, with get_refresh and list_refreshes", async () => {
    const start = vi.fn(async () => started(refresh("completed")));
    const startAll = vi.fn(async () => [started(refresh("completed"))]);
    const { service } = setup({ refreshes: { start, startAll } });
    const connect = async (bearer: string) => {
      const client = new Client({
        name: "synthetic-refresh-client",
        version: "1",
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          fetch: async (input, init) => {
            const request = new Request(input, init);
            request.headers.set("authorization", `Bearer ${bearer}`);
            return service.app.fetch(request);
          },
        }),
      );
      return client;
    };
    const read = await connect("read");
    const tools = (await read.listTools()).tools;
    expect(
      tools.find((tool) => tool.name === "refresh_connection")?.annotations,
    ).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    // Refresh reads only read; continuing a refresh is resume_refresh.
    for (const name of ["get_refresh", "list_refreshes"]) {
      expect(
        tools.find((tool) => tool.name === name)?.annotations,
      ).toStrictEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    // Without a resume capability there is no resume tool.
    expect(tools.some((tool) => tool.name === "resume_refresh")).toBe(false);
    // It still needs only financial:read: a missing refresh, not a forbidden call.
    expect(
      await read.callTool({
        name: "get_refresh",
        arguments: { refreshId: "missing" },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    });
    for (const arguments_ of [{ connectionId }, {}]) {
      expect(
        await read.callTool({
          name: "refresh_connection",
          arguments: arguments_,
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "forbidden" } },
      });
    }
    expect(start).not.toHaveBeenCalled();
    expect(startAll).not.toHaveBeenCalled();
    const write = await connect("write");
    expect(
      await write.callTool({
        name: "refresh_connection",
        arguments: { connectionId },
      }),
    ).toMatchObject({
      structuredContent: {
        refresh: { id: "synthetic-refresh", status: "completed" },
      },
    });
    expect(
      await write.callTool({ name: "refresh_connection", arguments: {} }),
    ).toMatchObject({
      structuredContent: { refreshes: [{ connectionId, reason: null }] },
    });
    expect(startAll).toHaveBeenCalledOnce();
    expect(
      await read.callTool({
        name: "list_refreshes",
        arguments: { connectionId },
      }),
    ).toMatchObject({ structuredContent: { data: [], hasMore: false } });
  });

  it("resumes with write permission over REST and MCP: 202 when accepted, 200 when held or finished, 404 when unknown", async () => {
    const held: RefreshResumeResult = {
      refresh: refresh("running"),
      outcome: "held",
      retryAt: "2040-01-01T00:10:00.000Z",
    };
    const resume = vi.fn(async (refreshId: string) => {
      if (refreshId === "missing") {
        throw new NotFoundError("Refresh not found");
      }
      return held;
    });
    const start = vi.fn();
    const startAll = vi.fn();
    const { request, service } = setup({
      refreshes: { start, startAll, resume },
    });
    const path = "/v1/refreshes/synthetic-refresh/resume";
    expect((await request(path, "read", {})).status).toBe(403);
    expect(resume).not.toHaveBeenCalled();
    resume.mockResolvedValueOnce({
      refresh: refresh("running"),
      outcome: "accepted",
      retryAt: null,
    });
    const accepted = await request(path, "write", {});
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      refresh: { ...wire("running"), windows: [] },
      outcome: "accepted",
      retryAt: null,
    });
    expect(resume).toHaveBeenLastCalledWith("synthetic-refresh");
    const deferred = await request(path, "write", {});
    expect(deferred.status).toBe(200);
    expect(await deferred.json()).toEqual({
      refresh: { ...wire("running"), windows: [] },
      outcome: "held",
      retryAt: "2040-01-01T00:10:00.000Z",
    });
    resume.mockResolvedValueOnce({
      refresh: refresh("completed"),
      outcome: "terminal",
      retryAt: null,
    });
    const finished = await request(path, "write", {});
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({
      refresh: { status: "completed" },
      outcome: "terminal",
    });
    const unknown = await request("/v1/refreshes/missing/resume", "write", {});
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("not_found");
    // Resume takes only the refresh: no range, force or override.
    for (const body of [
      { from: "2040-01-01", to: "2040-01-31" },
      { refreshId: "other" },
      { operator: true },
    ]) {
      expect((await request(path, "write", body)).status).toBe(400);
    }
    expect(start).not.toHaveBeenCalled();
    expect(startAll).not.toHaveBeenCalled();

    const connect = async (bearer: string) => {
      const client = new Client({ name: "synthetic-resume", version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          fetch: async (input, init) => {
            const forwarded = new Request(input, init);
            forwarded.headers.set("authorization", `Bearer ${bearer}`);
            return service.app.fetch(forwarded);
          },
        }),
      );
      return client;
    };
    const read = await connect("read");
    expect(
      (await read.listTools()).tools.find(
        (tool) => tool.name === "resume_refresh",
      )?.annotations,
    ).toStrictEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    const calls = resume.mock.calls.length;
    expect(
      await read.callTool({
        name: "resume_refresh",
        arguments: { refreshId: "synthetic-refresh" },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "forbidden" } },
    });
    expect(resume.mock.calls.length).toBe(calls);
    const write = await connect("write");
    expect(
      await write.callTool({
        name: "resume_refresh",
        arguments: { refreshId: "synthetic-refresh" },
      }),
    ).toMatchObject({
      structuredContent: {
        refresh: { id: "synthetic-refresh", status: "running" },
        outcome: "held",
        retryAt: "2040-01-01T00:10:00.000Z",
      },
    });
    expect(
      await write.callTool({
        name: "resume_refresh",
        arguments: { refreshId: "missing" },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "not_found" } },
    });
  });

  it("logs only registered route patterns and fixed request metadata, including error status", async () => {
    const entries: HttpRequestLog[] = [];
    const { request: setupRequest } = setup(
      {
        refreshes: {
          start: async () => {
            throw new Error("private-driver-error-value");
          },
          startAll: async () => [],
        },
      },
      (entry) => {
        entries.push(entry);
      },
    );
    // A JSON body declares no length; its entry is emitted once it is read.
    const request = async (...input: Parameters<typeof setupRequest>) => {
      const response = await setupRequest(...input);
      await response.arrayBuffer();
      return response;
    };
    const failed = await setupRequest(
      `/v1/connections/${connectionId}/refreshes?secret=private-query`,
      "write",
      {},
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe(
      '{"error":{"code":"internal_error","message":"Operation failed."}}',
    );
    expect(entries.at(-1)).toMatchObject({
      method: "POST",
      route: "/v1/connections/:connectionId/refreshes",
      status: 500,
      durationMs: expect.any(Number),
      responseBytes: 65,
    });
    expect(
      (
        await request(
          "/synthetic-login/private-email?token=private-token",
          "untrusted",
        )
      ).status,
    ).toBe(400);
    expect(entries.at(-1)?.route).toBe("/*");
    expect(
      (
        await request(
          `/v1/connections/${connectionId}/refreshes`,
          "untrusted",
          {},
        )
      ).status,
    ).toBe(401);
    expect(entries.at(-1)?.status).toBe(401);
    expect(
      (await request("/private-unmatched-path?secret=private-query", "read"))
        .status,
    ).toBe(404);
    expect(entries.at(-1)?.status).toBe(404);
    const encoded = JSON.stringify(entries);
    for (const value of [
      connectionId,
      "private-query",
      "private-driver-error-value",
      "private-email",
      "private-token",
      "private-unmatched-path",
      "authorization",
    ]) {
      expect(encoded).not.toContain(value);
    }
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "durationMs",
        "method",
        "responseBytes",
        "route",
        "status",
      ]);
    }
  });

  it("preserves responses when a request logger throws", async () => {
    const { request } = setup({}, () => {
      throw new Error("synthetic-log-failure");
    });
    expect((await request("/health", "read")).status).toBe(200);
    expect((await request("/health", "untrusted")).status).toBe(401);
  });

  it("classifies MCP headers through fixed allowlists without reading bodies or logging unknown header values", async () => {
    const entries: HttpRequestLog[] = [];
    const { service } = setup({}, (entry) => {
      entries.push(entry);
    });
    const request = async (path: string, headers: Record<string, string>) => {
      const response = await service.app.request(`${origin}${path}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer deliberately-untrusted-secret",
          "Content-Type": "application/json",
          ...headers,
        },
        body: '{"method":"private-body-method","token":"private-body-token"}',
      });
      await response.arrayBuffer();
      return response;
    };
    // Rejection before MCP dispatch proves the logger does not need to parse a body.
    expect(
      (
        await request("/mcp?token=private-query", {
          "Mcp-Method": "events/list",
          "MCP-Protocol-Version": "2026-07-28",
        })
      ).status,
    ).toBe(401);
    expect(entries.at(-1)).toMatchObject({
      method: "POST",
      status: 401,
      mcpMethod: "events/list",
      mcpProtocol: "2026-07-28",
    });
    await request("/mcp", {
      "Mcp-Method": "initialize",
      "MCP-Protocol-Version": "2025-03-26",
    });
    expect(entries.at(-1)).toMatchObject({
      mcpMethod: "initialize",
      mcpProtocol: "2025-03-26",
    });
    await request("/mcp", {
      "Mcp-Method": "private-header-secret-method",
      "MCP-Protocol-Version": "private-header-secret-protocol",
    });
    expect(entries.at(-1)).toMatchObject({
      mcpMethod: "other",
      mcpProtocol: "other",
    });
    await request("/mcp", {});
    expect(entries.at(-1)).toMatchObject({
      mcpMethod: "unspecified",
      mcpProtocol: "unspecified",
    });
    await request("/mcp/", {
      "Mcp-Method": "events/list",
      "MCP-Protocol-Version": "2026-07-28",
    });
    expect(entries.at(-1)).not.toHaveProperty("mcpMethod");
    expect(entries.at(-1)).not.toHaveProperty("mcpProtocol");
    await request("/health", {
      "Mcp-Method": "events/list",
      "MCP-Protocol-Version": "2026-07-28",
    });
    expect(entries.at(-1)).not.toHaveProperty("mcpMethod");
    expect(entries.at(-1)).not.toHaveProperty("mcpProtocol");
    const encoded = JSON.stringify(entries);
    for (const value of [
      "private-body-method",
      "private-body-token",
      "private-query",
      "private-header-secret",
      "deliberately-untrusted-secret",
    ]) {
      expect(encoded).not.toContain(value);
    }
  });

  it("logs declared request and response lengths without waiting for the body", async () => {
    const entries: HttpRequestLog[] = [];
    const { service } = setup({}, (entry) => {
      entries.push(entry);
    });
    const fixed = await service.app.request(`${origin}/synthetic-body/fixed`, {
      headers: { "Content-Length": "0012" },
    });
    expect(entries.at(-1)).toMatchObject({
      method: "GET",
      route: "/*",
      status: 200,
      requestBytes: 12,
      responseBytes: 10,
    });
    expect(await fixed.text()).toBe("fixed-body");
    expect(entries).toHaveLength(1);
    await service.app.request(`${origin}/synthetic-body/fixed`, {
      headers: { "Content-Length": "99999999999999999999" },
    });
    expect(entries.at(-1)?.requestBytes).toBe(Number.MAX_SAFE_INTEGER);
    await service.app.request(`${origin}/synthetic-body/fixed`, {
      headers: { "Content-Length": "12; private-header-value" },
    });
    expect(entries.at(-1)).not.toHaveProperty("requestBytes");
    await service.app.request(`${origin}/synthetic-body/fixed`, {
      method: "HEAD",
    });
    expect(entries.at(-1)).toMatchObject({ method: "HEAD", responseBytes: 0 });
    expect(JSON.stringify(entries)).not.toContain("private-header-value");
  });

  it("counts a streamed body and logs it when the body ends, is cancelled or fails", async () => {
    const entries: HttpRequestLog[] = [];
    const { service } = setup({}, (entry) => {
      entries.push(entry);
    });
    const streamed = await service.app.request(
      `${origin}/synthetic-body/stream`,
    );
    expect(entries).toHaveLength(0);
    expect(await streamed.text()).toBe("first-second");
    expect(entries).toEqual([
      expect.objectContaining({
        method: "GET",
        route: "/*",
        status: 200,
        responseBytes: 12,
      }),
    ]);

    endlessCancelled = false;
    const endless = await service.app.request(
      `${origin}/synthetic-body/endless`,
    );
    expect(endless.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = endless.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("tick");
    expect(entries).toHaveLength(1);
    await reader.cancel();
    expect(endlessCancelled).toBe(true);
    expect(entries.at(-1)).toMatchObject({ status: 200, responseBytes: 4 });

    const broken = await service.app.request(`${origin}/synthetic-body/broken`);
    await expect(broken.text()).rejects.toThrow("synthetic-stream-failure");
    expect(entries.at(-1)).toMatchObject({ status: 200, responseBytes: 4 });
    expect(entries).toHaveLength(3);
  });

  it("preserves streamed responses when a request logger throws or rejects", async () => {
    for (const logger of [
      () => {
        throw new Error("synthetic-log-failure");
      },
      async () => {
        throw new Error("synthetic-log-failure");
      },
    ]) {
      const { service } = setup({}, logger);
      const streamed = await service.app.request(
        `${origin}/synthetic-body/stream`,
      );
      expect(streamed.status).toBe(200);
      expect(await streamed.text()).toBe("first-second");
      const fixed = await service.app.request(`${origin}/synthetic-body/fixed`);
      expect(await fixed.text()).toBe("fixed-body");
    }
  });
});
