import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  type JsonObject,
  type JsonValue,
  parsedLedgerFacts,
  storedPaymentContext,
  transactionInputSchema,
} from "../../../src/domain/model.js";
import {
  currentSourceRowIndices,
  currentSourceRows,
  evidenceList,
} from "../../../src/domain/provider-evidence.js";
import { isracardAdapter } from "../../../src/providers/isracard/adapter.js";
import {
  type IsracardCapture,
  isracardCardKey,
  serializeIsracardCapture,
} from "../../../src/providers/isracard/capture.js";
import { mergeIsracardEvidence } from "../../../src/providers/isracard/evidence.js";
import { extractIsracard } from "../../../src/providers/isracard/extract.js";
import { compatibleIsracardPostingGroups } from "../../../src/providers/isracard/posting-evidence.js";
import { openDatabase } from "../../../src/storage/sqlite/database.js";

type Row = Record<string, unknown>;

function example() {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/card-month-approvals.json", import.meta.url),
      "utf8",
    ),
  ) as IsracardCapture;
}

function digital(capture: IsracardCapture) {
  return JSON.parse(capture.responses.digital!) as {
    isSuccess: boolean;
    errorCode?: unknown;
    data: Row;
  };
}

function change(
  capture: IsracardCapture,
  edit: (payload: ReturnType<typeof digital>) => void,
) {
  const payload = digital(capture);
  edit(payload);
  capture.responses.digital = JSON.stringify(payload);
}

function approval(): Row {
  return (digital(example()).data.approvals as { approvedTransactions: Row[] })
    .approvedTransactions[0]!;
}

function capture(
  options: { rows?: unknown[] | null; posted?: boolean; month?: string } = {},
) {
  const source = example();
  source.card.companyCode = "77";
  source.billingMonth = options.month ?? source.billingMonth;
  source.responses.cardList = JSON.stringify({
    isSuccess: true,
    data: { cardsList: [source.card] },
  });
  delete source.responses.legacy;
  delete source.responses.details;
  delete source.legacyCardIndex;
  change(source, (payload) => {
    payload.data.approvals =
      options.rows === null
        ? null
        : {
            approvedTransactions: options.rows ?? [approval()],
            totalEstimatedAmount: 86.4,
          };
    if (!options.posted) {
      payload.data.israelAbroadVouchers = null;
    }
  });
  return source;
}

function extract(source = capture()) {
  const accountKey = isracardCardKey(source.card);
  return extractIsracard(serializeIsracardCapture(source), {
    accountKey,
    runId: "synthetic-pending-run",
    scope: {
      kind: source.mode,
      month: source.billingMonth,
      cardKey: accountKey,
    },
  });
}

function facts(source: IsracardCapture) {
  return extract(source).transactions.map((row) => ({
    ...row,
    counterpartyName: row.counterpartyName ?? null,
    ...parsedLedgerFacts(row),
    ...storedPaymentContext(row, undefined),
    cardId: "synthetic-card",
    purchaseId: null,
  }));
}

async function ingest(
  db: Awaited<ReturnType<typeof openDatabase>>,
  source: IsracardCapture,
  index: number,
) {
  await db.ensureConnection({
    id: "synthetic-isracard-pending",
    provider: "isracard",
  });
  const accountKey = isracardCardKey(source.card);
  return db.ingestRun(
    {
      connectionId: "synthetic-isracard-pending",
      runId: `synthetic-pending-${index}`,
      responses: [
        {
          accountKey,
          endpoint: "isracard:card-month",
          capturedAt: `2040-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
          responseText: serializeIsracardCapture(source),
          scope: {
            kind: source.mode,
            month: source.billingMonth,
            cardKey: accountKey,
          },
        },
      ],
    },
    isracardAdapter,
  );
}

describe("Isracard authorization extraction", () => {
  it("projects same-row merchant location, named wallet and source descriptions without guessing accounting or security codes", () => {
    const [row] = facts(
      capture({
        rows: [
          {
            ...approval(),
            cityDescription: "Invented City",
            countryCode: "ISR",
            walletTypeDescription: "APPLE MC",
            tranzacCodeDescription: "אינטרנט",
            securityIndicatorCode: "V",
            transactionDescription: "Synthetic authorization description",
            transactionCode: 901,
            branchCodeType: 14,
            branchCodeDescription: "Synthetic category",
            isWalletTransaction: 0,
          },
        ],
      }),
    );
    expect(row).toMatchObject({
      kind: "unknown",
      amountBasis: "authorization",
      wallet: "apple_pay",
      cardPresent: false,
      authorizationMethod: "online",
      threeDSecureUsed: null,
      merchantCategoryCode: null,
      description: "Synthetic authorization description",
      providerTransactionCode: "901",
      details: { merchant: { city: "Invented City", countryCode: "ISR" } },
    });
  });

  it.each([
    "+99 555 5555",
    "https://merchant.example",
    "www.merchant.example",
    "contact@merchant.example",
    "SHOP.EXAMPLE.COM",
    "help.example.com",
    "shop.example.com/bill",
  ])(
    "keeps non-location pending city %s out of merchant fields",
    (cityDescription) => {
      const [row] = facts(
        capture({
          rows: [{ ...approval(), cityDescription, countryCode: "ZZZ" }],
        }),
      );
      expect(row!.details.merchant).toMatchObject({
        city: null,
        countryCode: null,
      });
      expect(row!.details.provider.isracard!.rows).toEqual([
        expect.objectContaining({ cityDescription, countryCode: "ZZZ" }),
      ]);
    },
  );

  it.each(["St. Louis", "St.Louis", "St.Jo"])(
    "keeps dotted place-name candidate %s",
    (cityDescription) => {
      expect(
        facts(capture({ rows: [{ ...approval(), cityDescription }] }))[0]!
          .details.merchant.city,
      ).toBe(cityDescription);
    },
  );

  it("uses the full opaque detail-address tuple, without confirmation display or purchase date, for native pending identity", () => {
    const source = capture();
    const result = extract(source);
    const row = result.transactions[0]!;
    expect(result.partitions).toEqual([
      expect.objectContaining({
        status: "pending",
        success: true,
        comparable: true,
      }),
      expect.objectContaining({
        status: "posted",
        success: true,
        comparable: false,
      }),
    ]);
    expect(row).toMatchObject({
      status: "pending",
      identityStrength: "native",
      kind: "unknown",
      amountBasis: "authorization",
      amountMinor: -8640,
      currency: "ILS",
      originalAmountMinor: null,
      originalCurrency: null,
      transactionDate: "2040-06-11",
      merchantName: "Synthetic merchant",
      installmentCount: null,
    });
    expect(row.sourceKey).toBe(
      `isracard:pending:${JSON.stringify([isracardCardKey(source.card), 17, "700000401", "20400611:123000:001"])}`,
    );
    expect(row.details.issues).toEqual(["source_derived_amount_direction"]);
    expect(row.details.sourceRefs).toEqual([
      {
        runId: "synthetic-pending-run",
        path: "$.responses.digital.data.approvals.approvedTransactions[0]",
      },
    ]);
    expect(row.details.provider.isracard?.rows).toEqual([
      expect.objectContaining({
        originalAmount: "86.4",
        confirmationNumber: "synthetic:approval:001",
        transactionCode: "901",
      }),
    ]);
    expect(transactionInputSchema.safeParse(row).success).toBe(true);
    const corrected = capture({
      rows: [
        {
          ...approval(),
          confirmationNumber: "DIFFERENT:DISPLAY",
          purchaseDate: "12/06/2040",
          originalAmount: 90,
        },
      ],
    });
    corrected.card.cardGuid = "NEW-SYNTHETIC-SESSION";
    corrected.responses.cardList = JSON.stringify({
      isSuccess: true,
      data: { cardsList: [corrected.card] },
    });
    expect(extract(corrected).transactions[0]!.sourceKey).toBe(row.sourceKey);
    for (const mutation of [
      { seqConfirmationNumber: "0700000401" },
      { confirmationTimeStamp: "different opaque timestamp" },
      { confirmationLocation: 18 },
    ]) {
      expect(
        extract(capture({ rows: [{ ...approval(), ...mutation }] }))
          .transactions[0]!.sourceKey,
      ).not.toBe(row.sourceKey);
    }
  });

  it.each([null, []])(
    "recognizes explicit empty Next authorization coverage %j",
    (rows) => {
      const result = extract(capture({ rows }));
      expect(result.transactions).toEqual([]);
      expect(result.partitions[0]).toMatchObject({
        status: "pending",
        success: true,
        comparable: true,
      });
    },
  );

  it.each([null, [approval()]])(
    "keeps a recognized unbilled summary independent of authorization coverage %j",
    (rows) => {
      const summaryCapture = JSON.parse(
        readFileSync(
          new URL(
            "./fixtures/card-month-pending-summary.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as IsracardCapture;
      const summary = digital(summaryCapture).data.currentTransactionsList;
      const source = capture({ rows });
      change(source, (payload) => {
        payload.data.currentTransactionsList = summary;
      });
      const result = extract(source);
      expect(result.partitions[0]).toMatchObject({
        status: "pending",
        success: true,
        comparable: true,
      });
      expect(
        result.transactions.filter((row) => row.status === "pending"),
      ).toHaveLength(rows === null ? 0 : 1);
      expect(result.warnings).not.toContain(
        "unsupported_approvals_preserved_raw",
      );
      expect(digital(source).data.currentTransactionsList).toEqual(summary);
    },
  );

  it.each([
    {},
    { currentTransactionsBillingMonth: [{}] },
    { unrecognizedSummary: [] },
  ])(
    "does not certify authorization coverage beside malformed summary %j",
    (summary) => {
      const source = capture();
      change(source, (payload) => {
        payload.data.currentTransactionsList = summary;
      });
      expect(extract(source).partitions[0]).toMatchObject({
        status: "pending",
        success: false,
        comparable: false,
      });
    },
  );

  it.each([undefined, false])(
    "preserves unproven approval requests raw when flag=%s",
    (flag) => {
      const source = capture();
      if (flag === undefined) {
        delete source.isNextBillingDate;
      } else {
        source.isNextBillingDate = flag;
      }
      const raw = source.responses.digital;
      const result = extract(source);
      expect(result.transactions).toEqual([]);
      expect(result.partitions[0]).toMatchObject({
        status: "pending",
        success: false,
        comparable: false,
      });
      expect(source.responses.digital).toBe(raw);
    },
  );

  it("never treats historical approvals as a current snapshot", () => {
    const source = capture();
    source.mode = "history";
    const result = extract(source);
    expect(result.historical).toBe(true);
    expect(result.transactions).toEqual([]);
    expect(result.partitions[0]).toMatchObject({
      status: "pending",
      success: false,
      comparable: false,
    });
  });

  it.each([
    (data: Row) => {
      delete data.approvals;
    },
    (data: Row) => {
      data.approvals = {
        approvedTransactions: [],
        totalEstimatedAmount: 0,
        unknownContinuation: "synthetic",
      };
    },
    (data: Row) => {
      data.approvals = { approvedTransactions: [], totalEstimatedAmount: null };
    },
    (data: Row) => {
      data.approvals = { approvedTransactions: null, totalEstimatedAmount: 0 };
    },
    (data: Row) => {
      data.unrecognizedPartition = [];
    },
  ])(
    "does not certify absent, malformed or unknown approval coverage",
    (edit) => {
      const source = capture();
      change(source, (payload) => edit(payload.data));
      expect(extract(source).partitions[0]).toMatchObject({
        status: "pending",
        success: false,
        comparable: false,
      });
    },
  );

  it("keeps colliding and incomplete tuples as ambiguous blockers, retaining every occurrence and known money", () => {
    for (const rows of [
      [approval(), approval()],
      [approval(), { ...approval(), confirmationTimeStamp: null }],
      [approval(), null],
    ]) {
      const result = extract(capture({ rows }));
      expect(result.partitions[0]).toMatchObject({
        success: false,
        comparable: false,
      });
      expect(result.transactions).toHaveLength(
        rows.filter((value) => value !== null).length,
      );
      const invalid = result.transactions.find(
        (row) => row.identityStrength === "ambiguous",
      );
      if (rows[1] !== null) {
        expect(invalid).toMatchObject({
          amountMinor: -8640,
          currency: "ILS",
          transactionDate: "2040-06-11",
        });
      }
      if (
        rows[0] === rows[1] ||
        JSON.stringify(rows[0]) === JSON.stringify(rows[1])
      ) {
        expect(
          result.transactions.every(
            (row) => row.identityStrength === "ambiguous",
          ),
        ).toBe(true);
        expect(
          result.transactions.map(
            (row) => row.details.provider.isracard?.identity,
          ),
        ).toEqual([
          expect.objectContaining({ occurrenceCount: 2 }),
          expect.objectContaining({ occurrenceCount: 2 }),
        ]);
      }
    }
  });

  it.each([
    [12.34, -1234],
    [-12.34, 1234],
    [0, 0],
  ])(
    "retains signed exact authorization %s without inventing kind",
    (amount, expected) => {
      const row = extract(
        capture({
          rows: [
            {
              ...approval(),
              originalAmount: amount,
              currencyIso: "USD",
              ilsBillingAmount: 500,
            },
          ],
        }),
      ).transactions[0]!;
      expect(row).toMatchObject({
        kind: "unknown",
        amountBasis: "authorization",
        amountMinor: expected,
        currency: "USD",
      });
    },
  );

  it.each([
    { originalAmount: "12.34" },
    { originalAmount: 1.001 },
    { currencyIso: "ZZZ" },
    { currencyIso: null },
    { purchaseDate: "31/02/2040" },
  ])(
    "retains unsupported row evidence without comparable coverage: %j",
    (mutation) => {
      const result = extract(
        capture({ rows: [{ ...approval(), ...mutation }] }),
      );
      expect(result.transactions).toHaveLength(1);
      expect(result.partitions[0]).toMatchObject({
        success: false,
        comparable: false,
      });
    },
  );

  it.each(["1.23000000000000001", "9007199254740993"])(
    "does not round authorization JSON lexeme %s",
    (lexeme) => {
      const source = capture();
      source.responses.digital = source.responses.digital!.replace(
        '"originalAmount":86.4',
        `"originalAmount":${lexeme}`,
      );
      const result = extract(source);
      expect(result.transactions[0]).toMatchObject({
        amountMinor: null,
        currency: null,
        details: {
          provider: { isracard: { rows: [{ originalAmount: lexeme }] } },
        },
      });
      expect(result.partitions[0]).toMatchObject({
        success: false,
        comparable: false,
      });
    },
  );
});

describe("Isracard singleton posting admission", () => {
  it("keeps legacy digital-looking noise from changing the proved digital merchant", () => {
    const source = example();
    change(source, (payload) => {
      (
        payload.data.approvals as { approvedTransactions: unknown[] }
      ).approvedTransactions = [approval()];
    });
    const legacy = JSON.parse(source.responses.legacy!) as {
      CardsTransactionsListBean: {
        Index0: { CurrentCardTransactions: { txnIsrael: Row[] }[] };
      };
    };
    Object.assign(
      legacy.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!
        .txnIsrael[0]!,
      {
        businessName: "Forged legacy merchant",
        transactionCode: 1,
        seqVoucherNumber: "FORGED-LEGACY-VOUCHER",
        currencyIso: "USD",
      },
    );
    source.responses.legacy = JSON.stringify(legacy);
    const rows = facts(source);
    const pending = rows.filter((row) => row.status === "pending");
    const posted = rows.filter(
      (row) => row.status === "posted" && row.kind === "purchase",
    );
    expect(compatibleIsracardPostingGroups(pending, posted)).toBe(true);
    expect(JSON.stringify(posted[0]!.details.provider.isracard)).not.toContain(
      "Forged legacy merchant",
    );
  });
  it("uses current complete statements after retaining partial approval and voucher evidence", () => {
    const source = facts(capture({ posted: true }));
    const approval = source.find((row) => row.status === "pending")!;
    const purchase = source.find((row) => row.status === "posted")!;
    const withHistory = (row: typeof approval) => {
      const namespace = row.details.provider.isracard!;
      const current = currentSourceRows(namespace);
      const { businessName: _omitted, ...partial } = current[0] as JsonObject;
      const merged = mergeIsracardEvidence({ rows: [partial] }, namespace);
      const rows = evidenceList(merged.rows);
      return {
        row: {
          ...row,
          details: {
            ...row.details,
            provider: {
              isracard: {
                ...namespace,
                ...merged,
                identity: {
                  ...((namespace.identity as JsonObject) ?? {}),
                  currentRows: currentSourceRowIndices(rows, current),
                },
              },
            },
          },
        },
        rows,
        partial,
      };
    };
    const pending = withHistory(approval);
    const posted = withHistory(purchase);
    expect(pending.rows).toHaveLength(2);
    expect(posted.rows).toHaveLength(2);
    expect(compatibleIsracardPostingGroups([pending.row], [posted.row])).toBe(
      true,
    );
    const partialPending = {
      ...pending.row,
      details: {
        ...pending.row.details,
        provider: {
          isracard: {
            ...pending.row.details.provider.isracard,
            identity: {
              currentRows: currentSourceRowIndices(pending.rows, [
                pending.partial,
              ]),
            },
          },
        },
      },
    };
    const partialPosted = {
      ...posted.row,
      details: {
        ...posted.row.details,
        provider: {
          isracard: {
            ...posted.row.details.provider.isracard,
            identity: {
              currentRows: currentSourceRowIndices(posted.rows, [
                posted.partial,
              ]),
            },
          },
        },
      },
    };
    expect(
      compatibleIsracardPostingGroups([partialPending], [posted.row]),
    ).toBe(false);
    expect(
      compatibleIsracardPostingGroups([pending.row], [partialPosted]),
    ).toBe(false);
  });

  it("requires digital source origins even when legacy rows carry digital-looking fields", () => {
    const source = facts(capture({ posted: true }));
    const pending = source.filter((row) => row.status === "pending");
    const purchase = source.find((row) => row.status === "posted")!;
    const namespace = purchase.details.provider.isracard!;
    const row = currentSourceRows(namespace)[0]!;
    const change = (rows: JsonValue[], generations: string[]) => ({
      ...purchase,
      details: {
        ...purchase.details,
        provider: {
          isracard: {
            ...namespace,
            rows,
            observations: generations.map((generation) => ({
              generation,
              path: "synthetic-source-origin",
            })),
          },
        },
      },
    });
    expect(
      compatibleIsracardPostingGroups(pending, [change([row], ["legacy"])]),
    ).toBe(false);
    expect(
      compatibleIsracardPostingGroups(pending, [
        change([row, row], ["digital", "legacy"]),
      ]),
    ).toBe(false);
    expect(
      compatibleIsracardPostingGroups(pending, [
        change([{}, row], ["digital", "legacy"]),
      ]),
    ).toBe(false);
    expect(
      compatibleIsracardPostingGroups(pending, [
        change(
          [{ ...(row as JsonObject), seqVoucherNumber: {} }, row],
          ["digital", "legacy"],
        ),
      ]),
    ).toBe(false);
    expect(compatibleIsracardPostingGroups(pending, [change([row], [])])).toBe(
      false,
    );
    expect(
      compatibleIsracardPostingGroups(pending, [
        change([row], ["unrecognized"]),
      ]),
    ).toBe(false);
  });
  it("admits a source-proven unknown authorization and verified purchase only by exact normalized merchant", () => {
    const source = capture({ posted: true });
    const rows = facts(source);
    const pending = rows.filter((row) => row.status === "pending");
    const posted = rows.filter((row) => row.status === "posted");
    expect(compatibleIsracardPostingGroups(pending, posted)).toBe(true);
    const spaced = capture({
      rows: [{ ...approval(), businessName: "  Synthetic\u00a0merchant " }],
      posted: true,
    });
    expect(
      compatibleIsracardPostingGroups(
        facts(spaced).filter((row) => row.status === "pending"),
        posted,
      ),
    ).toBe(true);
    for (const name of [
      "synthetic merchant",
      "Synthetic merchant suffix",
      "Synthetic-merchant",
    ]) {
      expect(
        compatibleIsracardPostingGroups(
          facts(capture({ rows: [{ ...approval(), businessName: name }] })),
          posted,
        ),
      ).toBe(false);
    }
    expect(
      compatibleIsracardPostingGroups([...pending, ...pending], posted),
    ).toBe(false);
    for (const issue of [
      "unsupported_transaction_type",
      "unverified_amount_basis",
      "invalid_source_date",
    ]) {
      expect(
        compatibleIsracardPostingGroups(
          [
            {
              ...pending[0]!,
              details: { ...pending[0]!.details, issues: [issue] },
            },
          ],
          posted,
        ),
      ).toBe(false);
    }
    expect(
      compatibleIsracardPostingGroups(
        [{ ...pending[0]!, details: { ...pending[0]!.details, provider: {} } }],
        posted,
      ),
    ).toBe(false);
    expect(
      compatibleIsracardPostingGroups(pending, [
        { ...posted[0]!, kind: "unknown" },
      ]),
    ).toBe(false);
    // Retained source evidence owns attribution; sticky canonical display
    // enrichment cannot create or erase a source match.
    expect(
      compatibleIsracardPostingGroups(
        [{ ...pending[0]!, merchantName: "Sticky pending display" }],
        [{ ...posted[0]!, merchantName: "Sticky posted display" }],
      ),
    ).toBe(true);
    const otherRaw = facts(
      capture({
        rows: [{ ...approval(), businessName: "Different source merchant" }],
      }),
    );
    expect(
      compatibleIsracardPostingGroups(
        [{ ...otherRaw[0]!, merchantName: posted[0]!.merchantName }],
        posted,
      ),
    ).toBe(false);
  });
});

describe("Isracard pending lifecycle through storage", () => {
  it("continues an overlapped legacy posting only after the same native identity gains verified DigitalV3 evidence", async () => {
    const domestic = (pending: boolean, legacy: boolean, posted: boolean) => {
      const source = example();
      delete source.responses.details;
      change(source, (payload) => {
        payload.data.approvals = pending
          ? { approvedTransactions: [approval()], totalEstimatedAmount: 86.4 }
          : null;
        if (!posted) {
          payload.data.israelAbroadVouchers = null;
        }
      });
      const statement = JSON.parse(source.responses.legacy!) as {
        CardsTransactionsListBean: {
          Index0: { CurrentCardTransactions: { txnIsrael: Row[] }[] };
        };
      };
      const transactions =
        statement.CardsTransactionsListBean.Index0.CurrentCardTransactions[0]!;
      transactions.txnIsrael = legacy
        ? [
            {
              ...transactions.txnIsrael[0]!,
              fullSupplierNameHeb: "Synthetic merchant",
            },
          ]
        : [];
      source.responses.legacy = JSON.stringify(statement);
      return source;
    };
    const db = await openDatabase(":memory:");
    try {
      await ingest(db, domestic(true, false, false), 0);
      const pending = (await db.listTransactions({ status: "pending" }))[0]!;
      await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        notes: "Synthetic delayed purchase note",
      });
      await ingest(db, domestic(true, true, false), 1);
      const posted = (await db.listTransactions({ status: "posted" }))[0]!;
      expect(posted).toMatchObject({
        identityStrength: "native",
        kind: "unknown",
        amountBasis: "unknown",
        amountMinor: -8640,
        currency: "ILS",
      });
      const witness = (await db.getTransaction(pending.id))!.details
        .postingOverlap;
      expect(witness).toMatchObject({
        postedId: posted.id,
        runId: "synthetic-pending-1",
      });
      await ingest(db, domestic(false, true, false), 2);
      expect(await db.getTransaction(pending.id)).toMatchObject({
        status: "pending",
        presence: "not_returned",
        details: { postingOverlap: witness },
        annotation: { data: { notes: "Synthetic delayed purchase note" } },
      });
      expect((await db.getTransaction(posted.id))!.details.postingLink).toBe(
        undefined,
      );

      const enriched = domestic(false, true, true);
      expect(extract(enriched).transactions).toEqual([
        expect.objectContaining({
          sourceKey: posted.sourceKey,
          identityStrength: "native",
          kind: "purchase",
          amountBasis: "purchase_commitment",
        }),
      ]);
      await ingest(db, enriched, 3);
      const survivor = (await db.getTransaction(pending.id))!;
      expect(survivor).toMatchObject({
        id: pending.id,
        status: "posted",
        kind: "purchase",
        amountBasis: "purchase_commitment",
        amountMinor: -8640,
        currency: "ILS",
        annotation: { data: { notes: "Synthetic delayed purchase note" } },
        details: {
          postingLink: {
            automatic: true,
            postedId: posted.id,
            evidence: { overlap: witness },
          },
        },
      });
      expect(await db.getTransaction(posted.id)).toMatchObject({
        supersededById: pending.id,
        annotation: null,
      });
      expect(
        (await db.listTransactions()).filter((row) => !row.supersededById),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it.each(["collision", "missing_identity"] as const)(
    "keeps annotated %s evidence attached when identical financial facts reverse source order",
    async (scenario) => {
      const db = await openDatabase(":memory:");
      try {
        const aRow = {
          ...approval(),
          ...(scenario === "missing_identity"
            ? { confirmationTimeStamp: null }
            : {}),
          confirmationNumber: "INVENTED-A",
        };
        const bRow = { ...aRow, confirmationNumber: "INVENTED-B" };
        await ingest(db, capture({ rows: [aRow, bRow] }), 0);
        const a = (await db.listTransactions({ status: "pending" })).find(
          (row) => row.sourceKey.endsWith(":occurrence:1"),
        )!;
        await db.editAnnotation({
          transactionId: a.id,
          expectedVersion: 0,
          notes: "Synthetic collision note",
        });
        await ingest(db, capture({ rows: [bRow, aRow] }), 1);
        const retained = (await db.getTransaction(a.id))!;
        expect(retained.annotation).toMatchObject({
          data: { notes: "Synthetic collision note" },
        });
        expect(retained.details.provider.isracard?.rows).toEqual([
          expect.objectContaining({ confirmationNumber: "INVENTED-A" }),
        ]);
        expect(await db.listTransactions({ status: "pending" })).toHaveLength(
          2,
        );
      } finally {
        db.close();
      }
    },
  );

  it("does not transfer annotations when same-date identityless authorizations reverse order", async () => {
    const db = await openDatabase(":memory:");
    try {
      const aRow = {
        ...approval(),
        confirmationTimeStamp: null,
        businessName: "First synthetic authorization",
        originalAmount: 50,
      };
      const bRow = {
        ...approval(),
        confirmationTimeStamp: null,
        businessName: "Second synthetic authorization",
        originalAmount: 60,
      };
      await ingest(db, capture({ rows: [aRow, bRow] }), 0);
      const initial = await db.listTransactions({ status: "pending" });
      const a = initial.find(
        (row) => row.merchantName === "First synthetic authorization",
      )!;
      const b = initial.find(
        (row) => row.merchantName === "Second synthetic authorization",
      )!;
      await db.editAnnotation({
        transactionId: a.id,
        expectedVersion: 0,
        notes: "Synthetic identityless note",
      });
      await ingest(db, capture({ rows: [bRow, aRow] }), 1);
      expect(await db.getTransaction(a.id)).toMatchObject({
        identityStrength: "ambiguous",
        merchantName: "First synthetic authorization",
        amountMinor: -5000,
        annotation: { data: { notes: "Synthetic identityless note" } },
      });
      expect(await db.getTransaction(b.id)).toMatchObject({
        identityStrength: "ambiguous",
        merchantName: "Second synthetic authorization",
        amountMinor: -6000,
        annotation: null,
      });
      expect(await db.listTransactions({ status: "pending" })).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("keeps annotations on full tuple identities through overlapping, reordered authorizations sharing a display confirmation", async () => {
    const db = await openDatabase(":memory:");
    try {
      const first = approval();
      const second = {
        ...first,
        confirmationLocation: 23,
        seqConfirmationNumber: "SYNTHETIC-OTHER-SEQUENCE",
        confirmationTimeStamp: "different opaque timestamp",
      };
      await ingest(db, capture({ rows: [first] }), 0);
      const a = (await db.listTransactions({ status: "pending" }))[0]!;
      await db.editAnnotation({
        transactionId: a.id,
        expectedVersion: 0,
        notes: "Synthetic first authorization note",
      });
      const overlapping = capture({ rows: [second, first] });
      expect(extract(overlapping).partitions[0]).toMatchObject({
        status: "pending",
        success: true,
        comparable: true,
      });
      expect(
        extract(overlapping).transactions.every(
          (row) => row.identityStrength === "native",
        ),
      ).toBe(true);
      await ingest(db, overlapping, 1);
      const both = await db.listTransactions({ status: "pending" });
      expect(both).toHaveLength(2);
      const b = both.find((row) => row.id !== a.id)!;
      expect(await db.getTransaction(a.id)).toMatchObject({
        presence: "seen",
        annotation: { data: { notes: "Synthetic first authorization note" } },
      });
      expect((await db.getTransaction(b.id))!.annotation).toBeNull();
      await ingest(db, capture({ rows: [second] }), 2);
      expect(await db.getTransaction(a.id)).toMatchObject({
        presence: "not_returned",
        annotation: { data: { notes: "Synthetic first authorization note" } },
      });
      expect(await db.getTransaction(b.id)).toMatchObject({
        presence: "seen",
        annotation: null,
      });
      await ingest(db, capture({ rows: [] }), 3);
      expect(await db.getTransaction(a.id)).toMatchObject({
        presence: "not_returned",
        annotation: { data: { notes: "Synthetic first authorization note" } },
      });
      expect(await db.getTransaction(b.id)).toMatchObject({
        presence: "not_returned",
        annotation: null,
      });
    } finally {
      db.close();
    }
  });

  it.each([false, true])(
    "keeps domestic pending independent of required legacy success (legacy failed=%s)",
    async (failedLegacy) => {
      const db = await openDatabase(":memory:");
      try {
        const initial = example();
        change(initial, (payload) => {
          payload.data.approvals = {
            approvedTransactions: [approval()],
            totalEstimatedAmount: 86.4,
          };
          payload.data.israelAbroadVouchers = null;
        });
        const emptyLegacy = JSON.parse(initial.responses.legacy!) as {
          CardsTransactionsListBean: {
            Index0: { CurrentCardTransactions: unknown[] };
          };
        };
        emptyLegacy.CardsTransactionsListBean.Index0.CurrentCardTransactions = [
          { txnIsrael: [], txnAbroad: [], txnInfo: [] },
        ];
        initial.responses.legacy = JSON.stringify(emptyLegacy);
        await ingest(db, initial, 0);
        const pending = (await db.listTransactions({ status: "pending" }))[0]!;
        await db.editAnnotation({
          transactionId: pending.id,
          expectedVersion: 0,
          notes: "Synthetic domestic note",
        });
        const next = example();
        change(next, (payload) => {
          payload.data.approvals = null;
        });
        if (failedLegacy) {
          next.responses.legacy = '{"Header":{"Status":"2"}}';
        }
        const outcome = await ingest(db, next, 1);
        expect(await db.getTransaction(pending.id)).toMatchObject({
          status: failedLegacy ? "pending" : "posted",
          presence: failedLegacy ? "not_returned" : "seen",
          annotation: { data: { notes: "Synthetic domestic note" } },
        });
        if (failedLegacy) {
          expect(outcome.status).toBe("partial");
          expect(
            (await db.listTransactions({ status: "posted" })).every(
              (row) => row.details.postingLink === undefined,
            ),
          ).toBe(true);
        } else {
          const survivor = (await db.getTransaction(pending.id))!;
          expect(survivor.details.postingLink?.automatic).toBe(true);
          expect(
            survivor.details.sourceRefs.some((ref) =>
              ref.path.startsWith("$.responses.legacy"),
            ),
          ).toBe(true);
        }
      } finally {
        db.close();
      }
    },
  );

  it.each(["twins", "malformed", "fee_blocker", "rollover"] as const)(
    "does not automatically attribute a %s component",
    async (scenario) => {
      const db = await openDatabase(":memory:");
      try {
        const first = capture({
          rows:
            scenario === "twins"
              ? [
                  approval(),
                  { ...approval(), seqConfirmationNumber: "SYNTHETIC-TWIN" },
                ]
              : [approval()],
        });
        await ingest(db, first, 0);
        const pending = await db.listTransactions({ status: "pending" });
        const next = capture({
          rows:
            scenario === "malformed"
              ? [{ ...approval(), confirmationTimeStamp: null }]
              : null,
          posted: true,
          ...(scenario === "rollover" ? { month: "2040-08" } : {}),
        });
        if (scenario === "fee_blocker") {
          change(next, (payload) => {
            const vouchers = (
              payload.data.israelAbroadVouchers as {
                vouchers: { israelAbroadVouchersList: Row[] };
              }
            ).vouchers.israelAbroadVouchersList;
            vouchers.push({
              ...vouchers[0],
              seqVoucherNumber: "SYNTHETIC-FEE",
              transactionCode: 10,
            });
          });
        }
        await ingest(db, next, 1);
        for (const row of pending) {
          expect(await db.getTransaction(row.id)).toMatchObject({
            status: "pending",
          });
        }
        expect(
          (await db.listTransactions({ status: "posted" })).every(
            (row) => row.details.postingLink === undefined,
          ),
        ).toBe(true);
        if (scenario === "malformed") {
          expect(
            (await db.listTransactions({ status: "pending" })).some(
              (row) =>
                row.identityStrength === "ambiguous" &&
                row.amountMinor === -8640,
            ),
          ).toBe(true);
        }
      } finally {
        db.close();
      }
    },
  );

  it("updates native authorization corrections across months without moving its note, and only unlists within comparable month scope", async () => {
    const db = await openDatabase(":memory:");
    try {
      await ingest(db, capture(), 0);
      const original = (await db.listTransactions({ status: "pending" }))[0]!;
      await db.editAnnotation({
        transactionId: original.id,
        expectedVersion: 0,
        notes: "Synthetic authorization note",
      });
      await ingest(
        db,
        capture({
          rows: [
            { ...approval(), originalAmount: 90, purchaseDate: "12/06/2040" },
          ],
          month: "2040-08",
        }),
        1,
      );
      const corrected = await db.getTransaction(original.id);
      expect(corrected).toMatchObject({
        amountMinor: -9000,
        transactionDate: "2040-06-12",
        presence: "seen",
        annotation: { data: { notes: "Synthetic authorization note" } },
      });
      await ingest(db, capture({ rows: null, month: "2040-09" }), 2);
      expect(await db.getTransaction(original.id)).toMatchObject({
        presence: "seen",
      });
      await ingest(db, capture({ rows: null, month: "2040-08" }), 3);
      expect(await db.getTransaction(original.id)).toMatchObject({
        presence: "not_returned",
      });
      await ingest(
        db,
        capture({
          rows: [
            { ...approval(), originalAmount: 90, purchaseDate: "12/06/2040" },
          ],
          month: "2040-08",
        }),
        4,
      );
      expect(await db.getTransaction(original.id)).toMatchObject({
        presence: "seen",
        annotation: { data: { notes: "Synthetic authorization note" } },
      });
    } finally {
      db.close();
    }
  });

  it("automatically continues a same-month singleton on the pending ID, preserving annotations and honest posted issues, and supports unlink", async () => {
    const db = await openDatabase(":memory:");
    try {
      await ingest(db, capture(), 0);
      const pending = (await db.listTransactions({ status: "pending" }))[0]!;
      await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        notes: "Synthetic purchase note",
        tags: ["reviewed"],
      });
      const outcome = await ingest(
        db,
        capture({ rows: null, posted: true }),
        1,
      );
      const survivor = (await db.getTransaction(pending.id))!;
      expect(outcome.created).toBe(0);
      expect(survivor).toMatchObject({
        id: pending.id,
        status: "posted",
        kind: "purchase",
        amountBasis: "purchase_commitment",
        amountMinor: -8640,
        presence: "seen",
        annotation: {
          data: { notes: "Synthetic purchase note", tags: ["reviewed"] },
        },
        details: {
          postingLink: { automatic: true },
          issues: ["source_derived_amount_direction"],
        },
      });
      expect(
        (await db.listTransactions()).filter((row) => !row.supersededById),
      ).toHaveLength(1);
      const split = await db.unlinkPendingTransaction({
        pendingId: survivor.id,
        postedId: survivor.details.postingLink!.postedId,
        expectedPendingVersion: survivor.version,
        expectedPendingAnnotationVersion: survivor.annotation!.version,
        expectedPostedVersion: (await db.getTransaction(
          survivor.details.postingLink!.postedId,
        ))!.version,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner split",
      });
      expect(await db.getTransaction(split.pending.id)).toMatchObject({
        id: pending.id,
        status: "pending",
        kind: "unknown",
        annotation: { data: { notes: "Synthetic purchase note" } },
      });
      await ingest(db, capture({ rows: null, posted: true }), 2);
      expect(await db.getTransaction(pending.id)).toMatchObject({
        status: "pending",
      });
    } finally {
      db.close();
    }
  });

  it("allows explicit manual link and unlink when automatic merchant evidence differs", async () => {
    const db = await openDatabase(":memory:");
    try {
      await ingest(
        db,
        capture({
          rows: [
            { ...approval(), businessName: "Synthetic authorization merchant" },
          ],
        }),
        0,
      );
      const pending = (await db.listTransactions({ status: "pending" }))[0]!;
      await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        notes: "Synthetic manual note",
      });
      await ingest(
        db,
        capture({ rows: null, posted: true, month: "2040-08" }),
        1,
      );
      const posted = (await db.listTransactions({ status: "posted" }))[0]!;
      const current = (await db.getTransaction(pending.id))!;
      const linked = await db.linkPendingTransaction({
        pendingId: pending.id,
        postedId: posted.id,
        expectedPendingVersion: current.version,
        expectedPostedVersion: posted.version,
        expectedPendingAnnotationVersion: current.annotation!.version,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner-confirmed continuation",
      });
      expect(await db.getTransaction(linked.id)).toMatchObject({
        id: pending.id,
        status: "posted",
        annotation: { data: { notes: "Synthetic manual note" } },
      });
      const split = await db.unlinkPendingTransaction({
        pendingId: linked.id,
        postedId: posted.id,
        expectedPendingVersion: linked.version,
        expectedPendingAnnotationVersion: (await db.getTransaction(linked.id))!
          .annotation!.version,
        expectedPostedVersion: (await db.getTransaction(posted.id))!.version,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner split",
      });
      expect(await db.getTransaction(split.pending.id)).toMatchObject({
        id: pending.id,
        status: "pending",
        annotation: { data: { notes: "Synthetic manual note" } },
      });
      expect(split.posted.id).toBe(posted.id);
    } finally {
      db.close();
    }
  });
});
