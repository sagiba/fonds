import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  CallbackEndpointError,
  createEventService,
  type EventService,
} from "../../src/application/events.js";
import { createHttpService } from "../../src/transport/http.js";

const origin = "https://fonds.synthetic.invalid";
const services: ReturnType<typeof createHttpService>[] = [];
const params = {
  name: "changes.available",
  arguments: { connectionId: "cal" },
  delivery: {
    mode: "webhook",
    url: "https://callback.synthetic.invalid/events",
    secret: `whsec_${btoa("s".repeat(32))}`,
  },
};

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function mockEvents(): EventService {
  return {
    list: vi.fn(async () => ({
      events: [
        {
          name: "changes.available",
          description: "Synthetic event",
          delivery: ["webhook"],
          inputSchema: z.toJSONSchema(
            z.object({ connectionId: z.string() }).strict(),
          ),
          payloadSchema: z.toJSONSchema(
            z
              .object({
                connectionId: z.string(),
                after: z.string(),
                highWaterMark: z.string(),
              })
              .strict(),
          ),
        },
      ],
    })),
    subscribe: vi.fn(async () => ({
      id: "sub-synthetic",
      refreshBefore: "2040-01-02T00:00:00.000Z",
      cursor: null,
      truncated: false,
    })),
    unsubscribe: vi.fn(async () => ({})),
    deliver: vi.fn(async () => ({ sent: 0, acknowledged: 0, failed: 0 })),
  };
}

function setup(events: EventService = mockEvents()) {
  const service = createHttpService(
    { backend: "postgres", operations: [] },
    {
      publicOrigin: origin,
      ownerId: "owner",
      events,
      authProvider: {
        issuer: `${origin}/api/auth`,
        authenticate: async (request) => {
          const bearer = request.headers.get("authorization");
          if (!bearer) {
            return null;
          }
          return {
            source: "issuer",
            subject: "owner",
            ownerId: "owner",
            clientId:
              bearer === "Bearer other-client" ? "other-client" : "client",
            ...(bearer === "Bearer no-session"
              ? {}
              : { sessionId: "verified-session" }),
            resource: `${origin}/mcp`,
            scopes:
              bearer === "Bearer write"
                ? ["financial:write"]
                : ["financial:read"],
          };
        },
      },
    },
  );
  services.push(service);

  async function request(
    method: string,
    input: object = {},
    bearer = "read",
    headers: Record<string, string> = {},
  ) {
    const response = await service.app.request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${bearer}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...input,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "synthetic-events", version: "1" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    return { response, data: await response.json() };
  }

  return { events, service, request };
}

describe("authenticated MCP Events protocol", () => {
  it("advertises Events and serves all three custom methods on the existing endpoint", async () => {
    const { request, events } = setup();
    expect(
      (await request("server/discover")).data.result.capabilities.events,
    ).toEqual({});
    expect((await request("events/list")).data.result.events[0].name).toBe(
      "changes.available",
    );
    expect(
      (await request("events/subscribe", params)).data.result,
    ).toMatchObject({ id: "sub-synthetic", cursor: null, truncated: false });
    expect(events.subscribe).toHaveBeenCalledWith(
      {
        ownerId: "owner",
        clientId: "client",
        scopes: ["financial:read"],
      },
      params,
    );
    const unsub = {
      ...params,
      delivery: { mode: "webhook", url: params.delivery.url },
    };
    expect(
      (await request("events/unsubscribe", unsub)).data.result.resultType,
    ).toBe("complete");
    expect(events.unsubscribe).toHaveBeenCalledOnce();
  });

  it("requires read scope for every event operation and preserves request isolation", async () => {
    // The real event service owns the scope check; none of its dependencies run.
    const dependencies = {
      store: {
        get: vi.fn(),
        save: vi.fn(),
        listDue: vi.fn(),
        latestEventId: vi.fn(),
      },
      source: { getConnection: vi.fn(), listEvents: vi.fn() },
      sendSignedWebhook: vi.fn(),
      verifyWebhookCallback: vi.fn(),
      grantCheck: vi.fn(async () => true),
    };
    const denied = setup(createEventService(dependencies));
    for (const [method, input] of [
      ["events/list", {}],
      ["events/subscribe", params],
      [
        "events/unsubscribe",
        { ...params, delivery: { mode: "webhook", url: params.delivery.url } },
      ],
    ] as const) {
      expect(
        (await denied.request(method, input, "write")).data.error,
      ).toMatchObject({ code: -32001 });
    }
    expect(dependencies.grantCheck).not.toHaveBeenCalled();
    expect(dependencies.store.get).not.toHaveBeenCalled();
    expect(dependencies.verifyWebhookCallback).not.toHaveBeenCalled();
    const { request, events } = setup();
    await Promise.all([
      request("events/subscribe", params),
      request("events/subscribe", params, "other-client"),
    ]);
    expect(
      vi
        .mocked(events.subscribe)
        .mock.calls.map(([identity]) => identity.clientId)
        .sort(),
    ).toEqual(["client", "other-client"]);
  });

  it("allows an authorized durable owner grant after its browser sid is removed", async () => {
    const { request, events } = setup();
    expect(
      (await request("events/list", {}, "no-session")).data.result.events[0]
        .name,
    ).toBe("changes.available");
    expect(
      (await request("events/subscribe", params, "no-session")).data.result.id,
    ).toBe("sub-synthetic");
    expect(events.subscribe).toHaveBeenCalledWith(
      { ownerId: "owner", clientId: "client", scopes: ["financial:read"] },
      params,
    );
  });

  it("rejects missing bearer, forged input identities, invalid origins and malformed subscriptions", async () => {
    const { request, service, events } = setup();
    expect(
      (
        await service.app.request(`${origin}/mcp`, {
          headers: { "oai-authenticated-user-id": "owner" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("events/subscribe", {
          ...params,
          principal: { ownerId: "other-owner" },
        })
      ).data.error,
    ).toBeDefined();
    expect(
      (
        await request("events/subscribe", {
          ...params,
          arguments: { connectionId: "cal", extra: true },
        })
      ).data.error,
    ).toBeDefined();
    expect(
      (
        await request("events/subscribe", params, "read", {
          Origin: "https://attacker.invalid",
        })
      ).response.status,
    ).toBe(403);
    expect(events.subscribe).not.toHaveBeenCalled();
  });

  it("preserves categorized callback errors and hides unexpected error details", async () => {
    const { request, events } = setup();
    vi.mocked(events.subscribe).mockRejectedValueOnce(
      new CallbackEndpointError("timeout"),
    );
    expect(
      (await request("events/subscribe", params)).data.error,
    ).toMatchObject({ code: -32015, data: { reason: "timeout" } });
    vi.mocked(events.subscribe).mockRejectedValueOnce(
      new Error("synthetic-private-database-secret"),
    );
    const response = await request("events/subscribe", params);
    expect(response.data.error).toMatchObject({
      code: -32603,
      message: "Event operation failed.",
    });
    expect(JSON.stringify(response.data)).not.toContain("synthetic-private");
  });
});
