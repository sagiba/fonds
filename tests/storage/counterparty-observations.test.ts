import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type TransactionInput,
  transactionInputSchema,
} from "../../src/domain/model.js";
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
