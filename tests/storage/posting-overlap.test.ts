import "../helpers/run-history-differential.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import type { SourceAdapter } from "../../src/domain/source-adapter.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import {
  backends,
  type Harness,
  open,
  row,
} from "../helpers/storage-harness.js";

const { automaticPosting: _automaticPosting, ...manualPostingAdapter } =
  postingAdapter;

function incompletePartition(
  status: "pending" | "posted",
  success: boolean,
  comparable: boolean,
): SourceAdapter {
  return {
    ...postingAdapter,
    extract(...args) {
      const result = postingAdapter.extract(...args);
      const partition = result.partitions.find(
        (partition) => partition.status === status,
      )!;
      partition.success = success;
      partition.comparable = comparable;
      return result;
    },
  };
}

const incompleteCaptures = [
  ["failed pending", incompletePartition("pending", false, false)],
  ["failed posted", incompletePartition("posted", false, false)],
  ["incomparable pending", incompletePartition("pending", true, false)],
] as const;

describe.each(backends)("%s delayed posting overlap", (backend) => {
  let db: Harness;
  let harness: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
  });
  afterEach(async () => db.close());

  async function overlap(postedFields: Partial<TransactionInput> = {}) {
    await harness.capture(2, [authorization()]);
    const pending = await harness.byKey("pending");
    await harness.capture(3, [authorization(), row("posted", postedFields)]);
    const posted = await harness.byKey("posted");
    return { pending, posted };
  }

  async function postingEvents() {
    return (await db.listEvents()).filter((event) =>
      ["transaction.posted", "transaction.linked"].includes(event.type),
    );
  }

  it("persists a unique overlap, preserves the pending ID and annotation, and splits reversibly", async () => {
    await harness.capture(2, [authorization()]);
    const pending = await harness.byKey("pending");
    const annotation = await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      expectedTransactionVersion: pending.version,
      notes: "Keep this authorization note",
      category: "Household",
      tags: ["receipt"],
      metadata: { project: "synthetic kitchen" },
      review: { status: "approved" },
    });
    await harness.capture(3, [authorization(), row("posted")]);
    const posted = await harness.byKey("posted");
    const overlapping = await harness.byKey("pending");
    expect(overlapping).toMatchObject({
      id: pending.id,
      status: "pending",
      presence: "seen",
      annotation,
      details: {
        postingOverlap: {
          postedId: posted.id,
          runId: "posting-3",
          capturedAt: "2040-07-03T12:00:00.000Z",
          pendingFingerprint: expect.any(String),
          postedFingerprint: expect.any(String),
        },
      },
    });
    expect(await postingEvents()).toEqual([]);
    expect(
      await db.listTransactions({ status: "pending", presence: "seen" }),
    ).toHaveLength(1);
    expect(await db.getTotals()).toMatchObject({
      includedCount: 1,
      totals: [{ amountMinor: -100 }],
    });

    // A separate database handle must see the witness, not just the ingest plan.
    const peer = await db.peer();
    try {
      expect(
        (await peer.getTransaction(pending.id))!.details.postingOverlap,
      ).toEqual(overlapping.details.postingOverlap);
    } finally {
      await peer.close();
    }
    const cursor = await db.latestEventId();
    await harness.capture(4, [row("posted")]);
    const survivor = await harness.byKey("posted");
    expect(survivor).toMatchObject({
      id: pending.id,
      status: "posted",
      sourceKey: "posted",
      sourceAliases: ["pending"],
      annotation,
      reviewStale: true,
      details: {
        postingLink: {
          automatic: true,
          postedId: posted.id,
          pending: { presence: "not_returned" },
        },
      },
    });
    expect(survivor.details.postingOverlap).toBeUndefined();
    expect(survivor.details.postingLink!.evidence).toEqual({
      runId: "posting-4",
      capturedAt: "2040-07-04T12:00:00.000Z",
      overlap: overlapping.details.postingOverlap,
    });
    expect(await db.getTransaction(posted.id)).toMatchObject({
      supersededById: pending.id,
      annotation: null,
    });
    expect(await db.listTransactions()).toHaveLength(1);
    expect(
      await db.listTransactions({ status: "pending", presence: "seen" }),
    ).toEqual([]);
    const changes = await db.listEvents({ after: cursor });
    expect(
      changes.filter((event) => event.type === "transaction.posted"),
    ).toMatchObject([
      { transactionId: pending.id, actor: "system", runId: "posting-4" },
    ]);
    expect(
      changes.filter((event) => event.type === "transaction.linked"),
    ).toMatchObject([
      { transactionId: posted.id, actor: "system", runId: "posting-4" },
    ]);
    expect(
      changes.filter((event) =>
        [
          "transaction.created",
          "transaction.unlisted",
          "annotation.updated",
        ].includes(event.type),
      ),
    ).toEqual([]);
    expect(await db.getTotals()).toMatchObject({
      includedCount: 1,
      totals: [{ amountMinor: -100 }],
    });

    const linkedState = await harness.state();
    expect(await harness.capture(4, [row("posted")])).toMatchObject({
      replayed: true,
    });
    expect(await harness.state()).toEqual(linkedState);
    await harness.capture(5, [row("posted")]);
    expect(await db.listEvents()).toEqual(linkedState.changes);
    expect(await postingEvents()).toHaveLength(2);

    const command = await harness.command(pending.id, posted.id);
    await db.unlinkPendingTransaction(command);
    expect(await db.getTransaction(pending.id)).toMatchObject({
      id: pending.id,
      sourceKey: "pending",
      status: "pending",
      presence: "not_returned",
      annotation,
      details: { rejectedPostingKeys: ["posted"] },
    });
    expect(await db.getTransaction(posted.id)).toMatchObject({
      id: posted.id,
      status: "posted",
      supersededById: null,
      annotation: null,
    });
    expect(await db.getTotals()).toMatchObject({
      includedCount: 1,
      totals: [{ amountMinor: -100 }],
    });
    const splitState = await harness.state();
    await db.unlinkPendingTransaction(command);
    expect(await harness.state()).toEqual(splitState);
    await harness.capture(6, [authorization(), row("posted")]);
    await harness.capture(7, [row("posted")]);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect((await db.getTransaction(posted.id))!.supersededById).toBeNull();
    expect(await postingEvents()).toHaveLength(2);
  });

  it.each([
    ["unknown kind", { kind: "unknown" }],
    ["unknown basis", { amountBasis: "unknown" }],
    ["unknown kind and basis", { kind: "unknown", amountBasis: "unknown" }],
  ] satisfies [string, Partial<TransactionInput>][])(
    "waits for stronger %s after pending absence without losing the overlap",
    async (_name, uncertain) => {
      const { pending, posted } = await overlap(uncertain);
      const annotation = await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        notes: "Retain while classification is unresolved",
      });
      const witness = (await harness.byKey("pending")).details.postingOverlap;
      expect(witness).toMatchObject({
        postedId: posted.id,
        runId: "posting-3",
      });
      await harness.capture(4, [row("posted", uncertain)]);
      expect(await db.getTransaction(pending.id)).toMatchObject({
        status: "pending",
        presence: "not_returned",
        annotation,
        details: { postingOverlap: witness },
      });
      expect(await postingEvents()).toEqual([]);
      expect(await db.listTransactions()).toHaveLength(2);
      expect(
        await db.listTransactions({ status: "pending", presence: "seen" }),
      ).toEqual([]);
      await harness.capture(5, [row("posted")]);
      expect(await harness.byKey("posted")).toMatchObject({
        id: pending.id,
        status: "posted",
        kind: "purchase",
        amountBasis: "purchase_commitment",
        annotation,
        details: { postingLink: { automatic: true, postedId: posted.id } },
      });
      expect(await postingEvents()).toHaveLength(2);
      expect(await db.getTotals()).toMatchObject({
        includedCount: 1,
        totals: [{ amountMinor: -100 }],
      });
    },
  );

  it("does not reclassify a known booked-entry role using later overlap eligibility", async () => {
    const { pending } = await overlap({ amountBasis: "booked_entry" });
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await harness.capture(4, [row("posted", { amountBasis: "booked_entry" })]);
    await harness.capture(5, [row("posted")]);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect(await db.listTransactions()).toHaveLength(2);
    expect(await postingEvents()).toEqual([]);
  });

  it("revokes an overlap when an absent pending identity reappears before eligibility strengthens", async () => {
    const uncertain = row("posted", { kind: "unknown" });
    const { pending } = await overlap({ kind: "unknown" });
    await harness.capture(4, [uncertain]);
    expect(await db.getTransaction(pending.id)).toMatchObject({
      presence: "not_returned",
      details: { postingOverlap: { runId: "posting-3" } },
    });
    await harness.capture(5, [authorization(), uncertain]);
    expect(await db.getTransaction(pending.id)).toMatchObject({
      presence: "seen",
    });
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await harness.capture(6, [row("posted")]);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect(await postingEvents()).toEqual([]);
  });

  it("ignores provider-injected overlap evidence even when it names real rows and a real capture", async () => {
    await harness.capture(2, [authorization(), row("posted")]);
    const pending = await harness.byKey("pending");
    const posted = await harness.byKey("posted");
    const injected = authorization();
    injected.details.postingOverlap = {
      postedId: posted.id,
      runId: "posting-2",
      capturedAt: "2040-07-02T12:00:00.000Z",
      pendingFingerprint: JSON.stringify([
        "pending",
        "account",
        pending.cardId,
        "2040-07-01",
        { amountMinor: -100, currency: "ILS" },
        -100,
        "ILS",
        "Merchant",
      ]),
      postedFingerprint: JSON.stringify([
        "posted",
        "account",
        posted.cardId,
        "2040-07-01",
        { amountMinor: -100, currency: "ILS" },
        -100,
        "ILS",
        "Merchant",
      ]),
    };
    await harness.capture(3, [injected, row("posted")]);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await harness.capture(4, [row("posted")]);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect(await postingEvents()).toEqual([]);
  });

  it("does not consume an overlap under a different collection scope", async () => {
    const { pending, posted } = await overlap();
    await db.ingestRun(
      {
        connectionId: harness.connectionId,
        runId: "other-scope",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-07-04T12:00:00Z",
            scope: { kind: "recent", filters: { merchant: "Merchant" } },
            responseText: JSON.stringify([row("posted")]),
          },
        ],
      },
      postingAdapter,
    );
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect((await db.getTransaction(posted.id))!.supersededById).toBeNull();
    expect(await postingEvents()).toEqual([]);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeDefined();
    await harness.capture(5, [row("posted")]);
    expect((await harness.byKey("posted")).id).toBe(pending.id);
  });

  it.each(incompleteCaptures)(
    "does not establish an overlap from %s coverage",
    async (_name, adapter) => {
      await harness.capture(2, [authorization()]);
      await harness.capture(3, [authorization(), row("posted")], adapter);
      expect(
        (await harness.byKey("pending")).details.postingOverlap,
      ).toBeUndefined();
      expect(await postingEvents()).toEqual([]);
    },
  );

  it.each(incompleteCaptures)(
    "does not consume a witnessed overlap during %s coverage",
    async (_name, adapter) => {
      const { pending, posted } = await overlap();
      await harness.capture(4, [row("posted")], adapter);
      expect((await db.getTransaction(pending.id))!.status).toBe("pending");
      expect((await db.getTransaction(posted.id))!.supersededById).toBeNull();
      expect(await postingEvents()).toEqual([]);
      await harness.capture(5, [row("posted")]);
      expect((await harness.byKey("posted")).id).toBe(pending.id);
      expect(await postingEvents()).toHaveLength(2);
    },
  );

  it.each(["stale", "equal-time", "historical"])(
    "does not establish an overlap from a %s capture",
    async (mode) => {
      await harness.capture(3, [authorization()]);
      await harness.capture(
        mode === "historical" ? 4 : 3,
        [authorization(), row("posted")],
        postingAdapter,
        {
          runId: "ineligible-overlap",
          hour: mode === "stale" ? "11" : "12",
          history: mode === "historical",
        },
      );
      expect(
        (await harness.byKey("pending")).details.postingOverlap,
      ).toBeUndefined();
      await harness.capture(5, [authorization(), row("posted")]);
      await harness.capture(6, [row("posted")]);
      expect((await harness.byKey("pending")).status).toBe("pending");
      expect(await postingEvents()).toEqual([]);
    },
  );

  it.each(["stale", "equal-time", "historical"])(
    "does not consume a witnessed overlap from a %s capture",
    async (mode) => {
      const { pending } = await overlap();
      await harness.capture(
        mode === "historical" ? 4 : 3,
        [row("posted")],
        postingAdapter,
        {
          runId: "ineligible-absence",
          hour: mode === "stale" ? "11" : "12",
          history: mode === "historical",
        },
      );
      expect((await db.getTransaction(pending.id))!.status).toBe("pending");
      expect(await postingEvents()).toEqual([]);
      await harness.capture(5, [row("posted")]);
      expect((await harness.byKey("posted")).id).toBe(pending.id);
    },
  );

  it.each(["baseline together", "posted first", "already known posted"])(
    "does not manufacture overlap evidence for %s",
    async (mode) => {
      if (mode === "posted first") {
        await harness.capture(2, [row("posted")]);
      } else if (mode === "already known posted") {
        await harness.capture(2, [authorization()]);
        await harness.capture(
          3,
          [authorization(), row("posted")],
          manualPostingAdapter,
        );
      }
      await harness.capture(4, [authorization(), row("posted")]);
      expect(
        (await harness.byKey("pending")).details.postingOverlap,
      ).toBeUndefined();
      await harness.capture(5, [row("posted")]);
      expect(await db.listTransactions()).toHaveLength(2);
      expect(await postingEvents()).toEqual([]);
    },
  );

  it("does not establish overlap when a competing posting leaves the equality group in the same capture", async () => {
    await harness.capture(2, [authorization(), row("competitor")]);
    const pending = await harness.byKey("pending");
    const corrected = row("competitor", { amountMinor: -125 });
    await harness.capture(3, [authorization(), corrected, row("posted")]);
    expect(
      (await db.getTransaction(pending.id))!.details.postingOverlap,
    ).toBeUndefined();
    await harness.capture(4, [corrected, row("posted")]);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect(await db.listTransactions()).toHaveLength(3);
    expect(await postingEvents()).toEqual([]);
  });

  it.each(["missing", "changed"])(
    "preserves original purchase-money attribution when billed money is %s",
    async (mode) => {
      const pendingInput = authorization("pending", { currency: "USD" });
      const initialPosted = row("posted", {
        kind: "unknown",
        amountMinor: mode === "missing" ? null : -300,
        currency: mode === "missing" ? null : "ILS",
        originalAmountMinor: -100,
        originalCurrency: "USD",
      });
      await harness.capture(2, [pendingInput]);
      const pending = await harness.byKey("pending");
      await harness.capture(3, [pendingInput, initialPosted]);
      const posted = await harness.byKey("posted");
      const witness = (await db.getTransaction(pending.id))!.details
        .postingOverlap;
      expect(witness).toMatchObject({
        postedId: posted.id,
        runId: "posting-3",
      });
      await harness.capture(4, [initialPosted]);
      expect((await db.getTransaction(pending.id))!.presence).toBe(
        "not_returned",
      );
      expect(await postingEvents()).toEqual([]);
      await harness.capture(5, [
        row("posted", {
          amountMinor: -350,
          currency: "ILS",
          originalAmountMinor: -100,
          originalCurrency: "USD",
        }),
      ]);
      expect(await harness.byKey("posted")).toMatchObject({
        id: pending.id,
        status: "posted",
        amountMinor: -350,
        currency: "ILS",
        originalAmountMinor: -100,
        originalCurrency: "USD",
        details: { postingLink: { postedId: posted.id, automatic: true } },
      });
      expect(await postingEvents()).toHaveLength(2);
    },
  );

  it.each([
    ["amount", { originalAmountMinor: -125 }],
    ["currency", { originalCurrency: "EUR" }],
  ] satisfies [string, Partial<TransactionInput>][])(
    "invalidates overlap when original purchase %s changes despite unchanged billed money",
    async (_name, changed) => {
      const pendingInput = authorization("pending", { currency: "USD" });
      const postedInput = row("posted", {
        amountMinor: -350,
        originalAmountMinor: -100,
        originalCurrency: "USD",
      });
      await harness.capture(2, [pendingInput]);
      const pending = await harness.byKey("pending");
      await harness.capture(3, [pendingInput, postedInput]);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap,
      ).toBeDefined();
      await harness.capture(4, [pendingInput, { ...postedInput, ...changed }]);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap,
      ).toBeUndefined();
      await harness.capture(5, [pendingInput, postedInput]);
      await harness.capture(6, [postedInput]);
      expect((await db.getTransaction(pending.id))!.status).toBe("pending");
      expect(await postingEvents()).toEqual([]);
    },
  );

  it.each([
    [
      "omitted posted context",
      {},
      {},
      {
        wallet: "apple_pay",
        authorizationMethod: "online",
        threeDSecureUsed: true,
      },
    ],
    [
      "previously stated posted context",
      { wallet: "google_pay" },
      {},
      {
        wallet: "google_pay",
        authorizationMethod: "online",
        threeDSecureUsed: true,
      },
    ],
    [
      "latest stated posted context",
      { wallet: "google_pay", authorizationMethod: "chip" },
      { wallet: "samsung_pay", authorizationMethod: "contactless" },
      {
        wallet: "samsung_pay",
        authorizationMethod: "contactless",
        threeDSecureUsed: true,
      },
    ],
    [
      "explicit unknown context",
      {},
      { authorizationMethod: null, threeDSecureUsed: null },
      {
        wallet: "apple_pay",
        authorizationMethod: null,
        threeDSecureUsed: null,
      },
    ],
    [
      "retained posted conflict",
      { authorizationMethod: null, threeDSecureUsed: null },
      {},
      {
        wallet: "apple_pay",
        authorizationMethod: null,
        threeDSecureUsed: null,
      },
    ],
  ] satisfies [
    string,
    Partial<TransactionInput>,
    Partial<TransactionInput>,
    Partial<TransactionInput>,
  ][])(
    "continues delayed payment context with %s",
    async (_name, initialContext, latestContext, expected) => {
      const pendingInput = authorization("pending", {
        wallet: "apple_pay",
        authorizationMethod: "online",
        threeDSecureUsed: true,
      });
      await harness.capture(2, [pendingInput]);
      const pending = await harness.byKey("pending");
      // Isolate shared context retention; CAL separately vetoes conflict issues below.
      const contextAdapter: SourceAdapter = {
        ...postingAdapter,
        automaticPosting: {
          ...postingAdapter.automaticPosting!,
          compatibleGroups: () => true,
        },
      };
      await harness.capture(
        3,
        [pendingInput, row("posted", initialContext)],
        contextAdapter,
      );
      await harness.capture(4, [row("posted", latestContext)], contextAdapter);
      expect(await harness.byKey("posted")).toMatchObject({
        id: pending.id,
        status: "posted",
        ...expected,
        details: { postingLink: { automatic: true } },
      });
      const conflicts = (await harness.byKey("posted")).details
        .paymentContextConflicts;
      if (expected.authorizationMethod === null) {
        expect(conflicts).toEqual(["authorizationMethod", "threeDSecureUsed"]);
      } else {
        expect(conflicts).toBeUndefined();
      }
    },
  );

  it("keeps CAL's payment-context conflict veto for delayed links", async () => {
    const { pending } = await overlap();
    await harness.capture(4, [row("posted", { authorizationMethod: null })]);
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect(await postingEvents()).toEqual([]);
    expect((await harness.byKey("posted")).details.issues).toContain(
      "conflicting_payment_context",
    );
  });

  it.each(["pending", "posted"] as const)(
    "invalidates the witness when another plausible %s arrives",
    async (status) => {
      const { pending } = await overlap();
      const competitor =
        status === "pending" ? authorization("competitor") : row("competitor");
      await harness.capture(4, [authorization(), row("posted"), competitor]);
      expect(
        (await db.getTransaction(pending.id))!.details.postingOverlap,
      ).toBeUndefined();
      // Removing the ambiguity later cannot retroactively turn an old posting into an arrival.
      const corrected = { ...competitor, amountMinor: -125 };
      await harness.capture(5, [authorization(), row("posted"), corrected]);
      await harness.capture(6, [row("posted"), corrected]);
      expect((await db.getTransaction(pending.id))!.status).toBe("pending");
      expect(await postingEvents()).toEqual([]);
    },
  );

  describe.each(["pending", "posted"] as const)(
    "%s attribution facts",
    (side) => {
      it.each([
        ["money", { amountMinor: -125 }],
        ["currency", { currency: "USD" }],
        ["date", { transactionDate: "2040-07-02" }],
        ["card", { cardKey: "other-card" }],
        ["merchant", { merchantName: "Different Merchant" }],
        ["native key", { sourceKey: "replacement-key", sourceAliases: [side] }],
      ] satisfies [string, Partial<TransactionInput>][])(
        "permanently invalidates an overlap after a %s change",
        async (_name, facts) => {
          const { pending } = await overlap();
          await harness.capture(4, [
            authorization("pending", side === "pending" ? facts : {}),
            row("posted", side === "posted" ? facts : {}),
          ]);
          expect(
            (await db.getTransaction(pending.id))!.details.postingOverlap,
          ).toBeUndefined();
          await harness.capture(5, [authorization(), row("posted")]);
          await harness.capture(6, [row("posted")]);
          expect((await db.getTransaction(pending.id))!.status).toBe("pending");
          expect(await postingEvents()).toEqual([]);
        },
      );
    },
  );

  it.each([
    ["notes", { notes: "Posted-side note" }],
    ["category", { category: "Household" }],
    ["tags", { tags: ["receipt"] }],
    ["metadata", { metadata: { project: "synthetic kitchen" } }],
    ["review", { review: { status: "approved" as const } }],
  ])("does not retire a posted identity carrying %s", async (_name, edit) => {
    const { pending, posted } = await overlap();
    const annotation = await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      expectedTransactionVersion: posted.version,
      ...edit,
    });
    await harness.capture(4, [row("posted")]);
    await harness.capture(5, [row("posted")]);
    expect(await db.getTransaction(pending.id)).toMatchObject({
      status: "pending",
      presence: "not_returned",
      annotation: null,
    });
    expect(await db.getTransaction(posted.id)).toMatchObject({
      supersededById: null,
      annotation,
    });
    expect(await postingEvents()).toEqual([]);
  });

  it("keeps provider-incompatible evidence in review despite an overlap and absence", async () => {
    await harness.capture(2, [
      authorization("pending", { merchantName: "Merchant A" }),
    ]);
    await harness.capture(3, [
      authorization("pending", { merchantName: "Merchant A" }),
      row("posted", { merchantName: "Merchant B" }),
    ]);
    await harness.capture(4, [row("posted", { merchantName: "Merchant B" })]);
    expect((await harness.byKey("pending")).status).toBe("pending");
    expect((await harness.byKey("posted")).supersededById).toBeNull();
    expect(await postingEvents()).toEqual([]);
  });

  it("rolls back delayed linking with its witness and annotations intact, then recovers exactly once", async () => {
    const { pending, posted } = await overlap();
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Keep on retry",
    });
    const before = await harness.state();
    if (backend === "postgres") {
      await db.raw(
        "CREATE FUNCTION reject_overlap_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'transaction.linked' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
      );
      await db.raw(
        "CREATE TRIGGER reject_overlap_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_overlap_audit()",
      );
    } else {
      await db.raw(
        "CREATE TRIGGER reject_overlap_audit BEFORE INSERT ON events WHEN NEW.type = 'transaction.linked' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END",
      );
    }
    await expect(harness.capture(4, [row("posted")])).rejects.toThrow();
    expect(await harness.state()).toEqual(before);
    await db.raw(
      backend === "postgres"
        ? "DROP TRIGGER reject_overlap_audit ON events"
        : "DROP TRIGGER reject_overlap_audit",
    );
    await db.applyRun("posting-4", postingAdapter);
    expect(await harness.byKey("posted")).toMatchObject({
      id: pending.id,
      annotation: { data: { notes: "Keep on retry" } },
      details: { postingLink: { postedId: posted.id, automatic: true } },
    });
    const recovered = await harness.state();
    expect(await db.applyRun("posting-4", postingAdapter)).toMatchObject({
      replayed: true,
    });
    expect(await harness.state()).toEqual(recovered);
    expect(await postingEvents()).toHaveLength(2);
  });
});
