import { describe, expect, it, vi } from "vitest";

import {
  CallbackEndpointError,
  createEventService,
  type EventPrincipal,
  type EventSubscription,
  type EventSubscriptionStore,
  type SignedWebhookInput,
} from "../../src/application/events.js";
import { createApplication } from "../../src/application/operations.js";
import { encodeCursor } from "../../src/application/query-inputs.js";
import type { LedgerEvent } from "../../src/domain/records.js";

const principal: EventPrincipal = {
  ownerId: "owner",
  clientId: "client",
  scopes: ["financial:read", "offline_access"],
};
const secret = `whsec_${btoa("s".repeat(32))}`;
const params = {
  name: "changes.available",
  arguments: { connectionId: "cal" },
  delivery: {
    mode: "webhook",
    url: "https://callback.example.invalid/events",
    secret,
  },
};

function setup() {
  let time = Date.parse("2040-01-01T00:00:00Z");
  const changes: LedgerEvent[] = [];
  const rows = new Map<string, EventSubscription>();
  const store: EventSubscriptionStore = {
    get: async (id) => structuredClone(rows.get(id)),
    save: async (value, generation) => {
      if ((rows.get(value.id)?.generation ?? 0) !== generation) {
        return undefined;
      }
      const next = structuredClone({ ...value, generation: generation + 1 });
      rows.set(value.id, next);
      return structuredClone(next);
    },
    listDue: async (now, limit) =>
      [...rows.values()]
        .filter(
          (row) =>
            row.status === "active" &&
            row.expiresAt > now &&
            row.nextAttemptAt <= now,
        )
        .sort(
          (a, b) =>
            a.nextAttemptAt - b.nextAttemptAt || a.id.localeCompare(b.id),
        )
        .slice(0, limit)
        .map((row) => structuredClone(row)),
    latestEventId: async () => changes.at(-1)?.id ?? 0,
  };
  const sendSignedWebhook = vi.fn(
    async (_input: SignedWebhookInput) => new Response(null, { status: 200 }),
  );
  const verifyWebhookCallback = vi.fn(async () => {});
  const grantCheck = vi.fn(async () => true);
  const source = {
    getConnection: vi.fn(async (id: string) =>
      id === "cal"
        ? {
            id,
            provider: "synthetic-provider",
            displayName: "Synthetic",
            createdAt: "2040-01-01T00:00:00Z",
            latestRefresh: null,
          }
        : undefined,
    ),
    listEvents: vi.fn(
      async (input: {
        connectionId?: string;
        after?: number;
        limit?: number;
      }) =>
        changes
          .filter((change) => change.id > (input.after ?? 0))
          .slice(0, input.limit ?? 100),
    ),
  };
  const service = createEventService({
    store,
    source,
    sendSignedWebhook,
    verifyWebhookCallback,
    grantCheck,
    now: () => time,
  });
  const change = (id: number, type = "transaction.created"): LedgerEvent => ({
    id,
    connectionId: "synthetic",
    type,
    transactionId: type === "sync.baseline" ? null : `tx-${id}`,
    runId: "run",
    createdAt: "2040-01-01T00:01:00Z",
    actor: "sync",
    before: null,
    after: { syntheticSensitiveSource: "must-not-leak" },
  });
  return {
    service,
    store,
    rows,
    changes,
    change,
    source,
    sendSignedWebhook,
    verifyWebhookCallback,
    grantCheck,
    advance: (ms: number) => {
      time += ms;
    },
    now: () => time,
  };
}

describe("durable transaction event operations", () => {
  it("requires explicit read scope, a principal and a live persistent grant", async () => {
    const { service, grantCheck, verifyWebhookCallback } = setup();
    for (const scopes of [[], ["financial:write"]]) {
      const denied = { ...principal, scopes };
      await expect(service.list(denied)).rejects.toMatchObject({
        code: -32001,
      });
      await expect(service.subscribe(denied, params)).rejects.toMatchObject({
        code: -32001,
      });
      await expect(service.unsubscribe(denied, params)).rejects.toMatchObject({
        code: -32001,
      });
    }
    await expect(
      service.subscribe({ ...principal, ownerId: "" }, params),
    ).rejects.toMatchObject({ code: -32001 });
    grantCheck.mockResolvedValue(false);
    await expect(service.subscribe(principal, params)).rejects.toMatchObject({
      code: -32001,
    });
    expect(verifyWebhookCallback).not.toHaveBeenCalled();
    expect((await service.list(principal)).events[0]?.name).toBe(
      "changes.available",
    );
  });

  it("validates filters, callback schemes, signing keys and unsupported replay", async () => {
    const { service } = setup();
    for (const input of [
      { ...params, name: "unknown" },
      { ...params, arguments: { connectionId: "missing" } },
      { ...params, arguments: { connectionId: "cal", extra: true } },
      { ...params, cursor: "historical" },
      {
        ...params,
        delivery: { ...params.delivery, url: "http://localhost/events" },
      },
      {
        ...params,
        delivery: {
          ...params.delivery,
          url: `https://callback.example.invalid/${"a".repeat(2048)}`,
        },
      },
      { ...params, delivery: { ...params.delivery, secret: "whsec_short" } },
      {
        ...params,
        delivery: {
          ...params.delivery,
          secret: `whsec_${btoa("s".repeat(65))}`,
        },
      },
    ]) {
      await expect(service.subscribe(principal, input)).rejects.toThrow();
    }
  });

  it("uses the same subscription identity for equivalent callback hosts and default ports", async () => {
    const { service, rows, verifyWebhookCallback } = setup();
    const { id } = await service.subscribe(principal, {
      ...params,
      delivery: {
        ...params.delivery,
        url: "https://CALLBACK.example.invalid:443/events",
      },
    });
    const renewed = await service.subscribe(principal, params);
    expect(renewed.id).toBe(id);
    expect(rows.size).toBe(1);
    expect(rows.get(id)?.url).toBe(params.delivery.url);
    expect(verifyWebhookCallback).toHaveBeenCalledWith(
      expect.objectContaining({ url: params.delivery.url }),
    );
    await service.unsubscribe(principal, {
      name: params.name,
      arguments: params.arguments,
      delivery: { mode: "webhook", url: params.delivery.url },
    });
    expect(rows.get(id)?.status).toBe("inactive");
  });

  it("rejects callback URLs whose normalized form exceeds the bound before verification", async () => {
    const { service, rows, verifyWebhookCallback } = setup();
    const url = `https://callback.example.invalid/${"é".repeat(700)}`;
    expect(url.length).toBeLessThan(2048);
    expect(new URL(url).href.length).toBeGreaterThan(2048);
    await expect(
      service.subscribe(principal, {
        ...params,
        delivery: { ...params.delivery, url },
      }),
    ).rejects.toThrow();
    expect(rows.size).toBe(0);
    expect(verifyWebhookCallback).not.toHaveBeenCalled();
  });

  it("starts at the current cursor, preserves active refresh state and bounds granted TTL", async () => {
    const {
      service,
      rows,
      changes,
      change,
      now,
      advance,
      verifyWebhookCallback,
    } = setup();
    changes.push(change(5));
    const first = await service.subscribe(principal, { ...params, ttlMs: 1 });
    expect(first).toMatchObject({ cursor: null, truncated: false });
    expect(Date.parse(first.refreshBefore)).toBe(now() + 60_000);
    expect(rows.get(first.id)?.cursor).toBe(5);
    changes.push(change(6));
    advance(1000);
    const second = await service.subscribe(principal, {
      ...params,
      ttlMs: 20 * 24 * 60 * 60 * 1000,
    });
    expect(second.id).toBe(first.id);
    expect(rows.get(first.id)?.cursor).toBe(5);
    expect(Date.parse(second.refreshBefore)).toBe(
      now() + 7 * 24 * 60 * 60 * 1000,
    );
    expect(verifyWebhookCallback).toHaveBeenCalledOnce();
    const finite = await service.subscribe(principal, {
      ...params,
      ttlMs: null,
    });
    expect(Date.parse(finite.refreshBefore)).toBe(now() + 24 * 60 * 60 * 1000);
  });

  it("verifies before activation, sanitizes callback errors and keeps old subscription on failed rotation", async () => {
    const { service, rows, verifyWebhookCallback } = setup();
    verifyWebhookCallback.mockRejectedValueOnce(
      new Error("private callback details"),
    );
    await expect(service.subscribe(principal, params)).rejects.toMatchObject({
      code: -32015,
      reason: "challenge_failed",
      message: "Callback endpoint verification failed.",
    });
    expect(rows.size).toBe(0);
    const { id } = await service.subscribe(principal, params);
    verifyWebhookCallback.mockRejectedValueOnce(
      new CallbackEndpointError("timeout"),
    );
    await expect(
      service.subscribe(principal, {
        ...params,
        delivery: {
          ...params.delivery,
          secret: `whsec_${btoa("n".repeat(32))}`,
        },
      }),
    ).rejects.toMatchObject({ code: -32015, reason: "timeout" });
    expect(rows.get(id)?.secret).toBe(secret);
  });

  it("coalesces every committed kind including baseline/history into a bounded wake-up", async () => {
    const { service, rows, changes, change, sendSignedWebhook } = setup();
    changes.push(change(1));
    const { id } = await service.subscribe(principal, params);
    changes.push(
      change(2, "sync.baseline"),
      change(3, "transaction.updated"),
      change(4),
    );
    expect(await service.deliver()).toEqual({
      sent: 1,
      acknowledged: 1,
      failed: 0,
    });
    const sent = sendSignedWebhook.mock.calls[0]![0];
    expect(sent.body).toEqual({
      eventId: `${id}_1_4`,
      name: "changes.available",
      timestamp: "2040-01-01T00:00:00.000Z",
      data: {
        connectionId: "cal",
        after: encodeCursor("event", 1),
        highWaterMark: encodeCursor("event", 4),
      },
      cursor: null,
    });
    expect(JSON.stringify(sent.body)).not.toContain("must-not-leak");
    expect(rows.get(id)?.cursor).toBe(4);
    await service.deliver();
    expect(sendSignedWebhook).toHaveBeenCalledOnce();
  });

  it("retries the same event after failure, acknowledges only 2xx and pauses at bounded attempts", async () => {
    const { service, rows, changes, change, sendSignedWebhook, advance } =
      setup();
    const { id } = await service.subscribe(principal, params);
    changes.push(change(1), change(2));
    sendSignedWebhook.mockImplementation(
      async () => new Response(null, { status: 503 }),
    );
    // Hourly delivery passes: about a day of receiver downtime is tolerated.
    for (let attempt = 1; attempt <= 24; attempt++) {
      if (attempt < 24) {
        expect(rows.get(id)?.status).toBe("active");
      }
      expect((await service.deliver()).failed).toBe(1);
      expect(rows.get(id)?.cursor).toBe(0);
      expect(rows.get(id)?.attempts).toBe(attempt);
      await service.deliver();
      expect(sendSignedWebhook).toHaveBeenCalledTimes(attempt);
      advance(60 * 60 * 1000);
    }
    expect(rows.get(id)).toMatchObject({
      status: "failed",
      reason: "attempts_exhausted",
      cursor: 0,
    });
    expect(
      new Set(sendSignedWebhook.mock.calls.map(([input]) => input.eventId)),
    ).toEqual(new Set([`${id}_0_2`]));
    await service.deliver();
    expect(sendSignedWebhook).toHaveBeenCalledTimes(24);
  });

  it("revokes a failed delivery before retry without sending again or advancing its cursor", async () => {
    const {
      service,
      rows,
      changes,
      change,
      sendSignedWebhook,
      grantCheck,
      advance,
    } = setup();
    changes.push(change(1));
    const { id } = await service.subscribe(principal, params);
    changes.push(change(2));
    sendSignedWebhook.mockResolvedValueOnce(
      new Response(null, { status: 503 }),
    );
    expect(await service.deliver()).toEqual({
      sent: 0,
      acknowledged: 0,
      failed: 1,
    });
    expect(sendSignedWebhook).toHaveBeenCalledOnce();
    expect(rows.get(id)).toMatchObject({
      status: "active",
      reason: "retry_pending",
      cursor: 1,
      attempts: 1,
      pendingBatch: { through: 2 },
    });
    grantCheck.mockResolvedValue(false);
    grantCheck.mockClear();
    advance(60_001);
    expect(await service.deliver()).toEqual({
      sent: 0,
      acknowledged: 0,
      failed: 0,
    });
    expect(grantCheck).toHaveBeenCalledExactlyOnceWith({
      ownerId: "owner",
      clientId: "client",
    });
    expect(sendSignedWebhook).toHaveBeenCalledOnce();
    expect(rows.get(id)).toMatchObject({
      status: "revoked",
      reason: "access_revoked",
      cursor: 1,
      attempts: 1,
      pendingBatch: { through: 2 },
    });
  });

  it("retains a retry boundary and body while newer changes wait for the next wake-up", async () => {
    const { service, changes, change, sendSignedWebhook, rows, advance } =
      setup();
    const { id } = await service.subscribe(principal, params);
    changes.push(
      change(1, "transaction.posted"),
      change(2, "transaction.linked"),
    );
    sendSignedWebhook.mockResolvedValueOnce(
      new Response(null, { status: 503 }),
    );
    await service.deliver();
    const first = structuredClone(sendSignedWebhook.mock.calls[0]![0].body);
    changes.push(
      change(3, "annotation.updated"),
      change(4, "transaction.unlinked"),
    );
    advance(60_000);
    await service.subscribe(principal, params);
    await service.deliver();
    expect(sendSignedWebhook.mock.calls[1]![0].body).toEqual(first);
    expect(rows.get(id)).toMatchObject({ cursor: 2, pendingBatch: null });
    await service.deliver();
    expect(sendSignedWebhook.mock.calls[2]![0].body).toMatchObject({
      eventId: `${id}_2_4`,
      data: {
        connectionId: "cal",
        after: encodeCursor("event", 2),
        highWaterMark: encodeCursor("event", 4),
      },
    });
    expect(rows.get(id)?.cursor).toBe(4);
  });

  it("passes the wake-up cursors straight to list_events", async () => {
    const { service, source, changes, change, sendSignedWebhook } = setup();
    changes.push(change(1));
    await service.subscribe(principal, params);
    changes.push(change(2), change(3, "transaction.updated"), change(4));
    await service.deliver();
    const data = sendSignedWebhook.mock.calls[0]![0].body.data as {
      after: string;
      highWaterMark: string;
    };
    expect(data).toEqual({
      connectionId: "cal",
      after: encodeCursor("event", 1),
      highWaterMark: encodeCursor("event", 4),
    });
    const listEvents = createApplication({
      backend: "sqlite",
      listEvents: source.listEvents,
    } as never).operations.find(
      (operation) => operation.name === "list_events",
    )!;
    const page = (await listEvents.execute({
      connectionId: "cal",
      cursor: data.after,
    })) as { data: { id: number }[]; hasMore: boolean; nextCursor: string };
    expect(page.data.map((event) => event.id)).toEqual([2, 3, 4]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBe(data.highWaterMark);
  });

  it("coalesces imported rows into one wake-up instead of one notification per row", async () => {
    const { service, changes, change, sendSignedWebhook } = setup();
    await service.subscribe(principal, params);
    for (let index = 1; index <= 250; index++) {
      changes.push(change(index, "transaction.imported"));
    }
    await service.deliver();
    expect(sendSignedWebhook).toHaveBeenCalledOnce();
    expect(sendSignedWebhook.mock.calls[0]![0].body).toMatchObject({
      name: "changes.available",
      data: {
        connectionId: "cal",
        after: encodeCursor("event", 0),
        highWaterMark: encodeCursor("event", 250),
      },
    });
    await service.deliver();
    expect(sendSignedWebhook).toHaveBeenCalledOnce();
  });

  it("wakes on non-discovery changes and preserves the queue if access is revoked before sending", async () => {
    const {
      service,
      store,
      changes,
      change,
      sendSignedWebhook,
      grantCheck,
      rows,
    } = setup();
    const { id } = await service.subscribe(principal, params);
    for (const [index, kind] of [
      "posted",
      "linked",
      "annotated",
      "unlisted",
      "removed",
      "restored",
      "sync_failed",
      "sync_recovered",
    ].entries()) {
      changes.push(change(index + 1, kind));
    }
    grantCheck.mockClear();
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementationOnce(
      async (value, generation) => {
        const saved = await save(value, generation);
        grantCheck.mockResolvedValue(false);
        return saved;
      },
    );
    await service.deliver();
    expect(grantCheck).toHaveBeenCalledOnce();
    expect(sendSignedWebhook).not.toHaveBeenCalled();
    expect(rows.get(id)).toMatchObject({
      status: "revoked",
      cursor: 0,
      pendingBatch: { through: 8 },
    });
    changes.push(change(9, "annotation.updated"));
    grantCheck.mockResolvedValue(true);
    await service.subscribe(principal, params);
    expect(rows.get(id)).toMatchObject({
      status: "active",
      cursor: 0,
      pendingBatch: { through: 8 },
    });
    await service.deliver();
    expect(sendSignedWebhook.mock.calls[0]![0].body).toMatchObject({
      data: {
        after: encodeCursor("event", 0),
        highWaterMark: encodeCursor("event", 8),
      },
    });
    await service.deliver();
    expect(rows.get(id)?.cursor).toBe(9);
  });

  it("rejects a grant revoked during callback verification before activating the subscription", async () => {
    const { service, rows, grantCheck, verifyWebhookCallback } = setup();
    verifyWebhookCallback.mockImplementationOnce(async () => {
      grantCheck.mockResolvedValue(false);
    });
    await expect(service.subscribe(principal, params)).rejects.toMatchObject({
      code: -32001,
    });
    expect(rows.size).toBe(0);
  });

  it("retains a failed event through transient retry and resumes at the next event after success", async () => {
    const { service, rows, changes, change, sendSignedWebhook, advance } =
      setup();
    const { id } = await service.subscribe(principal, params);
    changes.push(change(1));
    sendSignedWebhook.mockRejectedValueOnce(new Error("network error"));
    await service.deliver();
    expect(rows.get(id)?.cursor).toBe(0);
    advance(60_000);
    expect((await service.deliver()).sent).toBe(1);
    expect(rows.get(id)).toMatchObject({
      cursor: 1,
      attempts: 0,
      status: "active",
    });
    expect(
      sendSignedWebhook.mock.calls.map(([input]) => input.eventId),
    ).toEqual([`${id}_0_1`, `${id}_0_1`]);
  });

  it.each(["accepted", "interrupted"] as const)(
    "records an acknowledgement but otherwise defers caller cancellation during an %s send",
    async (outcome) => {
      const { service, rows, changes, change, sendSignedWebhook, advance } =
        setup();
      const { id } = await service.subscribe(principal, params);
      changes.push(change(1));
      sendSignedWebhook.mockResolvedValueOnce(
        new Response(null, { status: 503 }),
      );
      await service.deliver();
      expect(rows.get(id)).toMatchObject({
        cursor: 0,
        attempts: 1,
        status: "active",
      });
      advance(60_000);
      const controller = new AbortController();
      sendSignedWebhook.mockImplementation(async () => {
        controller.abort();
        if (outcome === "interrupted") {
          throw new Error("Aborted by caller");
        }
        return new Response(null, { status: 200 });
      });
      changes.push(change(2));
      const accepted = outcome === "accepted";
      expect(await service.deliver({ signal: controller.signal })).toEqual({
        sent: accepted ? 1 : 0,
        acknowledged: accepted ? 1 : 0,
        failed: 0,
      });
      expect(rows.get(id)).toMatchObject(
        accepted
          ? { cursor: 1, attempts: 0, status: "active", reason: null }
          : {
              cursor: 0,
              attempts: 1,
              status: "active",
              reason: "retry_pending",
            },
      );
      expect(
        sendSignedWebhook.mock.calls.map(([input]) => input.eventId),
      ).toEqual([`${id}_0_1`, `${id}_0_1`]);
    },
  );

  it.each([400, 410, 413])(
    "does not retry terminal HTTP %s",
    async (status) => {
      const { service, rows, changes, change, sendSignedWebhook, advance } =
        setup();
      const { id } = await service.subscribe(principal, params);
      changes.push(change(1));
      sendSignedWebhook.mockResolvedValue(new Response(null, { status }));
      await service.deliver();
      advance(60 * 60 * 1000);
      await service.deliver();
      expect(rows.get(id)).toMatchObject({
        status: "failed",
        cursor: 0,
        reason: `http_${status}`,
      });
      expect(sendSignedWebhook).toHaveBeenCalledOnce();
    },
  );

  it("rotates secrets without changing identity and dual signs only during the rotation window", async () => {
    const {
      service,
      changes,
      change,
      sendSignedWebhook,
      advance,
      verifyWebhookCallback,
    } = setup();
    const first = await service.subscribe(principal, params);
    const newSecret = `whsec_${btoa("n".repeat(32))}`;
    const second = await service.subscribe(principal, {
      ...params,
      delivery: { ...params.delivery, secret: newSecret },
    });
    expect(second.id).toBe(first.id);
    expect(verifyWebhookCallback).toHaveBeenCalledTimes(2);
    changes.push(change(1));
    await service.deliver();
    expect(sendSignedWebhook.mock.calls[0]![0]).toMatchObject({
      secret: newSecret,
      previousSecret: secret,
    });
    advance(5 * 60 * 1000);
    changes.push(change(2));
    await service.deliver();
    expect(sendSignedWebhook.mock.calls[1]![0]).not.toHaveProperty(
      "previousSecret",
    );
  });

  it("stops expired or revoked subscriptions and does not expose another owner's subscription", async () => {
    const {
      service,
      rows,
      changes,
      change,
      sendSignedWebhook,
      grantCheck,
      advance,
    } = setup();
    const { id } = await service.subscribe(principal, {
      ...params,
      ttlMs: 60_000,
    });
    const unsub = {
      name: params.name,
      arguments: params.arguments,
      delivery: { mode: "webhook", url: params.delivery.url },
    };
    await service.unsubscribe({ ...principal, ownerId: "other-owner" }, unsub);
    await service.unsubscribe(
      { ...principal, clientId: "other-client" },
      unsub,
    );
    expect(rows.get(id)?.status).toBe("active");
    changes.push(change(1));
    advance(60_000);
    await service.deliver();
    expect(sendSignedWebhook).not.toHaveBeenCalled();
    await service.subscribe(principal, params);
    changes.push(change(2));
    grantCheck.mockResolvedValue(false);
    await service.deliver();
    expect(rows.get(id)?.status).toBe("revoked");
    expect(sendSignedWebhook).not.toHaveBeenCalled();
  });

  it("preserves a racing unsubscribe and continues delivering other subscriptions", async () => {
    const { service, rows, changes, change, sendSignedWebhook } = setup();
    await service.subscribe(principal, params);
    await service.subscribe(principal, {
      ...params,
      delivery: {
        ...params.delivery,
        url: "https://callback.example.invalid/other",
      },
    });
    const ordered = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    const conflict = ordered[0]!;
    const unaffected = ordered[1]!;
    changes.push(change(1));
    sendSignedWebhook.mockImplementation(async (input) => {
      if (input.subscriptionId === conflict.id) {
        await service.unsubscribe(principal, {
          name: params.name,
          arguments: params.arguments,
          delivery: { mode: "webhook", url: input.url },
        });
      }
      return new Response(null, { status: 200 });
    });
    await expect(service.deliver()).resolves.toEqual({
      sent: 1,
      acknowledged: 1,
      failed: 0,
    });
    expect(rows.get(conflict.id)).toMatchObject({
      status: "inactive",
      cursor: 0,
    });
    expect(rows.get(unaffected.id)).toMatchObject({
      status: "active",
      cursor: 1,
    });
    expect(sendSignedWebhook).toHaveBeenCalledTimes(2);
  });

  it("renews from the current row when delivery advances it during callback verification", async () => {
    const { service, rows, changes, change, verifyWebhookCallback } = setup();
    const { id } = await service.subscribe(principal, params);
    changes.push(change(1));
    const newSecret = `whsec_${btoa("n".repeat(32))}`;
    verifyWebhookCallback.mockImplementationOnce(async () => {
      expect((await service.deliver()).sent).toBe(1);
    });
    await service.subscribe(principal, {
      ...params,
      delivery: { ...params.delivery, secret: newSecret },
    });
    expect(rows.get(id)).toMatchObject({
      status: "active",
      cursor: 1,
      secret: newSecret,
      previousSecret: secret,
    });
  });

  it("spends one query and no writes on an idle delivery pass", async () => {
    const { service, rows, grantCheck, sendSignedWebhook } = setup();
    const { id } = await service.subscribe(principal, params);
    const before = structuredClone(rows.get(id));
    grantCheck.mockClear();
    await expect(service.deliver()).resolves.toEqual({
      sent: 0,
      acknowledged: 0,
      failed: 0,
    });
    expect(grantCheck).not.toHaveBeenCalled();
    expect(sendSignedWebhook).not.toHaveBeenCalled();
    expect(rows.get(id)).toEqual(before);
  });

  it("keeps an unsubscribe that completes during renewal verification", async () => {
    const { service, rows, verifyWebhookCallback } = setup();
    const { id } = await service.subscribe(principal, params);
    verifyWebhookCallback.mockImplementationOnce(async () => {
      await service.unsubscribe(principal, {
        name: params.name,
        arguments: params.arguments,
        delivery: { mode: "webhook", url: params.delivery.url },
      });
    });
    await expect(
      service.subscribe(principal, {
        ...params,
        delivery: {
          ...params.delivery,
          secret: `whsec_${btoa("u".repeat(32))}`,
        },
      }),
    ).rejects.toMatchObject({ code: -32000 });
    expect(rows.get(id)).toMatchObject({ status: "inactive", secret });
  });

  it("reports a remaining renewal conflict with the public retry code and propagates other delivery errors", async () => {
    const { service, store, changes, change } = setup();
    await service.subscribe(principal, params);
    const save = vi.spyOn(store, "save").mockResolvedValueOnce(undefined);
    await expect(service.subscribe(principal, params)).rejects.toMatchObject({
      code: -32000,
    });
    save.mockRestore();
    changes.push(change(1));
    vi.spyOn(store, "latestEventId").mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(service.deliver()).rejects.toThrow("database unavailable");
  });

  it("moves quiet subscriptions behind other due work instead of starving the next batch", async () => {
    const { service, store, source, rows, changes, change, sendSignedWebhook } =
      setup();
    source.getConnection.mockImplementation(async (id: string) => ({
      id,
      provider: "synthetic-provider",
      displayName: "Synthetic",
      createdAt: "2040-01-01T00:00:00Z",
      latestRefresh: null,
    }));
    for (let index = 0; index < 26; index++) {
      await service.subscribe(principal, {
        ...params,
        arguments: { connectionId: `cal-${index}` },
      });
    }
    const target = [...rows.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .at(-1)!.connectionId;
    vi.spyOn(store, "latestEventId").mockImplementation(async (connectionId) =>
      connectionId === target ? (changes.at(-1)?.id ?? 0) : 0,
    );
    changes.push(change(1));
    await service.deliver();
    await service.deliver();
    expect(sendSignedWebhook).toHaveBeenCalledOnce();
  });

  it("resumes a failed unexpired subscription without discarding pending changes on refresh", async () => {
    const { service, rows, changes, change, sendSignedWebhook, advance } =
      setup();
    const { id } = await service.subscribe(principal, params);
    changes.push(change(1), change(2));
    sendSignedWebhook.mockResolvedValue(new Response(null, { status: 413 }));
    await service.deliver();
    expect(rows.get(id)).toMatchObject({ status: "failed", cursor: 0 });
    await service.subscribe(principal, params);
    expect(rows.get(id)).toMatchObject({
      status: "active",
      cursor: 0,
      attempts: 0,
    });
    sendSignedWebhook.mockImplementation(
      async () => new Response(null, { status: 200 }),
    );
    expect((await service.deliver()).sent).toBe(1);
    expect(rows.get(id)?.cursor).toBe(2);
    advance(24 * 60 * 60 * 1000);
    changes.push(change(3));
    await service.subscribe(principal, params);
    expect(rows.get(id)?.cursor).toBe(3);
  });
});
