import { readFileSync } from "node:fs";

import { LosslessNumber, parse, stringify } from "lossless-json";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectFromStore,
  type CollectionEvent,
} from "../../../src/application/collection.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCaptureContext,
  isracardCaptureSchema,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import {
  type Database,
  openDatabase,
} from "../../../src/storage/sqlite/database.js";
import { syncRuns, transactions } from "../../../src/storage/sqlite/schema.js";

function baseline(): IsracardCapture {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/card-month.json", import.meta.url),
      "utf8",
    ),
  ) as IsracardCapture;
}

/** The same capture as returned by a new login session with its own GUIDs. */
function session(
  guid: string,
  listGuid: unknown = guid,
  capture = baseline(),
): IsracardCapture {
  const cardList = parse(capture.responses.cardList) as {
    data: { cardsList: Record<string, unknown>[] };
  };
  for (const card of cardList.data.cardsList) {
    card.cardGuid = listGuid;
  }
  return {
    ...capture,
    card: { ...capture.card, cardGuid: guid },
    responses: { ...capture.responses, cardList: stringify(cardList)! },
  };
}

describe("Isracard capture context", () => {
  it("keeps the actual request flag without changing old capture context", () => {
    const old = baseline();
    delete old.isNextBillingDate;
    const oldText = serializeIsracardCapture(old);
    expect(JSON.parse(oldText)).not.toHaveProperty("isNextBillingDate");
    const contexts = [false, true].map((isNextBillingDate) => {
      const text = serializeIsracardCapture({ ...old, isNextBillingDate });
      expect(JSON.parse(text).isNextBillingDate).toBe(isNextBillingDate);
      return isracardCaptureContext(text);
    });
    expect(contexts).toEqual([
      isracardCaptureContext(oldText),
      isracardCaptureContext(oldText),
    ]);
    for (const isNextBillingDate of [null, "Next", 1]) {
      expect(
        isracardCaptureSchema.safeParse({ ...old, isNextBillingDate }).success,
      ).toBe(false);
    }
  });
});

describe("Isracard identical repeat captures", () => {
  let db: Database;
  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await db.ensureConnection({ id: "synthetic", provider: "isracard" });
  });
  afterEach(() => db.close());

  const read = (capture: IsracardCapture): CollectionEvent => {
    const responseText = serializeIsracardCapture(capture);
    return {
      type: "capture",
      capture: {
        ...isracardCaptureContext(responseText),
        capturedAt: new Date().toISOString(),
        responseText,
      },
    };
  };
  const collect = (event: CollectionEvent) =>
    collectFromStore(
      db,
      { connectionId: "synthetic" },
      {
        provider: "isracard",
        collectorVersion: "synthetic-v1",
        async *collect() {
          yield event;
        },
      },
      isracardAdapter,
    );
  const runs = async () => (await db.orm.select().from(syncRuns).all()).length;

  it("records each session reread receipt without changing retained transaction content", async () => {
    expect((await collect(read(session("SESSION-1")))).created).toBeGreaterThan(
      0,
    );
    expect((await collect(read(session("SESSION-2")))).unchanged).toBe(1);
    const stored = await runs();
    const rowsBefore = await db.orm.select().from(transactions).all();
    const eventIdBefore = await db.latestEventId("synthetic");
    const summary = await collect(read(session("SESSION-3")));
    expect(summary).toMatchObject({
      status: "completed",
      captures: 1,
      unchanged: 1,
      created: 0,
      updated: 0,
    });
    expect(summary.runIds).toHaveLength(1);
    expect(await runs()).toBe(stored + 1);
    expect(await db.orm.select().from(transactions).all()).toEqual(rowsBefore);
    expect(await db.latestEventId("synthetic")).toBe(eventIdBefore);
  });

  it("records a receipt for a repeat whose card list no longer binds to its card", async () => {
    await collect(read(session("SESSION-1")));
    await collect(read(session("SESSION-2")));
    const stored = await runs();
    const rowsBefore = await db.orm.select().from(transactions).all();
    expect(await collect(read(session("SESSION-3", "OTHER")))).toMatchObject({
      status: "failed",
      unchanged: 0,
      created: 0,
      updated: 0,
    });
    expect(await db.orm.select().from(transactions).all()).toEqual(rowsBefore);
    expect(await runs()).toBe(stored + 1);
  });
  it.each([
    ["123", true],
    ["456", false],
  ] as const)(
    "checks numeric card-list GUID lexeme %s against the capture binding",
    async (guid, valid) => {
      const result = await collect(
        read(session("123", new LosslessNumber(guid))),
      );
      expect(result.status).toBe(valid ? "completed" : "failed");
      expect((await db.listTransactions()).length > 0).toBe(valid);
      expect(await runs()).toBe(1);
    },
  );
});
