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
  isracardContentFingerprint,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import {
  type Database,
  openDatabase,
} from "../../../src/storage/sqlite/database.js";
import { syncRuns } from "../../../src/storage/sqlite/schema.js";

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

const fingerprint = (capture: IsracardCapture) =>
  isracardContentFingerprint(serializeIsracardCapture(capture));

describe("Isracard content fingerprint", () => {
  it("ignores the session GUIDs of an otherwise identical capture", () => {
    expect(fingerprint(session("SESSION-A"))).toBe(
      fingerprint(session("SESSION-B")),
    );
  });

  it("distinguishes a card list whose GUID no longer binds to the capture's card", () => {
    expect(fingerprint(session("SESSION-A", "OTHER"))).not.toBe(
      fingerprint(session("SESSION-A")),
    );
  });

  it("compares a numeric card-list GUID by its lexeme, as binding does", () => {
    const bound = fingerprint(session("123", new LosslessNumber("123")));
    expect(bound).toBe(fingerprint(session("SESSION-A")));
    expect(fingerprint(session("123", new LosslessNumber("456")))).not.toBe(
      bound,
    );
  });

  it("distinguishes any change to financial response text, month or card", () => {
    const capture = session("SESSION-A");
    const reference = fingerprint(capture);
    expect(
      fingerprint({
        ...capture,
        responses: {
          ...capture.responses,
          digital: `${capture.responses.digital!} `,
        },
      }),
    ).not.toBe(reference);
    expect(
      fingerprint({
        ...capture,
        responses: {
          ...capture.responses,
          legacy: `${capture.responses.legacy ?? ""} `,
        },
      }),
    ).not.toBe(reference);
    expect(
      fingerprint({
        ...capture,
        responses: {
          ...capture.responses,
          details: capture.responses.details!.map((detail) => ({
            ...detail,
            responseText: `${detail.responseText} `,
          })),
        },
      }),
    ).not.toBe(reference);
    expect(fingerprint({ ...capture, billingMonth: "2041-01" })).not.toBe(
      reference,
    );
    expect(
      fingerprint({
        ...capture,
        card: { ...capture.card, cardSuffix: "9999" },
      }),
    ).not.toBe(reference);
  });

  it("falls back to the exact text, tagged apart from any normalized capture", () => {
    expect(isracardContentFingerprint("not json")).toBe("raw:not json");
    const normalized = fingerprint(session("SESSION-A"));
    // A response whose text is itself a normalized fingerprint is no capture.
    expect(
      isracardContentFingerprint(normalized.slice("capture:".length)),
    ).not.toBe(normalized);
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
        // Only freshly fetched captures can be reused.
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

  it("skips a settled repeat from a new session without archiving it", async () => {
    expect((await collect(read(session("SESSION-1")))).created).toBeGreaterThan(
      0,
    );
    expect((await collect(read(session("SESSION-2")))).unchanged).toBe(0);
    const stored = await runs();
    expect(await collect(read(session("SESSION-3")))).toMatchObject({
      status: "completed",
      captures: 1,
      unchanged: 1,
      runIds: [],
    });
    expect(await runs()).toBe(stored);
  });

  it("archives a repeat whose card list no longer binds to its card", async () => {
    await collect(read(session("SESSION-1")));
    await collect(read(session("SESSION-2")));
    const stored = await runs();
    expect((await collect(read(session("SESSION-3", "OTHER")))).unchanged).toBe(
      0,
    );
    expect(await runs()).toBe(stored + 1);
  });
});
