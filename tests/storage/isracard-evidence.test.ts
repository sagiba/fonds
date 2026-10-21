import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { presentWireEvent } from "../../src/application/wire-output.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../src/providers/isracard/capture.js";
import { backends, type Harness, open } from "../helpers/storage-harness.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../providers/isracard/fixtures/card-month-approvals.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as IsracardCapture;
const approval = JSON.parse(fixture.responses.digital!).data.approvals
  .approvedTransactions[0];
const connectionId = "synthetic-evidence-retention";

function capture(fields: Record<string, unknown>): IsracardCapture {
  const card = { ...fixture.card, companyCode: "77" as const };
  return {
    schemaVersion: 1,
    provider: "isracard",
    mode: "recent",
    billingMonth: fixture.billingMonth,
    isNextBillingDate: true,
    card,
    responses: {
      cardList: JSON.stringify({
        isSuccess: true,
        data: { cardsList: [card] },
      }),
      digital: JSON.stringify({
        isSuccess: true,
        errorCode: "0",
        data: {
          approvals: {
            approvedTransactions: [{ ...approval, ...fields }],
            totalEstimatedAmount: 86.4,
          },
          israelAbroadVouchers: null,
          currentTransactionsList: null,
        },
      }),
    },
  };
}

describe.each(backends)("%s Isracard semantic evidence", (backend) => {
  let db: Harness;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({ id: connectionId, provider: "isracard" });
  });
  afterEach(async () => db?.close());

  function ingest(day: number, fields: Record<string, unknown>) {
    return ingestCapture(day, capture(fields));
  }

  function ingestCapture(day: number, source: IsracardCapture) {
    const accountKey = isracardCardKey(source.card);
    return db.ingestRun(
      {
        connectionId,
        runId: `synthetic-evidence-${day}`,
        responses: [
          {
            accountKey,
            endpoint: "isracard:card-month",
            capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00Z`,
            responseText: serializeIsracardCapture(source),
            scope: {
              kind: "recent",
              month: source.billingMonth,
              cardKey: accountKey,
            },
          },
        ],
      },
      isracardAdapter,
    );
  }

  it("retains bound detail descriptions without versioning UI labels or request metadata", async () => {
    const source = JSON.parse(
      readFileSync(
        new URL(
          "../providers/isracard/fixtures/card-month.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as IsracardCapture;
    const entry = source.responses.details![0]!;
    const setDetail = (revision: number, reason: string) => {
      entry.responseText = JSON.stringify({
        Header: { Status: "1" },
        PirteyIska_204Bean: {
          voucherNumberRatz: entry.voucherNumber,
          wayOfDeal: "Synthetic payment method",
          horaatKevaDesc: null,
          websiteName: "merchant.example",
          reasonOfTransaction: reason,
          sumOfCompensation: `Synthetic UI label ${revision}`,
          requestNumber: `request-${revision}`,
          tablePageNum: revision,
          info: `Synthetic holder context ${revision}`,
        },
      });
    };
    setDetail(1, "Synthetic reason");
    await ingestCapture(1, source);
    const original = (await db.listTransactions({ perspective: "all" })).find(
      (row) => row.details.provider.isracard?.detail,
    )!;
    expect(original.details.provider.isracard!.detail).toEqual({
      voucherNumberRatz: entry.voucherNumber,
      wayOfDeal: "Synthetic payment method",
      horaatKevaDesc: null,
      websiteName: "merchant.example",
      reasonOfTransaction: "Synthetic reason",
    });
    const stored = await db.raw("SELECT * FROM transactions WHERE id = ?", [
      original.id,
    ]);
    const cursor = await db.latestEventId();
    for (const day of [2, 3]) {
      setDetail(day, "Synthetic reason");
      expect(await ingestCapture(day, source)).toMatchObject({
        created: 0,
        updated: 0,
      });
      expect(
        await db.raw("SELECT * FROM transactions WHERE id = ?", [original.id]),
      ).toEqual(stored);
      expect(await db.listEvents({ after: cursor })).toEqual([]);
    }
    setDetail(4, "Corrected synthetic reason");
    expect(await ingestCapture(4, source)).toMatchObject({
      created: 0,
      updated: 1,
    });
    const corrected = (await db.getTransaction(original.id))!;
    expect(corrected.version).toBe(original.version + 1);
    expect(corrected.details.provider.isracard!.detail).toMatchObject({
      reasonOfTransaction: "Corrected synthetic reason",
    });
    const updates = (await db.listEvents({ after: cursor })).filter(
      (event) => event.type === "transaction.updated",
    );
    expect(updates).toHaveLength(1);
    expect(presentWireEvent(updates[0]!).changedFields).toEqual(["evidence"]);
  });

  it("persists semantic corrections once while excluded refresh noise never rewrites the row", async () => {
    const facts = {
      walletType: "SYNTHETIC-WALLET",
      walletTypeDescription: "Synthetic wallet label",
      securityIndicatorCode: "SYNTHETIC-SECURITY",
      securityIndicatorDescription: "Synthetic security label",
      tranzacCodeDescription: "Synthetic channel",
      branchCodeType: 42,
      clearedCode: "SYNTHETIC-ACQUIRER",
      clearedDescription: "Synthetic acquirer label",
      cityDescription: "Invented City",
      country: "SYNTHETIC-COUNTRY",
      countryCode: "ISR",
      countryDesc: "Synthetic country label",
      currencyName: "Synthetic currency label",
      creditFromBusiness: 2,
      creditOrCharge: 3,
      directDebit: 0,
    };
    const noise = (revision: number) => ({
      requestNumber: `request-${revision}`,
      refreshedAt: `2040-08-0${revision}T00:00:00Z`,
      tablePageNum: revision,
      extraDetails: { generatedAt: revision },
      newUnknownField: { revision },
      cardName: `Synthetic card display ${revision}`,
      cardSuffix: "9999",
    });
    await ingest(1, { ...facts, ...noise(1) });
    const original = (await db.listTransactions({ perspective: "all" }))[0]!;
    const annotation = await db.editAnnotation({
      transactionId: original.id,
      expectedVersion: 0,
      notes: "Synthetic owner note",
    });
    const cursor = await db.latestEventId();
    const stored = await db.raw("SELECT * FROM transactions WHERE id = ?", [
      original.id,
    ]);
    const provider = JSON.parse(String(stored[0]!.provider_json));
    expect(provider.isracard.rows).toEqual([
      expect.objectContaining({
        ...facts,
        branchCodeType: "42",
        creditFromBusiness: "2",
        creditOrCharge: "3",
        directDebit: "0",
      }),
    ]);
    for (const key of Object.keys(noise(1))) {
      expect(provider.isracard.rows[0]).not.toHaveProperty(key);
    }
    expect(original).toMatchObject({
      wallet: null,
      cardPresent: null,
      authorizationMethod: null,
    });
    expect(await db.raw("SELECT run_id FROM sync_run_bodies")).toEqual([]);

    for (const day of [2, 3]) {
      expect(await ingest(day, { ...facts, ...noise(day) })).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: 1,
      });
      expect(
        await db.raw("SELECT * FROM transactions WHERE id = ?", [original.id]),
      ).toEqual(stored);
      expect(await db.listEvents({ after: cursor })).toEqual([]);
    }

    const corrected = {
      ...facts,
      walletTypeDescription: "Corrected synthetic wallet label",
    };
    expect(await ingest(4, { ...corrected, ...noise(4) })).toMatchObject({
      created: 0,
      updated: 1,
    });
    const current = (await db.getTransaction(original.id))!;
    expect(current).toMatchObject({
      id: original.id,
      version: original.version + 1,
      annotation,
      wallet: null,
    });
    expect(current.details.provider.isracard!.rows).toEqual([
      expect.objectContaining({
        walletTypeDescription: corrected.walletTypeDescription,
      }),
    ]);
    const events = await db.listEvents({ after: cursor });
    expect(events).toHaveLength(1);
    expect(presentWireEvent(events[0]!)).toMatchObject({
      type: "transaction.updated",
      changedFields: ["evidence"],
    });
    expect(JSON.stringify(presentWireEvent(events[0]!))).not.toContain(
      corrected.walletTypeDescription,
    );
    const correctedStored = await db.raw(
      "SELECT * FROM transactions WHERE id = ?",
      [original.id],
    );
    for (const day of [5, 6]) {
      expect(await ingest(day, { ...corrected, ...noise(day) })).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: 1,
      });
      expect(
        await db.raw("SELECT * FROM transactions WHERE id = ?", [original.id]),
      ).toEqual(correctedStored);
      expect(await db.listEvents({ after: cursor })).toEqual(events);
    }
  });
});
