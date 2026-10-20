import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { neonTriggerAuthenticator } from "../../deploy/neon/function.js";
import type {
  CollectionEvent,
  ProviderCollector,
} from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  type CollectionRoutesOptions,
  createCollectionRoutes,
} from "../../src/runtime/collection-routes.js";
import { createRefreshService } from "../../src/runtime/refresh-service.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";

const origin = "https://polling.synthetic.invalid";
const secret = "synthetic-machine-collection-secret-0000000000000";
const capture: CollectionEvent = {
  type: "capture",
  capture: {
    accountKey: "synthetic-account",
    endpoint: "synthetic:cal/recent",
    capturedAt: "2040-08-01T00:00:00Z",
    responseText: readFileSync(
      new URL("../providers/cal/fixtures/recent-01.json", import.meta.url),
      "utf8",
    ),
  },
};
const payload = (invocation = "synthetic-occurrence") => ({
  version: 1,
  invocation_id: invocation,
  trigger: {
    type: "schedule",
    id: "trigger-synthetic",
    name: "collect-hourly",
  },
  data: { scheduled_at: "2040-08-01T00:00:00Z" },
});
const request = (
  path: string,
  headers: Record<string, string> = {},
  body: unknown = {},
) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("internal collection routes", () => {
  let db: Database;
  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: "cal-connection", provider: "cal" });
  });
  afterEach(async () => {
    await db.close();
    vi.restoreAllMocks();
  });

  function setup(
    collect: ProviderCollector["collect"],
    options: Pick<CollectionRoutesOptions, "authenticateScheduledRequest"> = {
      authenticateScheduledRequest: neonTriggerAuthenticator("collect-hourly"),
    },
    scheduledRun?: Parameters<typeof createCollectionRoutes>[2],
  ) {
    const refreshes = createRefreshService({
      store: db,
      targets: async () => ({
        targets: [
          {
            connectionId: "cal-connection",
            adapter: calAdapter,
            collector: async () => ({
              provider: "cal",
              collectorVersion: "synthetic-collector-v1",
              collect,
            }),
          },
        ],
        failures: 0,
      }),
      log: () => {},
    });
    const routes = createCollectionRoutes(
      refreshes,
      { publicOrigin: origin, manualSecret: secret, ...options },
      scheduledRun,
    );
    return { refreshes, routes };
  }

  it("authenticates the operator and native paths separately, with bounded strict input", async () => {
    const collect = vi.fn(async function* () {
      yield capture;
    });
    const { routes } = setup(collect);
    expect(
      await routes.handleRequest(new Request(`${origin}/health`)),
    ).toBeNull();
    for (const headers of [
      {},
      { Authorization: "Bearer human-owner-oauth-token" },
      { "x-neon-trigger-invocation-id": "synthetic-occurrence" },
    ]) {
      for (const path of [
        "/internal/collect/recent",
        "/internal/refreshes/continue",
      ]) {
        expect(
          (await routes.handleRequest(request(path, headers)))?.status,
        ).toBe(401);
      }
    }
    for (const [headers, body] of [
      [{ Authorization: `Bearer ${secret}` }, payload()],
      [{ "x-neon-trigger-invocation-id": "wrong-occurrence" }, payload()],
    ] as const) {
      expect(
        (
          await routes.handleRequest(
            request("/internal/triggers/recent", headers, body),
          )
        )?.status,
      ).toBe(403);
    }
    const operator = { Authorization: `Bearer ${secret}` };
    expect(
      (
        await routes.handleRequest(
          request("/internal/collect/recent", {
            ...operator,
            Origin: "https://attacker.invalid",
          }),
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await routes.handleRequest(
          request("/internal/collect/recent", operator, {
            connectionId: "untrusted",
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await routes.handleRequest(
          request("/internal/collect/recent", operator, {
            padding: "x".repeat(8193),
          }),
        )
      )?.status,
    ).toBe(413);
    expect(collect).not.toHaveBeenCalled();
    const response = await routes.handleRequest(
      request("/internal/collect/recent", operator),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      refreshes: [
        {
          connectionId: "cal-connection",
          reason: null,
          refresh: { trigger: "manual", status: "completed" },
        },
      ],
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(
      (
        await routes.handleRequest(
          request("/internal/refreshes/continue", operator),
        )
      )?.status,
    ).toBe(202);
  });

  it("records one scheduled refresh per occurrence, and denies until an authenticator is supplied", async () => {
    const collect = vi.fn(async function* () {
      yield capture;
    });
    const scheduled = (body: unknown, headers: Record<string, string> = {}) =>
      request("/internal/triggers/recent", headers, body);
    const unconfigured = setup(collect, {});
    expect(
      (await unconfigured.routes.handleRequest(scheduled({})))?.status,
    ).toBe(403);
    const authenticate = vi.fn(
      async (incoming: Request, readBody: () => Promise<unknown>) => {
        const occurrence = incoming.headers.get("x-synthetic-occurrence");
        return occurrence && typeof (await readBody()) === "object"
          ? {
              invocationId: occurrence,
              scheduledAt: Date.parse("2040-08-01T00:00:00Z"),
            }
          : { denied: "synthetic_denied" };
      },
    );
    const { routes } = setup(collect, {
      authenticateScheduledRequest: authenticate,
    });
    expect(
      (
        await routes.handleRequest(
          scheduled(
            { padding: "x".repeat(8193) },
            { "x-synthetic-occurrence": "big" },
          ),
        )
      )?.status,
    ).toBe(413);
    expect((await routes.handleRequest(scheduled({})))?.status).toBe(403);
    expect(
      (
        await routes.handleRequest(
          scheduled({}, { "x-synthetic-occurrence": "x".repeat(513) }),
        )
      )?.status,
    ).toBe(403);
    expect(collect).not.toHaveBeenCalled();
    const first = await routes.handleRequest(
      scheduled({}, { "x-synthetic-occurrence": "hour-one" }),
    );
    expect(first?.status).toBe(200);
    const body = (await first!.json()) as {
      refreshes: {
        refresh: { id: string; trigger: string; scheduledAt: string };
      }[];
    };
    expect(body.refreshes[0]?.refresh).toMatchObject({
      trigger: "scheduled",
      scheduledAt: "2040-08-01T00:00:00.000Z",
    });
    // A retried occurrence reports the same refresh and collects nothing again.
    const retried = await routes.handleRequest(
      scheduled({}, { "x-synthetic-occurrence": "hour-one" }),
    );
    expect(
      ((await retried!.json()) as typeof body).refreshes[0]?.refresh.id,
    ).toBe(body.refreshes[0]?.refresh.id);
    expect(collect).toHaveBeenCalledOnce();
  });

  it("hands an authenticated scheduled request to the host's own occurrence", async () => {
    const collect = vi.fn(async function* () {
      yield capture;
    });
    const scheduledRun = vi.fn(async () => undefined);
    const { routes } = setup(
      collect,
      {
        authenticateScheduledRequest: async (incoming) =>
          incoming.headers.get("x-synthetic-occurrence")
            ? { invocationId: "ignored" }
            : { denied: "synthetic_denied" },
      },
      scheduledRun,
    );
    expect(
      (await routes.handleRequest(request("/internal/triggers/recent")))
        ?.status,
    ).toBe(403);
    expect(scheduledRun).not.toHaveBeenCalled();
    const response = await routes.handleRequest(
      request("/internal/triggers/recent", { "x-synthetic-occurrence": "one" }),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ refreshes: [] });
    expect(scheduledRun).toHaveBeenCalledOnce();
    expect(collect).not.toHaveBeenCalled();
  });
});
