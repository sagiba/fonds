import { afterEach, describe, expect, it, vi } from "vitest";

import { calProvider } from "../../src/providers/cal/provider.js";
import {
  collectionTargets,
  createLocalService,
  deliveryPass,
  writeDelivery,
} from "../../src/runtime/collection-service.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { row, synthetic } from "../helpers/storage-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps webhook request logs on the service's log, off a stdio server's stdout", async () => {
  const db = await openDatabase(":memory:");
  try {
    await db.ensureConnection({ id: "cal", provider: "cal" });
    const now = Date.now();
    await db.eventSubscriptions.save(
      {
        id: "sub-local",
        ownerId: "owner",
        clientId: "local",
        connectionId: "cal",
        // A .invalid name never resolves, so no request leaves the machine.
        url: "https://callback.synthetic.invalid/events",
        secret: `whsec_${btoa("s".repeat(32))}`,
        previousSecret: null,
        rotationUntil: null,
        verifiedUntil: now + 300_000,
        expiresAt: now + 86_400_000,
        status: "active",
        cursor: 0,
        pendingBatch: null,
        attempts: 0,
        nextAttemptAt: now,
        generation: 0,
        reason: null,
      },
      0,
    );
    await db.ingestRun(
      {
        runId: "synthetic-change",
        connectionId: "cal",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic",
            capturedAt: "2040-01-01T00:00:00Z",
            responseText: JSON.stringify([row("one")]),
          },
        ],
      },
      synthetic,
    );
    const log = vi.fn();
    const stdout = vi.spyOn(process.stdout, "write");
    const info = vi.spyOn(console, "info");
    const { events } = createLocalService(
      {
        store: db,
        credentials: db.credentials,
        eventSubscriptions: db.eventSubscriptions,
        credentialsKey: () => undefined,
      },
      { log, signal: new AbortController().signal },
    );
    expect(await events.deliver()).toMatchObject({ failed: 1 });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fonds_webhook_request", status: 0 }),
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

it("projects provider transport diagnostics and isolates failing log callbacks", async () => {
  for (const failing of [false, true]) {
    const log = vi.fn(() => {
      if (failing) {
        throw new Error("private-logger");
      }
    });
    const discover = collectionTargets({
      store: { listConnections: async () => [] },
      credentials: {
        getCredentials: async () => undefined,
        saveCredentials: async () => {},
        deleteCredentials: async () => false,
      },
      credentialsKey: () => undefined,
      configured: {
        connectionId: "private-connection",
        provider: "cal",
        credentials: { username: "private-user", password: "private-password" },
      },
      providerFor: () => ({
        ...calProvider,
        createCollector: (_credentials, options) => {
          options?.onDiagnostic?.({
            endpoint: "recent",
            httpStatus: 200,
            contentType: "json",
            outcome: "success",
            stage: "complete",
            responseText: "private-body",
            credentials: "private-password",
          });
          options?.onDiagnostic?.({
            endpoint: "https://private-endpoint",
            httpStatus: 200,
            contentType: "json",
            outcome: "success",
            stage: "complete",
          });
          return {
            provider: "cal",
            collectorVersion: "1",
            async *collect() {},
          };
        },
      }),
      log,
    });
    const { targets } = await discover();
    await expect(targets[0]!.collector()).resolves.toMatchObject({
      provider: "cal",
    });
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: "fonds_provider_transport",
      endpoint: "recent",
      httpStatus: 200,
      contentType: "json",
      outcome: "success",
      stage: "complete",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-");
  }
});

describe("delivery after owner writes", () => {
  const idle = { sent: 0, acknowledged: 0, failed: 0 };

  /** A pass held until released, recording how many run at once. */
  function heldPasses() {
    const releases: ((outcome: { sent: number }) => void)[] = [];
    let active = 0;
    let maxActive = 0;
    const pass = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await new Promise<{ sent: number }>((resolve) =>
          releases.push(resolve),
        );
      } finally {
        active--;
      }
    });
    const releaseNext = async (sent = 0) => {
      while (releases.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      releases.shift()!({ sent });
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    return { pass, releaseNext, maxActive: () => maxActive };
  }

  it("runs one pass at a time, and one more shared by writes during it", async () => {
    const { pass, releaseNext, maxActive } = heldPasses();
    const background = vi.fn<(work: Promise<unknown>) => void>();
    const writes = writeDelivery(pass, {
      signal: new AbortController().signal,
      background,
      log: vi.fn(),
    });
    writes.afterWrite();
    // The pass starts after the write returns.
    expect(pass).toHaveBeenCalledTimes(0);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(pass).toHaveBeenCalledTimes(1);
    // Concurrent writes commit while the first pass runs.
    writes.afterWrite();
    writes.afterWrite();
    expect(pass).toHaveBeenCalledTimes(1);
    const settled = background.mock.calls.map(([work]) => {
      const state = { done: false };
      void work.then(() => {
        state.done = true;
      });
      return state;
    });
    await releaseNext();
    // The first write's invocation ends with its pass; the others wait for theirs.
    expect(settled.map((state) => state.done)).toEqual([true, false, false]);
    await releaseNext();
    await writes.settled();
    expect(settled.map((state) => state.done)).toEqual([true, true, true]);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(maxActive()).toBe(1);
    // After settling, a later write starts a new pass.
    writes.afterWrite();
    await releaseNext();
    await writes.settled();
    expect(pass).toHaveBeenCalledTimes(3);
  });

  it("runs one more pass after a pass that sent, then stops", async () => {
    const pass = vi.fn(async () => ({ sent: 1 }));
    const writes = writeDelivery(pass, {
      signal: new AbortController().signal,
      log: vi.fn(),
    });
    writes.afterWrite();
    await writes.settled();
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("logs a failed pass without its error and keeps delivering later writes", async () => {
    const log = vi.fn();
    const pass = vi
      .fn<(signal: AbortSignal) => Promise<{ sent: number }>>()
      .mockRejectedValueOnce(new Error("private-receiver-detail"))
      .mockResolvedValue(idle);
    const writes = writeDelivery(pass, {
      signal: new AbortController().signal,
      log,
    });
    writes.afterWrite();
    await writes.settled();
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: "fonds_write_delivery",
      status: "failed",
    });
    writes.afterWrite();
    await writes.settled();
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it("starts nothing once the service shuts down and ends the pass in progress", async () => {
    const shutdown = new AbortController();
    const signals: AbortSignal[] = [];
    const pass = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ sent: number }>((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () => resolve({ sent: 1 }), {
            once: true,
          });
        }),
    );
    const background = vi.fn<(work: Promise<unknown>) => void>();
    const writes = writeDelivery(pass, {
      signal: shutdown.signal,
      background,
      log: vi.fn(),
    });
    writes.afterWrite();
    await new Promise((resolve) => setTimeout(resolve, 1));
    writes.afterWrite();
    shutdown.abort();
    await writes.settled();
    writes.afterWrite();
    await writes.settled();
    expect(pass).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(true);
    // Every write the service accepted still ends its invocation.
    expect(background).toHaveBeenCalledTimes(2);
    for (const [work] of background.mock.calls) {
      await expect(work).resolves.toBeUndefined();
    }
  });

  it("bounds each pass, by default at 30 seconds, and logs its outcome", async () => {
    const log = vi.fn();
    const deliver = vi.fn(
      async (input?: { signal?: AbortSignal }) =>
        new Promise<typeof idle>((resolve) =>
          input!.signal!.addEventListener(
            "abort",
            () => resolve({ ...idle, failed: 1 }),
            { once: true },
          ),
        ),
    );
    const started = performance.now();
    expect(
      await deliveryPass({ deliver }, log, 50)(new AbortController().signal),
    ).toEqual({ ...idle, failed: 1 });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
    expect(log).toHaveBeenCalledExactlyOnceWith({
      event: "fonds_event_delivery",
      ...idle,
      failed: 1,
    });

    const timeout = vi.spyOn(AbortSignal, "timeout");
    const quiet = vi.fn();
    await deliveryPass({ deliver: async () => idle }, quiet)(
      new AbortController().signal,
      true,
    );
    expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
    // A quiet pass that did nothing logs nothing.
    expect(quiet).not.toHaveBeenCalled();
  });
});
