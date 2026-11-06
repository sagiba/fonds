import { brotliDecompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import type { SyncDiagnostic } from "../../src/application/sync-diagnostics.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import { captureArchive } from "../../src/runtime/capture-archive.js";
import { runCapture } from "../../src/storage/capture-archive.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

const connectionId = "capture-source";
const adapter: SourceAdapter = {
  ...synthetic,
  volatileCaptureFields: ["sessionId", "inner.sessionId"],
  extract: (text, ...rest) =>
    synthetic.extract(
      JSON.stringify((JSON.parse(text) as { rows: unknown[] }).rows),
      ...rest,
    ),
};

interface ArchiveRow {
  id: string;
  kind: string;
  captured_at: string;
  body: Uint8Array | ArrayBuffer | null;
  expires_at: string;
}

const body = (stored: ArchiveRow) =>
  JSON.parse(
    brotliDecompressSync(Buffer.from(stored.body as Uint8Array)).toString(),
  ) as {
    schemaVersion: number;
    parserVersion: string;
    responses: { responseText: string; capturedAt: string }[];
  };

describe.each(backends)("%s capture archive", (backend) => {
  let db: Harness;
  let seq = 0;
  afterEach(() => db.close());

  async function start(
    options: Parameters<typeof open>[1] = captureArchive(30),
  ) {
    db = await open(backend, options);
    await db.ensureConnection({ id: connectionId, provider: "cal" });
  }

  const capture = (
    responseText: string,
    capturedAt = "2040-08-01T00:00:00.000Z",
    runId = `capture-${seq++}`,
    onDiagnostic?: (entry: SyncDiagnostic) => void,
  ) =>
    db.ingestRun(
      {
        connectionId,
        runId,
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:recent",
            capturedAt,
            responseText,
          },
        ],
      },
      adapter,
      onDiagnostic,
    );
  const archives = async () =>
    (await db.raw(
      "SELECT id,kind,captured_at,body,expires_at FROM capture_archives ORDER BY sequence",
    )) as unknown as ArchiveRow[];
  const bodies = async () => (await archives()).filter((item) => item.body);

  it("keeps nothing unless enabled", async () => {
    await start({});
    await capture(JSON.stringify({ rows: [] }));
    expect(await archives()).toEqual([]);
  });

  it("stores what the source sent, before parsing", async () => {
    await start();
    const text = '{ "rows": [],  "note": "spacing and order stay" }';
    await capture(text, "2040-08-01T01:02:03.000Z", "as-received");
    const [stored] = await archives();
    expect(stored).toMatchObject({ id: "as-received", kind: "run" });
    expect(body(stored!)).toMatchObject({
      schemaVersion: 1,
      parserVersion: adapter.parserVersion,
      responses: [
        { responseText: text, capturedAt: "2040-08-01T01:02:03.000Z" },
      ],
    });
  });

  it("keeps a capture the parser rejects", async () => {
    await start();
    await capture("<html>not the expected answer</html>").catch(
      () => undefined,
    );
    expect(body((await archives())[0]!).responses[0]!.responseText).toBe(
      "<html>not the expected answer</html>",
    );
  });

  it("records a repeat as a sighting without a second body", async () => {
    await start();
    await capture(
      JSON.stringify({ sessionId: "a", amount: 1, rows: [] }),
      "2040-08-01T00:00:00.000Z",
    );
    await capture(
      JSON.stringify({ rows: [], amount: 1, sessionId: "b" }),
      "2040-08-01T06:00:00.000Z",
    );
    const [first, repeat] = await archives();
    expect(first!.body).not.toBeNull();
    expect(repeat!.body).toBeNull();
  });

  it("sees through JSON nested in strings", async () => {
    await start();
    const nested = (sessionId: string) =>
      JSON.stringify({
        rows: [],
        inner: JSON.stringify({ sessionId, value: 1 }),
      });
    await capture(nested("a"));
    await capture(nested("b"));
    expect(await bodies()).toHaveLength(1);
  });

  it.each([
    ["a changed value", '{"rows":[],"a":1}', '{"rows":[],"a":2}'],
    ["a changed type", '{"rows":[],"a":1}', '{"rows":[],"a":"1"}'],
    ["a reordered list", '{"rows":[],"a":[1,2]}', '{"rows":[],"a":[2,1]}'],
    [
      "a number and its text",
      '{"rows":[],"a":1}',
      '{"rows":[],"a":"number:1"}',
    ],
    [
      "an object and a string holding it",
      '{"rows":[],"a":{"b":"c"}}',
      '{"rows":[],"a":"{\\"b\\":\\"c\\"}"}',
    ],
    [
      "a list and the tag of a string",
      '{"rows":[],"a":["string","b"]}',
      '{"rows":[],"a":"b"}',
    ],
    [
      "a volatile name at another path",
      '{"rows":[],"other":{"sessionId":"a"}}',
      '{"rows":[],"other":{"sessionId":"b"}}',
    ],
    [
      "long numbers that differ past double precision",
      '{"rows":[],"a":12345678901234567890}',
      '{"rows":[],"a":12345678901234567891}',
    ],
  ])("stores a new body for %s", async (_, first, second) => {
    await start();
    await capture(first);
    await capture(second);
    expect(await bodies()).toHaveLength(2);
  });

  it("returns to an earlier body when the source does", async () => {
    await start();
    await capture('{"rows":[],"a":1}', "2040-08-01T00:00:00.000Z");
    await capture('{"rows":[],"a":2}', "2040-08-02T00:00:00.000Z");
    await capture('{"rows":[],"a":1}', "2040-08-03T00:00:00.000Z");
    expect((await archives()).map((item) => item.body !== null)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("shares a body whatever deadline it already has", async () => {
    await start();
    await capture('{"rows":[]}');
    await db.raw("UPDATE capture_archives SET expires_at=?", [
      "2099-01-01T00:00:00.000Z",
    ]);
    await capture('{"rows":[]}');
    expect(await bodies()).toHaveLength(1);
  });

  it("keeps a body until its last repeat expires", async () => {
    await start();
    const past = "2000-01-01T00:00:00.000Z";
    await capture('{"rows":[],"a":1}', undefined, "holder");
    await db.raw("UPDATE capture_archives SET expires_at=?", [past]);
    await capture('{"rows":[],"a":1}', undefined, "repeat");
    await capture('{"rows":[],"a":2}', undefined, "other");
    expect((await archives()).map((item) => item.id)).toEqual([
      "holder",
      "repeat",
      "other",
    ]);
    await db.raw("UPDATE capture_archives SET expires_at=? WHERE id=?", [
      past,
      "repeat",
    ]);
    await capture('{"rows":[],"a":3}', undefined, "later");
    expect((await archives()).map((item) => item.id)).toEqual([
      "other",
      "later",
    ]);
  });

  it("drops an expired repeat while its body lives on", async () => {
    await start();
    const past = "2000-01-01T00:00:00.000Z";
    await capture('{"rows":[]}', undefined, "holder");
    await capture('{"rows":[]}', undefined, "repeat");
    await db.raw("UPDATE capture_archives SET expires_at=? WHERE id=?", [
      past,
      "repeat",
    ]);
    await capture('{"rows":[],"a":1}', undefined, "later");
    expect((await archives()).map((item) => item.id)).toEqual([
      "holder",
      "later",
    ]);
  });

  it("archives a staged run on recovery, once", async () => {
    let available = false;
    await start({
      captureArchive: {
        days: 30,
        compress: (text) => {
          if (!available) {
            throw new Error("synthetic archive failure");
          }

          return captureArchive(30).captureArchive!.compress(text);
        },
      },
    });
    const responseText = '{"rows":[]}';
    const run = {
      connectionId,
      runId: "interrupted",
      startedAt: "2040-08-01T00:00:00.000Z",
      responses: [
        {
          accountKey: "account",
          endpoint: "synthetic:recent",
          capturedAt: "2040-08-01T00:00:00.000Z",
          responseText,
        },
      ],
    };
    const refusing: SourceAdapter = {
      ...adapter,
      extract: () => {
        throw new Error("synthetic interruption");
      },
    };
    await db.ingestRun(run, refusing).catch(() => undefined);
    expect(await archives()).toEqual([]);
    available = true;
    await db.ingestRun(run, adapter);
    await db.ingestRun(run, adapter);
    const rows = await archives();
    expect(rows.map((item) => item.id)).toEqual(["interrupted"]);
    expect(body(rows[0]!).responses[0]!.responseText).toBe(responseText);
  });

  it("orders discoveries and runs as they happened", async () => {
    await start();
    await capture('{"rows":[],"a":1}', undefined, "before");
    await db.recordCardDiscovery(connectionId, {
      observedAt: "2030-01-01T00:00:00.000Z",
      cards: [{ cardKey: "card-1", last4: "1111" }],
    });
    await capture('{"rows":[],"a":2}', undefined, "after");
    expect((await archives()).map((item) => item.kind)).toEqual([
      "run",
      "card_discovery",
      "run",
    ]);
  });

  it("keeps a card discovery the schema refuses", async () => {
    await start();
    const card = { cardKey: "card-1", last4: "1111" };
    await expect(
      db.recordCardDiscovery(connectionId, {
        observedAt: "2040-08-01T00:00:00.000Z",
        cards: [card, card],
      }),
    ).rejects.toThrow();
    expect(await bodies()).toHaveLength(1);
  });

  it("stores repeats of a card discovery once", async () => {
    await start();
    const discovery = (observedAt: string, last4: string) => ({
      observedAt,
      cards: [{ cardKey: "card-1", last4 }],
    });
    await db.recordCardDiscovery(
      connectionId,
      discovery("2040-08-01T00:00:00.000Z", "1111"),
    );
    await db.recordCardDiscovery(
      connectionId,
      discovery("2040-08-02T00:00:00.000Z", "1111"),
    );
    await db.recordCardDiscovery(
      connectionId,
      discovery("2040-08-03T00:00:00.000Z", "2222"),
    );
    const rows = await archives();
    expect(rows.map((item) => item.kind)).toEqual(
      Array(3).fill("card_discovery"),
    );
    expect(rows.map((item) => item.body !== null)).toEqual([true, false, true]);
    expect(
      JSON.parse(
        brotliDecompressSync(
          Buffer.from(rows[2]!.body as Uint8Array),
        ).toString(),
      ),
    ).toMatchObject({ cards: [{ cardKey: "card-1", last4: "2222" }] });
  });

  it("never lets a failed archive stop the ledger", async () => {
    await start({
      captureArchive: {
        days: 30,
        compress: () => {
          throw new Error("synthetic archive failure");
        },
      },
    });
    const entries: SyncDiagnostic[] = [];
    await capture(
      JSON.stringify({ rows: [row("still-applied")] }),
      undefined,
      undefined,
      (entry) => entries.push(entry),
    );
    expect(await db.listTransactions({ connectionId })).toHaveLength(1);
    expect(await archives()).toEqual([]);
    expect(entries.map((entry) => entry.reason)).toContain(
      "capture_archive_failed",
    );
  });

  it("logs a stored capture's size and a repeat", async () => {
    await start();
    const entries: SyncDiagnostic[] = [];
    const log = (entry: SyncDiagnostic) => entries.push(entry);
    await capture('{"rows":[]}', undefined, undefined, log);
    await capture('{"rows":[]}', undefined, undefined, log);
    const stored = entries.find((entry) => entry.reason === "capture_archived");
    expect(stored?.counts?.archivedBytes).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.reason)).toContain("capture_repeated");
  });
});

describe("provider capture comparison", () => {
  const digest = async (provider: SourceAdapter, responseText: string) =>
    (
      await runCapture(
        {
          responses: [
            {
              accountKey: "account",
              endpoint: "recent",
              capturedAt: "2040-08-01T00:00:00.000Z",
              responseText,
            },
          ],
          failures: [],
        },
        provider,
      )
    ).digest;

  it("ignores CAL's per-request group ID and nothing else", async () => {
    const answer = (groupPid: string, amount: number) =>
      JSON.stringify({ groupPid, result: { transactions: [{ amount }] } });
    expect(await digest(calAdapter, answer("a", 1))).toBe(
      await digest(calAdapter, answer("b", 1)),
    );
    expect(await digest(calAdapter, answer("a", 1))).not.toBe(
      await digest(calAdapter, answer("a", 2)),
    );
  });

  it("ignores Isracard's per-login card GUID, even inside bundled responses", async () => {
    const answer = (cardGuid: string, amount: number) =>
      JSON.stringify({
        card: { cardGuid, cardSuffix: "0000" },
        responses: {
          cardList: JSON.stringify({ data: { cardsList: [{ cardGuid }] } }),
          legacy: JSON.stringify({ amount }),
        },
      });
    expect(await digest(isracardAdapter, answer("a", 1))).toBe(
      await digest(isracardAdapter, answer("b", 1)),
    );
    expect(await digest(isracardAdapter, answer("a", 1))).not.toBe(
      await digest(isracardAdapter, answer("a", 2)),
    );
  });
});
