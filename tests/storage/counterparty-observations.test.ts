import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { presentWireEvent } from "../../src/application/wire-output.js";
import {
  type JsonObject,
  type TransactionInput,
  transactionInputSchema,
} from "../../src/domain/model.js";
import { isracardAdapter } from "../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCaptureContext,
  serializeIsracardCapture,
} from "../../src/providers/isracard/capture.js";
import {
  backends,
  type Harness,
  open,
  row,
  synthetic,
} from "../helpers/storage-harness.js";

function transfer(name: string | null = "Invented recipient") {
  return row("transfer", { kind: "transfer", counterpartyName: name });
}

function absent(input = transfer()): TransactionInput {
  const { counterpartyName: _name, ...withoutName } = input;
  return withoutName;
}

it("keeps absent adapter counterparty evidence distinct from an explicit unknown", () => {
  expect(transactionInputSchema.parse(absent())).not.toHaveProperty(
    "counterpartyName",
  );
  expect(transactionInputSchema.parse(transfer(null))).toHaveProperty(
    "counterpartyName",
    null,
  );
});

describe.each(backends)("%s counterparty observations", (backend) => {
  let db: Harness;
  let captureNumber: number;
  beforeEach(async () => {
    db = await open(backend);
    await db.ensureConnection({
      id: "counterparty",
      provider: synthetic.provider,
    });
    captureNumber = 0;
  });
  afterEach(async () => db.close());

  function capture(input: TransactionInput) {
    const day = String(++captureNumber).padStart(2, "0");
    return db.ingestRun(
      {
        connectionId: "counterparty",
        runId: `capture-${day}`,
        responses: [
          {
            accountKey: "account",
            endpoint: "financial",
            capturedAt: `2040-07-${day}T00:00:00Z`,
            responseText: JSON.stringify([input]),
          },
        ],
      },
      synthetic,
    );
  }

  async function current() {
    return (await db.listTransactions())[0]!;
  }

  it("preserves a native transfer's name, version and annotation when optional evidence is absent", async () => {
    await capture(transfer());
    const first = await current();
    await db.editAnnotation({
      transactionId: first.id,
      expectedVersion: 0,
      notes: "Owner note",
    });
    const events = await db.listEvents();
    await capture(absent());
    expect(await current()).toMatchObject({
      id: first.id,
      counterpartyName: "Invented recipient",
      version: first.version,
      annotation: { data: { notes: "Owner note" } },
    });
    expect(
      (await db.listEvents()).filter(
        (event) => event.type === "transaction.updated",
      ),
    ).toEqual(events.filter((event) => event.type === "transaction.updated"));
  });

  it("applies a new explicit name and clears explicit unknown without losing owner annotations", async () => {
    await capture(transfer());
    const first = await current();
    await db.editAnnotation({
      transactionId: first.id,
      expectedVersion: 0,
      notes: "Owner note",
    });
    await capture(transfer("Another invented recipient"));
    expect(await current()).toMatchObject({
      id: first.id,
      counterpartyName: "Another invented recipient",
      version: first.version + 1,
    });
    await capture(transfer(null));
    expect(await current()).toMatchObject({
      id: first.id,
      counterpartyName: null,
      version: first.version + 2,
      annotation: { data: { notes: "Owner note" } },
    });
    await capture(absent());
    expect(await current()).toMatchObject({
      counterpartyName: null,
      version: first.version + 2,
    });
  });

  it("does not carry a transfer name through a different kind or borrow an older non-transfer name", async () => {
    await capture(transfer());
    await capture(absent(row("transfer", { kind: "purchase" })));
    expect(await current()).toMatchObject({
      kind: "purchase",
      counterpartyName: null,
      version: 2,
    });
    await capture(
      row("transfer", {
        kind: "purchase",
        counterpartyName: "Invented merchant-side label",
      }),
    );
    await capture(absent());
    expect(await current()).toMatchObject({
      kind: "transfer",
      counterpartyName: null,
      version: 4,
    });
  });

  it("stores unknown for an initially absent name and never inherits it across uncertain source identity", async () => {
    await capture(absent());
    expect(await current()).toMatchObject({
      counterpartyName: null,
      version: 1,
    });
    await capture(transfer());
    await capture(absent(transfer()));
    expect(await current()).toMatchObject({
      counterpartyName: "Invented recipient",
      version: 2,
    });
    const earlier = await current();
    await db.editAnnotation({
      transactionId: earlier.id,
      expectedVersion: 0,
      notes: "Earlier native identity",
    });
    await capture(absent({ ...transfer(), identityStrength: "weak" }));
    const uncertain = (await db.listTransactions()).find(
      (item) => item.id !== earlier.id,
    )!;
    expect(uncertain).toMatchObject({
      counterpartyName: null,
      identityStrength: "ambiguous",
      annotation: null,
    });
    expect(await db.getTransaction(earlier.id)).toMatchObject({
      counterpartyName: "Invented recipient",
      annotation: { data: { notes: "Earlier native identity" } },
    });
  });
});
describe.each(backends)(
  "%s bound Isracard counterparty evidence",
  (backend) => {
    let db: Harness;
    let sequence: number;
    beforeEach(async () => {
      db = await open(backend);
      await db.ensureConnection({
        id: "isracard-counterparty",
        provider: "isracard",
      });
      sequence = 0;
    });
    afterEach(async () => db.close());

    const detail = (name: string) => ({
      voucherNumberRatz: "VOUCHER-1",
      address: "42 Invented Street",
      phoneNumber: "SYNTHETIC-PHONE",
      motavName: name,
      transactionType: "Apple Pay",
      walletPayName: "Apple Pay",
      Table1: [
        {
          paymentNumber: "1",
          paymentDate: "10/07/2040",
          paymentSum: "86.40",
          currencyId: "ILS",
        },
      ],
    });

    async function capture(name?: string) {
      const source = JSON.parse(
        readFileSync(
          new URL(
            "../providers/isracard/fixtures/card-month.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as IsracardCapture;
      const digital = JSON.parse(source.responses.digital!) as {
        data: {
          israelAbroadVouchers: {
            vouchers: { israelAbroadVouchersList: JsonObject[] };
          };
        };
      };
      digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0]!.transactionCode = 20;
      source.responses.digital = JSON.stringify(digital);
      const legacy = JSON.parse(source.responses.legacy!) as {
        CardsTransactionsListBean: {
          Index0: { CurrentCardTransactions: { txnIsrael: JsonObject[] }[] };
        };
      };
      legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!.txnIsrael =
        legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!.txnIsrael.slice(
          0,
          1,
        );
      source.responses.legacy = JSON.stringify(legacy);
      if (name === undefined) {
        delete source.responses.details;
      } else {
        source.responses.details = [
          {
            voucherNumber: "VOUCHER-1",
            responseText: JSON.stringify({
              Header: { Status: "1" },
              PirteyIska_204Bean: {
                ...detail(name),
                arbitrary: { nestedNoise: "discard" },
              },
            }),
          },
        ];
      }
      const responseText = serializeIsracardCapture(source);
      return db.ingestRun(
        {
          connectionId: "isracard-counterparty",
          runId: `isracard-detail-${++sequence}`,
          responses: [
            {
              ...isracardCaptureContext(responseText),
              capturedAt: `2040-08-${String(sequence).padStart(2, "0")}T00:00:00.000Z`,
              responseText,
            },
          ],
        },
        isracardAdapter,
      );
    }

    it("retains bound detail fields through an unfetched detail and versions explicit name changes and empty clears", async () => {
      await capture("Invented recipient");
      const first = (await db.listTransactions())[0]!;
      expect(first).toMatchObject({
        kind: "transfer",
        amountMinor: -8640,
        currency: "ILS",
        counterpartyName: "Invented recipient",
        wallet: "apple_pay",
        details: {
          merchant: { address: "42 Invented Street", phone: "SYNTHETIC-PHONE" },
        },
      });
      expect(first.details.provider.isracard!.detail).toEqual(
        detail("Invented recipient"),
      );
      const annotation = await db.editAnnotation({
        transactionId: first.id,
        expectedVersion: 0,
        notes: "Preserve the transfer owner note",
      });
      const cursor = await db.latestEventId();
      expect(await capture()).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: 1,
      });
      expect(await db.getTransaction(first.id)).toMatchObject({
        id: first.id,
        counterpartyName: "Invented recipient",
        version: first.version,
        annotation,
        details: {
          provider: { isracard: { detail: detail("Invented recipient") } },
        },
      });
      expect(await db.listEvents({ after: cursor })).toEqual([]);

      expect(await capture("Another invented recipient")).toMatchObject({
        created: 0,
        updated: 1,
      });
      expect(await db.getTransaction(first.id)).toMatchObject({
        id: first.id,
        counterpartyName: "Another invented recipient",
        version: first.version + 1,
        annotation,
      });
      expect(await capture("")).toMatchObject({ created: 0, updated: 1 });
      expect(await db.getTransaction(first.id)).toMatchObject({
        id: first.id,
        counterpartyName: null,
        amountMinor: -8640,
        currency: "ILS",
        version: first.version + 2,
        annotation,
        details: { provider: { isracard: { detail: detail("") } } },
      });
      const updates = (await db.listEvents({ after: cursor })).filter(
        (event) => event.type === "transaction.updated",
      );
      expect(
        updates.map((event) => presentWireEvent(event).changedFields),
      ).toEqual([
        ["counterpartyName", "evidence"],
        ["counterpartyName", "evidence"],
      ]);
      expect(
        updates.map((event) => ({ before: event.before, after: event.after })),
      ).toMatchObject([
        {
          before: { counterpartyName: "Invented recipient" },
          after: {
            counterpartyName: "Another invented recipient",
            providerEvidence: expect.any(Array),
          },
        },
        {
          before: { counterpartyName: "Another invented recipient" },
          after: {
            counterpartyName: null,
            providerEvidence: expect.any(Array),
          },
        },
      ]);
      expect(await capture("")).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: 1,
      });
      expect(await capture()).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: 1,
      });
      expect(await db.getTransaction(first.id)).toMatchObject({
        counterpartyName: null,
        version: first.version + 2,
        annotation,
      });
      expect(await db.listTransactions()).toHaveLength(1);
    });
  },
);
