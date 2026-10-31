import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApplication,
  inProcessInvoker,
  publicError,
} from "../../src/application/operations.js";
import type { ProviderCollector } from "../../src/domain/source-adapter.js";
import { calProvider } from "../../src/providers/cal/provider.js";
import { createIsracardProvider } from "../../src/providers/isracard/provider.js";
import {
  createRefreshService,
  ownerRefreshes,
} from "../../src/runtime/refresh-service.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { synthetic } from "../helpers/storage-harness.js";

describe("provider request estimates", () => {
  it("counts CAL's login, per-unit initialization, account and card-month requests", () => {
    const estimate = calProvider.estimateRequests!;
    expect(estimate({ windows: 3, cards: 2, accounts: 1 })).toBe(13);
    expect(estimate({ windows: 1, cards: 4, accounts: 2 })).toBe(8);
    // The recent window rereads each account once.
    expect(estimate({ windows: null, cards: 2, accounts: 1 })).toBe(3);
  });

  it("counts Isracard's login, card list, card-month and legacy requests", () => {
    const estimate = createIsracardProvider(() => {
      throw new Error("No requests in an estimate");
    }).estimateRequests!;
    expect(estimate({ windows: 3, cards: 2, accounts: 1 })).toBe(13);
    // A recent refresh reads the next and last billing months.
    expect(estimate({ windows: null, cards: 2, accounts: 1 })).toBe(8);
  });
});

describe("refresh estimate", () => {
  let db: Database;
  const collect = vi.fn<ProviderCollector["collect"]>();
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    collect.mockReset();
    for (const id of ["estimated", "undiscovered"]) {
      await db.ensureConnection({ id, provider: "cal" });
    }
    await db.recordCardDiscovery("estimated", {
      observedAt: "2040-07-02T12:00:00Z",
      cards: [
        {
          cardKey: "card-a",
          last4: "1111",
          billingAccount: { providerKey: "bank-1" },
        },
        {
          cardKey: "card-b",
          last4: "2222",
          billingAccount: { providerKey: "bank-1" },
        },
        { cardKey: "card-c", last4: "3333" },
      ],
    });
  });
  afterEach(() => db.close());

  function application() {
    const service = createRefreshService({
      store: db,
      targets: async () => ({
        targets: ["estimated", "undiscovered"].map((connectionId) => ({
          connectionId,
          adapter: synthetic,
          estimateRequests: calProvider.estimateRequests!,
          collector: async () => ({
            provider: "cal",
            collectorVersion: "synthetic-v1",
            collect,
          }),
        })),
        failures: 0,
      }),
      log: () => {},
      retryDelaysMs: [],
    });
    return inProcessInvoker(
      createApplication(db, { refreshes: ownerRefreshes(service, 0) }),
    );
  }

  it("estimates a backfill from the stored catalog without starting it", async () => {
    const operations = application();
    expect(
      await operations.invoke("refresh_connection", {
        connectionId: "estimated",
        from: "2040-01-15",
        to: "2040-04-02",
        estimate: true,
      }),
    ).toEqual({
      estimates: [
        {
          connectionId: "estimated",
          range: { from: "2040-01-15", to: "2040-04-02" },
          windows: 4,
          cards: 3,
          // 1 login + 4 × (1 initialization + 1 account + 3 card months).
          providerCalls: 21,
        },
      ],
    });
    expect(collect).not.toHaveBeenCalled();
    expect(await db.listRefreshes("estimated", { limit: 10 })).toEqual([]);
    expect((await db.getConnection("estimated"))?.latestRefresh).toBeNull();
  });

  it("estimates every connection, leaving unknown request counts null", async () => {
    expect(
      await application().invoke("refresh_connection", { estimate: true }),
    ).toEqual({
      estimates: [
        {
          connectionId: "estimated",
          range: null,
          windows: 1,
          cards: 3,
          providerCalls: 3,
        },
        {
          connectionId: "undiscovered",
          range: null,
          windows: 1,
          cards: 0,
          providerCalls: null,
        },
      ],
    });
    expect(collect).not.toHaveBeenCalled();
  });

  it("refuses an unknown connection and an invalid range", async () => {
    const operations = application();
    const missing = await operations
      .invoke("refresh_connection", { connectionId: "missing", estimate: true })
      .catch((error: unknown) => error);
    expect(publicError(missing).code).toBe("not_found");
    const invalid = await operations
      .invoke("refresh_connection", {
        connectionId: "estimated",
        from: "2040-04-01",
        to: "2040-01-01",
        estimate: true,
      })
      .catch((error: unknown) => error);
    expect(publicError(invalid).code).toBe("invalid_input");
  });
});
