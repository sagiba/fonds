import { afterEach, expect, it, vi } from "vitest";

import { calProvider } from "../../src/providers/cal/provider.js";
import {
  collectionTargets,
  createLocalService,
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
