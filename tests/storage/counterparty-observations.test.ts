import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { presentWireEvent } from "../../src/application/wire-output.js";
import {
  type JsonObject,
  type TransactionInput,
  transactionInputSchema,
} from "../../src/domain/model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
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

  function capture(input: TransactionInput, adapter = synthetic) {
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
      adapter,
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
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(await capture(absent())).toMatchObject({
        created: 0,
        updated: 0,
        unchanged: 1,
      });
      const retained = await current();
      expect(retained).toMatchObject({
        id: first.id,
        counterpartyName: "Invented recipient",
        version: first.version,
        annotation: { data: { notes: "Owner note" } },
      });
      expect(retained.sourceEvidence!.identity!.financialFingerprint).toBe(
        first.sourceEvidence!.identity!.financialFingerprint,
      );
    }
    expect(
      (await db.listEvents()).filter(
        (event) => event.type === "transaction.updated",
      ),
    ).toEqual(events.filter((event) => event.type === "transaction.updated"));
  });

  it.each([
    { amountMinor: -12000 },
    { originalAmountMinor: -3000, originalCurrency: "USD" },
    { fxFeeMinor: 125, fxFeeCurrency: "ILS" },
  ])(
    "does not retain other captured financial identity facts when a name is absent: %j",
    async (changed) => {
      await capture(transfer());
      const first = await current();
      const changedInput = absent({ ...transfer(), ...changed });
      expect(await capture(changedInput)).toMatchObject({
        created: 0,
        updated: 1,
      });
      const corrected = await current();
      expect(corrected).toMatchObject({
        ...changed,
        id: first.id,
        counterpartyName: "Invented recipient",
        version: first.version + 1,
      });
      expect(corrected.sourceEvidence!.identity!.financialFingerprint).not.toBe(
        first.sourceEvidence!.identity!.financialFingerprint,
      );
      const events = await db.listEvents();
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await capture(changedInput)).toMatchObject({
          created: 0,
          updated: 0,
          unchanged: 1,
        });
        expect(await current()).toMatchObject({
          id: first.id,
          version: corrected.version,
          sourceEvidence: {
            identity: {
              financialFingerprint:
                corrected.sourceEvidence!.identity!.financialFingerprint,
            },
          },
        });
        expect(await db.listEvents()).toEqual(events);
      }
    },
  );

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

  it("does not attribute a weak nameless observation using a transfer name and kind retained through incomplete evidence", async () => {
    const adapter: SourceAdapter = {
      ...synthetic,
      financialAuthority(input) {
        return input.kind === "unknown"
          ? {
              kind: "incomplete",
              reason: "missing_required_component",
              continuitySignature: "same-invented-component",
            }
          : {
              kind: "asserted",
              continuitySignature: "same-invented-component",
            };
      },
    };
    await capture(transfer(), adapter);
    const first = await current();
    const annotation = await db.editAnnotation({
      transactionId: first.id,
      expectedVersion: 0,
      notes: "Named native transfer owner note",
    });
    const incomplete = absent({
      ...transfer(),
      kind: "unknown",
      amountBasis: "unknown",
    });
    await capture(incomplete, adapter);
    expect(await db.getTransaction(first.id)).toMatchObject({
      kind: "transfer",
      counterpartyName: "Invented recipient",
      annotation,
    });
    await capture({ ...incomplete, identityStrength: "weak" }, adapter);
    const uncertain = (await db.listTransactions()).find(
      (item) => item.id !== first.id,
    );
    expect(uncertain).toMatchObject({
      kind: "unknown",
      counterpartyName: null,
      amountBasis: "unknown",
      identityStrength: "ambiguous",
      annotation: null,
    });
    expect(await db.getTransaction(first.id)).toMatchObject({
      kind: "transfer",
      counterpartyName: "Invented recipient",
      annotation,
    });
  });

  it.each(["missing", "unsupported"] as const)(
    "does not infer a retained legacy name's comparison when captured state is %s",
    async (comparison) => {
      await capture(transfer());
      const first = await current();
      const annotation = await db.editAnnotation({
        transactionId: first.id,
        expectedVersion: 0,
        notes: "Legacy native identity",
      });
      await db.raw(
        "UPDATE transaction_reconciliation SET source_evidence_json = ? WHERE transaction_id = ?",
        [
          JSON.stringify({
            financial: first.sourceEvidence!.financial,
            ...(comparison === "missing"
              ? {}
              : {
                  identity: {
                    ...first.sourceEvidence!.identity,
                    financialFingerprint: "unknown-comparison-format",
                  },
                }),
          }),
          first.id,
        ],
      );
      const events = await db.listEvents();
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await capture(absent())).toMatchObject({
          created: 0,
          updated: 0,
          unchanged: 1,
        });
        const retained = await current();
        expect(retained).toMatchObject({
          id: first.id,
          counterpartyName: "Invented recipient",
          version: first.version,
          annotation,
        });
        expect(retained.sourceEvidence?.identity).toBeUndefined();
        expect(await db.listEvents()).toEqual(events);
      }
      const weak = absent({ ...transfer(), identityStrength: "weak" });
      expect(await capture(weak)).toMatchObject({
        created: 0,
        updated: 1,
        unlisted: 0,
      });
      expect(await db.listTransactions()).toHaveLength(1);
      expect(await db.getTransaction(first.id)).toMatchObject({
        counterpartyName: "Invented recipient",
        amountMinor: first.amountMinor,
        identityStrength: "native",
        annotation,
        reviewRequired: true,
        sourceIssues: ["unverified_legacy_identity"],
      });
      expect(
        (await db.getTransaction(first.id))!.sourceEvidence?.identity,
      ).toBeUndefined();
      const reviewedEvents = await db.listEvents();
      expect(
        reviewedEvents.filter((event) => event.type === "transaction.created"),
      ).toEqual(events.filter((event) => event.type === "transaction.created"));
      const retained = await current();
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await capture(weak)).toMatchObject({
          created: 0,
          updated: 0,
          unlisted: 0,
        });
        expect(await current()).toEqual(retained);
        expect(await db.listEvents()).toEqual(reviewedEvents);
      }
      expect(
        await db.raw(
          "SELECT reason, first_seen_run_id, last_seen_run_id FROM deferred_evidence",
        ),
      ).toEqual([
        {
          reason: "unverified_legacy_identity",
          first_seen_run_id: "capture-04",
          last_seen_run_id: "capture-06",
        },
      ]);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await capture(absent())).toMatchObject({
          created: 0,
          updated: 0,
          unlisted: 0,
        });
        expect(await current()).toMatchObject({
          id: first.id,
          version: retained.version,
          counterpartyName: "Invented recipient",
          amountMinor: first.amountMinor,
          annotation,
          sourceIssues: ["unverified_legacy_identity"],
        });
        expect((await current()).sourceEvidence?.identity).toBeUndefined();
        expect(await db.listEvents()).toEqual(reviewedEvents);
      }
      const asserted = transfer(
        comparison === "missing" ? "Invented recipient" : null,
      );
      expect(await capture(asserted)).toMatchObject({
        created: 0,
        updated: 1,
        unlisted: 0,
      });
      const proved = await current();
      expect(proved).toMatchObject({
        id: first.id,
        counterpartyName: asserted.counterpartyName,
        amountMinor: first.amountMinor,
        annotation,
        sourceIssues: [],
        sourceEvidence: {
          identity: { runId: "capture-09", retiredFromMatching: false },
        },
      });
      const provedEvents = await db.listEvents();
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await capture(asserted)).toMatchObject({
          created: 0,
          updated: 0,
          unlisted: 0,
        });
        expect(await current()).toMatchObject({
          id: first.id,
          version: proved.version,
          annotation,
          sourceIssues: [],
        });
        expect(await db.listEvents()).toEqual(provedEvents);
      }
    },
  );
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

    async function capture(
      name?: string,
      options: {
        missingDigital?: boolean;
        detailState?: "invalid" | "unbound" | "ambiguous";
        transactionCode?: number;
        paymentSum?: number;
        historical?: boolean;
        day?: number;
      } = {},
    ) {
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
      digital.data.israelAbroadVouchers.vouchers.israelAbroadVouchersList[0]!.transactionCode =
        options.transactionCode ?? 20;
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
      if (options.paymentSum !== undefined) {
        legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!.txnIsrael[0]!.paymentSum =
          options.paymentSum;
      }
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
      if (options.detailState === "invalid") {
        source.responses.details![0]!.responseText = "{}";
      } else if (options.detailState === "unbound") {
        source.responses.details![0]!.responseText = JSON.stringify({
          Header: { Status: "1" },
          PirteyIska_204Bean: {
            ...detail(name!),
            voucherNumberRatz: "OTHER-INVENTED-VOUCHER",
          },
        });
      } else if (options.detailState === "ambiguous") {
        source.responses.details!.push(
          structuredClone(source.responses.details![0]!),
        );
      }
      if (options.missingDigital) {
        delete source.responses.digital;
      }
      if (options.historical) {
        source.mode = "history";
      }
      const responseText = serializeIsracardCapture(source);
      return db.ingestRun(
        {
          connectionId: "isracard-counterparty",
          runId: `isracard-detail-${++sequence}`,
          responses: [
            {
              ...isracardCaptureContext(responseText),
              capturedAt: `2040-08-${String(options.day ?? sequence).padStart(2, "0")}T00:00:00.000Z`,
              responseText,
            },
          ],
        },
        isracardAdapter,
      );
    }

    it("retains a transfer counterparty when missing Digital support restores its kind from retained money", async () => {
      await capture("Invented recipient");
      const first = (await db.listTransactions())[0]!;
      const annotation = await db.editAnnotation({
        transactionId: first.id,
        expectedVersion: 0,
        notes: "Preserve the transfer owner note",
      });
      await capture(undefined, { missingDigital: true });
      const retained = (await db.getTransaction(first.id))!;
      expect(retained).toMatchObject({
        kind: "transfer",
        counterpartyName: "Invented recipient",
        amountBasis: "purchase_commitment",
        amountMinor: -8640,
        currency: "ILS",
        annotation,
        sourceEvidence: { financial: first.sourceEvidence!.financial },
      });
      expect(retained.details.issues).toContain("retained_financial_evidence");
      expect(
        JSON.parse(retained.sourceEvidence!.identity!.financialFingerprint!),
      ).toMatchObject({
        kind: "unknown",
        amountBasis: "unknown",
        counterpartyName: "Invented recipient",
      });
      const cursor = await db.latestEventId();
      await capture(undefined, { missingDigital: true });
      expect(await db.getTransaction(first.id)).toMatchObject({
        version: retained.version,
        counterpartyName: "Invented recipient",
        annotation,
      });
      expect(
        (await db.listEvents({ after: cursor })).filter((event) =>
          event.type.startsWith("transaction."),
        ),
      ).toEqual([]);
    });

    it.each(["invalid", "unbound", "ambiguous"] as const)(
      "does not turn an %s optional detail into a counterparty clear when transfer support is retained",
      async (detailState) => {
        await capture("Invented recipient");
        const first = (await db.listTransactions())[0]!;
        await capture("Unusable invented recipient", {
          missingDigital: true,
          detailState,
        });
        expect(await db.getTransaction(first.id)).toMatchObject({
          kind: "transfer",
          counterpartyName: "Invented recipient",
          amountMinor: -8640,
          sourceEvidence: { financial: first.sourceEvidence!.financial },
        });
      },
    );

    it("accepts explicit bound name corrections and clears independently from retained transfer support", async () => {
      await capture("Invented recipient");
      const first = (await db.listTransactions())[0]!;
      await capture("Another invented recipient", { missingDigital: true });
      const corrected = (await db.getTransaction(first.id))!;
      expect(corrected).toMatchObject({
        kind: "transfer",
        counterpartyName: "Another invented recipient",
        amountMinor: -8640,
        sourceEvidence: { financial: first.sourceEvidence!.financial },
      });
      await capture("", { missingDigital: true });
      const cleared = (await db.getTransaction(first.id))!;
      expect(cleared).toMatchObject({
        kind: "transfer",
        counterpartyName: null,
        version: corrected.version + 1,
        amountMinor: -8640,
        sourceEvidence: { financial: first.sourceEvidence!.financial },
      });
      const cursor = await db.latestEventId();
      await capture(undefined, { missingDigital: true });
      expect(await db.getTransaction(first.id)).toMatchObject({
        counterpartyName: null,
        version: cleared.version,
      });
      expect(
        (await db.listEvents({ after: cursor })).filter((event) =>
          event.type.startsWith("transaction."),
        ),
      ).toEqual([]);
    });

    it.each([
      { missingDigital: true, paymentSum: 99 },
      { transactionCode: 999 },
    ])(
      "does not revive a counterparty through unsupported or contradictory money: %j",
      async (options) => {
        await capture("Invented recipient");
        const first = (await db.listTransactions())[0]!;
        await capture(undefined, options);
        expect(await db.getTransaction(first.id)).toMatchObject({
          kind: "unknown",
          counterpartyName: null,
          amountBasis: "unknown",
        });
        expect(
          (await db.getTransaction(first.id))!.sourceEvidence?.financial,
        ).toBeUndefined();
        await capture(undefined, { missingDigital: true });
        expect(await db.getTransaction(first.id)).toMatchObject({
          kind: "unknown",
          counterpartyName: null,
          amountBasis: "unknown",
        });
      },
    );

    it("does not turn historical transfer support into a current counterparty when Digital is missing", async () => {
      await capture("Historical invented recipient", {
        historical: true,
        day: 3,
      });
      const historical = (await db.listTransactions())[0]!;
      await capture(undefined, { missingDigital: true, day: 2 });
      expect(await db.getTransaction(historical.id)).toMatchObject({
        kind: "unknown",
        counterpartyName: null,
        amountBasis: "unknown",
        lastSeenAt: "2040-08-02T00:00:00.000Z",
      });
      expect(
        (await db.getTransaction(historical.id))!.sourceEvidence?.financial,
      ).toBeUndefined();
    });

    it("does not project a bound name through an explicitly unsupported Digital classification", async () => {
      await capture("Invented recipient");
      const first = (await db.listTransactions())[0]!;
      await capture("Another invented recipient", { transactionCode: 999 });
      expect(await db.getTransaction(first.id)).toMatchObject({
        kind: "unknown",
        counterpartyName: null,
        amountBasis: "unknown",
      });
    });

    it("does not infer a transfer or financial support from a bound party name alone", async () => {
      await capture("Invented unclassified party", { missingDigital: true });
      const unclassified = (await db.listTransactions())[0]!;
      expect(unclassified).toMatchObject({
        kind: "unknown",
        counterpartyName: "Invented unclassified party",
        amountBasis: "unknown",
      });
      expect(unclassified.sourceEvidence?.financial).toBeUndefined();
    });

    it("does not overwrite a current transfer counterparty with later historical evidence", async () => {
      await capture("Current invented recipient");
      const current = (await db.listTransactions())[0]!;
      await capture("Historical invented recipient", { historical: true });
      expect(await db.getTransaction(current.id)).toMatchObject({
        counterpartyName: "Current invented recipient",
        kind: "transfer",
        lastSeenAt: current.lastSeenAt,
        sourceEvidence: current.sourceEvidence,
      });
    });

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
