import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { emptyDetails } from "../../src/domain/model.js";
import { RECONCILIATION_POLICY_VERSION } from "../../src/domain/plans/sync.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import { calPostingEvidence } from "../../src/providers/cal/posting-evidence.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import {
  backends,
  fixture,
  type Harness,
  open,
  row,
} from "../helpers/storage-harness.js";

const { automaticPosting: _automaticPosting, ...manualPostingAdapter } =
  postingAdapter;

describe.each(backends)("%s automatic posting and split", (backend) => {
  let db: Harness;
  let harness: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    harness = postingHarness(db);
    await db.ensureConnection({ id: harness.connectionId, provider: "cal" });
  });
  afterEach(async () => db.close());

  async function linked() {
    await harness.capture(2, [
      authorization("pending", { merchantName: "Shop B Testburg NLD" }),
    ]);
    const pending = await harness.byKey("pending");
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Shop A",
    });
    await harness.capture(3, [row("posted", { merchantName: "Shop B" })]);
    const survivor = await harness.byKey("posted");
    const postedId = survivor.details.postingLink!.postedId;
    return { pending, survivor, postedId };
  }

  it.each([
    ["PAYDEMO *FIXTURE MEDIA Testburg NLD", "PAYDEMO *FIXTURE MEDIA"],
    ["סופר דוגמה ובניו בעמ", "סופר דוגמה ובניו"],
  ])(
    "continues truncation %s → %s with unchanged annotations and one financial transition",
    async (pendingName, postedName) => {
      const postedRow = row("posted", { merchantName: postedName });
      await harness.capture(2, [
        authorization("pending", { merchantName: pendingName }),
      ]);
      const pending = await harness.byKey("pending");
      const annotation = await db.editAnnotation({
        transactionId: pending.id,
        expectedVersion: 0,
        expectedTransactionVersion: pending.version,
        notes: "Keep",
        review: { status: "approved" },
      });
      const cursor = await db.latestEventId();
      expect(await harness.capture(3, [postedRow])).toMatchObject({
        created: 0,
        updated: 1,
        unlisted: 0,
      });
      const survivor = await harness.byKey("posted");
      expect(survivor).toMatchObject({
        id: pending.id,
        status: "posted",
        version: pending.version + 1,
        sourceKey: "posted",
        sourceAliases: ["pending"],
        annotation,
        reviewStale: true,
        details: {
          postingLink: {
            automatic: true,
            policyVersion: RECONCILIATION_POLICY_VERSION,
            pendingKeys: ["pending"],
            postedKeys: ["posted"],
            pending: { presence: "not_returned" },
          },
        },
      });
      const changes = await db.listEvents({ after: cursor });
      expect(
        changes.filter((change) =>
          ["transaction.posted", "transaction.linked"].includes(change.type),
        ),
      ).toMatchObject([
        {
          transactionId: pending.id,
          type: "transaction.posted",
          actor: "system",
          runId: "posting-3",
          after: { automatic: true },
        },
        {
          transactionId: survivor.details.postingLink!.postedId,
          type: "transaction.linked",
          actor: "system",
        },
      ]);
      expect(
        changes.some((change) =>
          [
            "transaction.created",
            "transaction.unlisted",
            "annotation.updated",
          ].includes(change.type),
        ),
      ).toBe(false);
      expect(await db.getTotals()).toMatchObject({
        includedCount: 1,
        totals: [{ amountMinor: -100 }],
      });
      expect(
        await db.getTransaction(survivor.details.postingLink!.postedId),
      ).toMatchObject({ supersededById: pending.id, annotation: null });
      const state = await harness.state();
      expect(await harness.capture(3, [postedRow])).toMatchObject({
        replayed: true,
      });
      expect(await harness.state()).toEqual(state);
      await harness.capture(4, [
        postedRow,
        authorization("pending", { merchantName: pendingName }),
      ]);
      expect(await db.getTransaction(pending.id)).toMatchObject({
        status: "posted",
        version: survivor.version,
      });
    },
  );

  it.each([
    [
      {},
      {
        wallet: "apple_pay",
        authorizationMethod: "online",
        threeDSecureUsed: true,
      },
    ],
    [
      { threeDSecureUsed: null },
      {
        wallet: "apple_pay",
        authorizationMethod: "online",
        threeDSecureUsed: null,
      },
    ],
  ])(
    "continues a pending row's payment context unless the posted read states it (%j)",
    async (postedFacts, expected) => {
      await harness.capture(2, [
        authorization("pending", {
          merchantName: "Shop B Testburg NLD",
          wallet: "apple_pay",
          authorizationMethod: "online",
          threeDSecureUsed: true,
        }),
      ]);
      const pending = await harness.byKey("pending");
      await harness.capture(3, [
        row("posted", { merchantName: "Shop B", ...postedFacts }),
      ]);
      const survivor = await harness.byKey("posted");
      expect(survivor.id).toBe(pending.id);
      expect(survivor.details.postingLink?.automatic).toBe(true);
      // Absent facts keep the stored values; an explicit conflict null replaces them.
      expect(survivor).toMatchObject(expected);
    },
  );

  it("keeps cancelled-A/direct-posted-B separate with stable review across identical partial and stale captures", async () => {
    await harness.capture(2, [
      authorization("pending", { merchantName: "Shop A" }),
    ]);
    const pending = await harness.byKey("pending");
    const postedRow = row("posted", { merchantName: "Shop B" });
    await harness.capture(3, [postedRow]);
    const posted = await harness.byKey("posted");
    expect(posted.id).not.toBe(pending.id);
    expect(await db.listTransactions()).toHaveLength(2);
    expect(
      (await db.getTransaction(pending.id))!.pendingPostingCandidates,
    ).toEqual([posted.id]);
    expect(posted.pendingPostingCandidates).toEqual([pending.id]);
    const changes = await db.listEvents();
    expect(
      changes.some((change) =>
        ["transaction.posted", "transaction.linked"].includes(change.type),
      ),
    ).toBe(false);
    const partial = {
      ...postingAdapter,
      extract: (
        text: string,
        context: Parameters<typeof postingAdapter.extract>[1],
      ) => {
        const result = postingAdapter.extract(text, context);
        result.partitions.find(
          (partition) => partition.status === "pending",
        )!.comparable = false;
        return result;
      },
    };
    for (const [day, adapter, runId] of [
      [4, postingAdapter, "identical"],
      [5, partial, "partial"],
      [2, postingAdapter, "stale"],
      [6, postingAdapter, "fresh"],
    ] as const) {
      await harness.capture(day, [postedRow], adapter, { runId });
      expect(await db.listEvents()).toEqual(changes);
      expect((await harness.byKey("pending")).pendingPostingCandidates).toEqual(
        [posted.id],
      );
      expect((await harness.byKey("posted")).pendingPostingCandidates).toEqual([
        pending.id,
      ]);
      expect(await db.listTransactions()).toHaveLength(2);
    }
  });

  it("accepts directional truncation and recovers a false link completely after correction and annotation edits", async () => {
    const { pending, survivor, postedId } = await linked();
    expect(survivor.id).toBe(pending.id);
    await harness.capture(4, [
      row("posted", {
        amountMinor: -125,
        merchantName: "Shop B corrected",
      }),
    ]);
    const note = await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 1,
      notes: "Cancelled at A; bought at B",
    });
    const totals = await db.getTotals();
    const command = await harness.command(pending.id, postedId);
    const result = await db.unlinkPendingTransaction(command);
    expect(result.pending).toMatchObject({
      id: pending.id,
      sourceKey: "pending",
      sourceAliases: [],
      status: "pending",
      amountMinor: -100,
      presence: "not_returned",
      version: 4,
      details: {
        rejectedPostingKeys: ["posted"],
        sourceRefs: [{ runId: "posting-2" }],
      },
    });
    expect(result.posted).toMatchObject({
      id: postedId,
      status: "posted",
      amountMinor: -125,
      merchantName: "Shop B corrected",
      sourceKey: "posted",
      sourceAliases: [],
      supersededById: null,
      version: 3,
      presence: "seen",
    });
    expect(result.posted.details.sourceRefs.map((ref) => ref.runId)).toEqual([
      "posting-4",
    ]);
    expect((await db.getTransaction(pending.id))!.annotation).toEqual(note);
    expect((await db.getTransaction(postedId))!.annotation).toBeNull();
    expect((await db.getTotals()).totals).toEqual(totals.totals);
    const state = await harness.state();
    await db.unlinkPendingTransaction(command);
    expect(await harness.state()).toEqual(state);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.unlinked",
      ),
    ).toHaveLength(2);
    await harness.capture(5, [row("posted"), authorization()]);
    await harness.capture(6, [row("posted")]);
    expect(await db.getTransaction(pending.id)).toMatchObject({
      status: "pending",
      presence: "not_returned",
      pendingPostingCandidates: [],
    });
    expect(await db.getTransaction(postedId)).toMatchObject({
      supersededById: null,
      status: "posted",
      pendingPostingCandidates: [],
    });
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toHaveLength(1);
  });

  it("pairs two annotated twins deterministically across source permutations and replay", async () => {
    await harness.capture(2, [authorization("p-b"), authorization("p-a")]);
    const pending = await Promise.all(
      ["p-a", "p-b"].map((key) => harness.byKey(key)),
    );
    for (const row of pending) {
      await db.editAnnotation({
        transactionId: row.id,
        expectedVersion: 0,
        notes: row.sourceKey,
      });
    }
    await harness.capture(3, [row("s-b"), row("s-a")]);
    for (const [index, key] of ["s-a", "s-b"].entries()) {
      expect(await harness.byKey(key)).toMatchObject({
        id: pending[index]!.id,
        annotation: { data: { notes: pending[index]!.sourceKey } },
      });
    }
    const changes = await db.listEvents();
    await harness.capture(4, [row("s-a"), row("s-b")]);
    expect(await db.listEvents()).toEqual(changes);
    expect(await db.listTransactions()).toHaveLength(2);
    expect(await db.listTransactions({ includeSuperseded: true })).toHaveLength(
      4,
    );
    expect(await db.getTotals()).toMatchObject({
      includedCount: 2,
      totals: [{ amountMinor: -200 }],
    });
    expect(await harness.capture(3, [row("s-b"), row("s-a")])).toMatchObject({
      replayed: true,
    });
  });

  it.each([
    [1, 2],
    [2, 1],
  ])(
    "leaves an unequal %i-pending/%i-posted component in review without greedy consumption",
    async (pendingCount, postedCount) => {
      await harness.capture(
        2,
        Array.from({ length: pendingCount }, (_, index) =>
          authorization(`p-${index}`),
        ),
      );
      await harness.capture(
        3,
        Array.from({ length: postedCount }, (_, index) => row(`s-${index}`)),
      );
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.posted",
        ),
      ).toEqual([]);
      const rows = await db.listTransactions();
      expect(rows).toHaveLength(pendingCount + postedCount);
      expect(rows.every((row) => row.pendingPostingCandidates.length > 0)).toBe(
        true,
      );
    },
  );

  it("does not reassign twins posting across different runs", async () => {
    await harness.capture(2, [authorization("p-a"), authorization("p-b")]);
    await harness.capture(3, [row("s-a")]);
    await harness.capture(4, [row("s-a"), row("s-b")]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(await db.listTransactions()).toHaveLength(4);
  });

  it("blocks a new posting when an earlier unlinked posting remains plausible across runs", async () => {
    await harness.capture(2, [authorization()]);
    const pending = await harness.byKey("pending");
    await harness.capture(3, [authorization(), row("posted-old")]);
    await harness.capture(4, [row("posted-new")]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(await db.getTransaction(pending.id)).toMatchObject({
      status: "pending",
      presence: "not_returned",
      reviewRequired: true,
    });
    expect(
      (await db.getTransaction(pending.id))!.pendingPostingCandidates,
    ).toHaveLength(2);
    expect(await db.listTransactions()).toHaveLength(3);
  });

  it("keeps blocked component candidates stable on identical captures and later arrivals", async () => {
    const pendingInput = authorization("pending", {
      merchantName: "Shop X",
    });
    const oldInput = row("posted-old", {
      merchantName: "Shop Y",
      originalAmountMinor: -100,
      originalCurrency: "ILS",
    });
    const newInput = row("posted-new", {
      merchantName: "Shop Z",
      originalAmountMinor: -100,
      originalCurrency: "ILS",
    });
    await harness.capture(2, [pendingInput]);
    await harness.capture(3, [pendingInput, oldInput]);
    const pending = await harness.byKey("pending");
    const old = await harness.byKey("posted-old");
    expect(pending.pendingPostingCandidates).toEqual([old.id]);
    expect(old.pendingPostingCandidates).toEqual([pending.id]);
    const changes = await db.listEvents();
    await harness.capture(4, [pendingInput, oldInput]);
    expect((await harness.byKey("pending")).pendingPostingCandidates).toEqual([
      old.id,
    ]);
    expect(
      (await harness.byKey("posted-old")).pendingPostingCandidates,
    ).toEqual([pending.id]);
    expect(await db.listEvents()).toEqual(changes);

    const cursor = changes.at(-1)!.id;
    await harness.capture(5, [pendingInput, oldInput, newInput]);
    const fresh = await harness.byKey("posted-new");
    expect((await harness.byKey("pending")).pendingPostingCandidates).toEqual(
      [old.id, fresh.id].sort(),
    );
    expect(
      (await harness.byKey("posted-old")).pendingPostingCandidates,
    ).toEqual([pending.id]);
    const laterChanges = await db.listEvents({ after: cursor });
    expect(
      laterChanges.filter(
        (change) =>
          change.transactionId === old.id &&
          change.type.startsWith("transaction.review_"),
      ),
    ).toEqual([]);
    expect(
      laterChanges.some(
        (change) =>
          change.type === "transaction.review_resolved" ||
          change.type === "transaction.posted",
      ),
    ).toBe(false);
    expect(
      laterChanges.filter(
        (change) =>
          change.transactionId === pending.id &&
          change.type === "transaction.review_required",
      ),
    ).toMatchObject([
      {
        before: { candidates: [old.id] },
        after: { candidates: [old.id, fresh.id].sort() },
      },
    ]);

    // A correction moves the old posted row out of the current equality group.
    await harness.capture(6, [
      pendingInput,
      { ...oldInput, amountMinor: -101, originalAmountMinor: -101 },
      newInput,
    ]);
    expect((await harness.byKey("pending")).pendingPostingCandidates).toEqual([
      fresh.id,
    ]);
    expect(
      (await harness.byKey("posted-old")).pendingPostingCandidates,
    ).toEqual([]);
    expect(
      (await db.listEvents()).filter(
        (change) =>
          change.transactionId === old.id &&
          change.type === "transaction.review_resolved",
      ),
    ).toHaveLength(1);
  });

  describe.each(["exact-key", "FX"] as const)("%s review", (rule) => {
    const pendingInput = authorization("pending", {
      merchantName: "Shop X",
      currency: rule === "FX" ? "MXN" : "ILS",
    });
    const postedInput = row("posted-old", {
      merchantName: "Shop Y",
      amountMinor: rule === "FX" ? -350 : -100,
      ...(rule === "exact-key"
        ? { originalAmountMinor: -100, originalCurrency: "ILS" }
        : {}),
    });

    it.each(["failed pending partition", "stale", "equal-time"])(
      "keeps candidates stable on a %s run and the following fresh run",
      async (mode) => {
        await harness.capture(2, [pendingInput]);
        await harness.capture(3, [pendingInput, postedInput]);
        const pending = await harness.byKey("pending");
        const posted = await harness.byKey("posted-old");
        expect(pending.pendingPostingCandidates).toEqual([posted.id]);
        expect(posted.pendingPostingCandidates).toEqual([pending.id]);
        const cursor = (await db.listEvents()).at(-1)!.id;
        const partialAdapter = {
          ...postingAdapter,
          extract(...args: Parameters<typeof postingAdapter.extract>) {
            const result = postingAdapter.extract(...args);
            result.partitions = result.partitions.map((partition) =>
              partition.status === "pending"
                ? { ...partition, success: false, comparable: false }
                : partition,
            );
            return result;
          },
        };
        await harness.capture(
          mode === "failed pending partition" ? 4 : 3,
          mode === "failed pending partition"
            ? [postedInput]
            : [pendingInput, postedInput],
          mode === "failed pending partition" ? partialAdapter : postingAdapter,
          { runId: "non-fresh", hour: mode === "stale" ? "11" : "12" },
        );
        expect(
          (await harness.byKey("pending")).pendingPostingCandidates,
        ).toEqual([posted.id]);
        expect(
          (await harness.byKey("posted-old")).pendingPostingCandidates,
        ).toEqual([pending.id]);
        await harness.capture(5, [pendingInput, postedInput]);
        expect(
          (await harness.byKey("pending")).pendingPostingCandidates,
        ).toEqual([posted.id]);
        expect(
          (await harness.byKey("posted-old")).pendingPostingCandidates,
        ).toEqual([pending.id]);
        expect(
          (await db.listEvents({ after: cursor })).filter(
            (change) =>
              change.type.startsWith("transaction.review_") ||
              change.type === "transaction.posted",
          ),
        ).toEqual([]);
      },
    );

    it("does not flag an out-of-horizon pair when automatic posting is enabled", async () => {
      const rows = [pendingInput, postedInput].map((input) => ({
        ...input,
        transactionDate: "2040-05-01",
      }));
      await harness.capture(2, rows, manualPostingAdapter);
      const cursor = (await db.listEvents()).at(-1)!.id;
      await harness.capture(3, rows);
      expect(
        (await db.listTransactions()).every(
          (row) =>
            !row.reviewRequired && row.pendingPostingCandidates.length === 0,
        ),
      ).toBe(true);
      expect(
        (await db.listEvents({ after: cursor })).filter((change) =>
          change.type.startsWith("transaction.review_"),
        ),
      ).toEqual([]);
    });
  });

  it("keeps unresolved FX candidates stable without comparing billed amounts", async () => {
    const posted = row("fx", {
      merchantName: "Shop Y",
      amountMinor: -350,
      details: { ...emptyDetails(), issues: ["unsupported_original_currency"] },
    });
    await harness.capture(2, [
      authorization("pending", { merchantName: "Shop X", currency: "MXN" }),
    ]);
    await harness.capture(3, [posted]);
    const pending = await harness.byKey("pending");
    const fx = await harness.byKey("fx");
    expect(pending).toMatchObject({
      status: "pending",
      reviewRequired: true,
      pendingPostingCandidates: [fx.id],
    });
    expect(fx.pendingPostingCandidates).toEqual([pending.id]);
    const changes = await db.listEvents();
    await harness.capture(4, [posted]);
    expect((await harness.byKey("pending")).pendingPostingCandidates).toEqual([
      fx.id,
    ]);
    expect((await harness.byKey("fx")).pendingPostingCandidates).toEqual([
      pending.id,
    ]);
    expect(await db.listEvents()).toEqual(changes);
    expect(changes.some((change) => change.type === "transaction.posted")).toBe(
      false,
    );

    await harness.capture(5, [
      {
        ...posted,
        originalAmountMinor: -200,
        originalCurrency: "USD",
        details: emptyDetails(),
      },
    ]);
    expect((await harness.byKey("pending")).pendingPostingCandidates).toEqual(
      [],
    );
    expect((await harness.byKey("fx")).pendingPostingCandidates).toEqual([]);
  });

  it("keeps a split pending row vetoed against a different posted identity and allows explicit confirmation", async () => {
    const { pending, postedId } = await linked();
    await db.unlinkPendingTransaction(
      await harness.command(pending.id, postedId),
    );
    await harness.capture(4, [
      authorization(),
      row("posted", { amountMinor: -125 }),
    ]);
    await harness.capture(5, [
      row("posted", { amountMinor: -125 }),
      row("different-posted"),
    ]);
    const different = await harness.byKey("different-posted");
    expect((await db.getTransaction(pending.id))!.status).toBe("pending");
    expect(
      (await db.getTransaction(pending.id))!.pendingPostingCandidates,
    ).toContain(different.id);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toHaveLength(1);
    await db.linkPendingTransaction(
      await harness.command(pending.id, different.id),
    );
    expect(await db.getTransaction(pending.id)).toMatchObject({
      status: "posted",
      sourceKey: "different-posted",
    });
  });

  it("requires pending absence in the same run, even for a unique matching posted identity", async () => {
    await harness.capture(2, [authorization()]);
    await harness.capture(3, [row("posted"), authorization()]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(await db.listTransactions()).toHaveLength(2);
    expect((await harness.byKey("pending")).presence).toBe("seen");
  });

  it("preserves existing links when current adapter evidence is unavailable", async () => {
    await harness.capture(2, [authorization()]);
    await harness.capture(3, [row("posted")]);
    const survivor = await harness.byKey("posted");
    const changes = await db.listEvents();
    await harness.capture(4, [row("posted")], {
      ...postingAdapter,
      automaticPosting: {
        ...postingAdapter.automaticPosting!,
        compatibleGroups: () => false,
      },
    });
    expect((await harness.byKey("posted")).details.postingLink).toEqual(
      survivor.details.postingLink,
    );
    expect(await db.listEvents()).toEqual(changes);
    expect(await db.listTransactions()).toHaveLength(1);
  });

  it("never retroactively links an existing posted identity", async () => {
    await harness.capture(2, [authorization(), row("posted")]);
    await harness.capture(3, [row("posted")]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(await db.listTransactions()).toHaveLength(2);
  });

  it("partitions pending aliases and all current posted aliases on split", async () => {
    await harness.capture(2, [
      authorization("pending", { sourceAliases: ["pending-old"] }),
    ]);
    await harness.capture(3, [
      row("posted", { sourceAliases: ["posted-old"] }),
    ]);
    const survivor = await harness.byKey("posted");
    await harness.capture(4, [
      row("posted", { sourceAliases: ["posted-new-alias"] }),
    ]);
    const split = await db.unlinkPendingTransaction(
      await harness.command(
        survivor.id,
        survivor.details.postingLink!.postedId,
      ),
    );
    expect(split.pending.sourceAliases).toEqual(["pending-old"]);
    expect(new Set(split.posted.sourceAliases)).toEqual(
      new Set(["posted-old", "posted-new-alias"]),
    );
    expect(split.pending.details.rejectedPostingKeys).toEqual(
      expect.arrayContaining(["posted", "posted-old", "posted-new-alias"]),
    );
  });

  it("keeps a same-run candidate competing with a previously unlisted candidate in review", async () => {
    await harness.capture(2, [authorization("old"), authorization("new")]);
    await harness.capture(3, [authorization("new")]);
    await harness.capture(4, [row("posted")]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(
      (await harness.byKey("posted")).pendingPostingCandidates,
    ).toHaveLength(2);
  });

  it("leaves a timing gap in review instead of continuing a previously unlisted authorization", async () => {
    await harness.capture(2, [authorization()]);
    await harness.capture(3, []);
    await harness.capture(4, [row("posted")]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(
      (await harness.byKey("posted")).pendingPostingCandidates,
    ).toHaveLength(1);
  });

  it.each(["2040-06-30", "2040-07-02"])(
    "requires the same purchase date, retaining %s for review",
    async (transactionDate) => {
      await harness.capture(2, [authorization()]);
      await harness.capture(3, [row("posted", { transactionDate })]);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.posted",
        ),
      ).toEqual([]);
      expect(
        (await harness.byKey("posted")).pendingPostingCandidates,
      ).toHaveLength(1);
    },
  );

  it("keeps installment purchases separate through ingestion", async () => {
    await harness.capture(2, [
      authorization("pending", { installmentCount: 2 }),
    ]);
    await harness.capture(3, [row("posted", { installmentCount: 2 })]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(await db.listTransactions()).toHaveLength(2);
  });

  it.each([0, 1])(
    "keeps ordinary CAL ordinal %i conservative when its source installment count is zero",
    async (curPaymentNum) => {
      const first = JSON.parse(fixture("recent-01"));
      const second = JSON.parse(fixture("recent-02"));
      const pendingSource = first.result.clearanceRequests.find(
        (source: Record<string, unknown>) =>
          source.transactionID === "SYNTHETIC-AUTH-PENDING-POSTED",
      );
      const postedSource = second.result.transactions.find(
        (source: Record<string, unknown>) =>
          source.trnIntId === "SYNTHETIC-TXN-PENDING-POSTED",
      );
      Object.assign(postedSource, {
        trnPurchaseDate: pendingSource.trnPurchaseDate,
        transCardPresentInd: pendingSource.transCardPresentInd,
        amountForDisplay: pendingSource.trnAmt,
        trnAmt: pendingSource.trnAmt,
        transactionTypeCode: 5,
        numOfPayments: 0,
        curPaymentNum,
      });
      first.result.transactions = [];
      first.result.clearanceRequests = [pendingSource];
      second.result.transactions = [postedSource];
      second.result.clearanceRequests = [];
      for (const [index, envelope] of [first, second].entries()) {
        await db.ingestRun(
          {
            debugArchiveDays: 2,
            connectionId: harness.connectionId,
            runId: `cal-ordinal-${index}`,
            responses: [
              {
                accountKey: "account",
                endpoint: "synthetic:cal/recent",
                capturedAt: `2040-06-${index + 12}T12:00:00Z`,
                responseText: JSON.stringify(envelope),
              },
            ],
          },
          calAdapter,
        );
      }
      const current = await db.listTransactions();
      const posted = current.find(
        (transaction) => transaction.status === "posted",
      )!;
      expect(posted).toMatchObject({
        installmentCount: null,
        installmentNumber: null,
        purchaseId: null,
      });
      expect(calPostingEvidence(posted)).not.toBeNull();
      expect(posted.details.provider.cal!.rows).toMatchObject([
        {
          transactionTypeCode: "5",
          numOfPayments: "0",
          curPaymentNum: String(curPaymentNum),
        },
      ]);
      const archived = await db.raw(
        "SELECT snapshot_json FROM sync_run_bodies WHERE run_id=?",
        ["cal-ordinal-1"],
      );
      expect(
        JSON.parse(String(archived[0]!.snapshot_json)).responses[0]
          .responseText,
      ).toBe(JSON.stringify(second));
      if (curPaymentNum === 0) {
        expect(current).toHaveLength(1);
        expect(posted.details.postingLink?.automatic).toBe(true);
      } else {
        expect(current).toHaveLength(2);
        expect(
          current.find((transaction) => transaction.status === "pending"),
        ).toMatchObject({ presence: "not_returned" });
        expect(posted.details.issues).toContain("unknown_installment_count");
        expect(posted.reviewRequired).toBe(true);
        expect(posted.details.postingLink).toBeUndefined();
        expect(
          (await db.listEvents()).some((change) =>
            ["transaction.posted", "transaction.linked"].includes(change.type),
          ),
        ).toBe(false);
      }
    },
  );

  it("does not infer pending absence outside the adapter horizon", async () => {
    const transactionDate = "2040-04-01";
    await harness.capture(2, [authorization("pending", { transactionDate })]);
    await harness.capture(3, [row("posted", { transactionDate })]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect(await harness.byKey("pending")).toMatchObject({
      status: "pending",
      presence: "seen",
    });
  });

  it.each([
    ["pending", false, true],
    ["posted", false, true],
    ["pending", true, false],
  ] as const)(
    "requires a successful comparable %s partition (success=%s, comparable=%s)",
    async (status, success, comparable) => {
      await harness.capture(2, [authorization()]);
      const partial = {
        ...postingAdapter,
        extract: (
          text: string,
          context: Parameters<typeof postingAdapter.extract>[1],
        ) => {
          const result = postingAdapter.extract(text, context);
          const partition = result.partitions.find(
            (partition) => partition.status === status,
          )!;
          partition.success = success;
          partition.comparable = comparable;
          return result;
        },
      };
      await harness.capture(3, [row("posted")], partial);
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.posted",
        ),
      ).toEqual([]);
    },
  );

  it("never continues from a malformed extracted pending partition", async () => {
    await harness.capture(2, [authorization()]);
    await harness.capture(3, [
      row("posted"),
      authorization("invalid", { amountMinor: null, currency: "ILS" }),
    ]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
    expect((await harness.byKey("pending")).presence).toBe("seen");
  });

  it("applies the empty-list rejection before any continuation", async () => {
    await harness.capture(2, [row("old"), authorization()]);
    const before = await harness.state();
    expect(await harness.capture(3, [])).toMatchObject({
      status: "failed",
      failureCode: "implausible_empty",
    });
    expect(await harness.state()).toEqual(before);
  });

  it.each(["link", "split"])(
    "rolls back the complete %s change set when audit persistence fails",
    async (operation) => {
      await harness.capture(2, [authorization()]);
      if (operation === "split") {
        await harness.capture(3, [row("posted")]);
      }
      const before = await harness.state();
      const failureKind =
        operation === "link" ? "transaction.linked" : "transaction.unlinked";
      if (backend === "postgres") {
        await db.raw(
          `CREATE FUNCTION reject_posting_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = '${failureKind}' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`,
        );
        await db.raw(
          "CREATE TRIGGER reject_posting_audit BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_posting_audit()",
        );
      } else {
        await db.raw(
          `CREATE TRIGGER reject_posting_audit BEFORE INSERT ON events WHEN NEW.type = '${failureKind}' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`,
        );
      }
      const survivor =
        operation === "split" ? await harness.byKey("posted") : undefined;
      const command = survivor
        ? await harness.command(
            survivor.id,
            survivor.details.postingLink!.postedId,
          )
        : undefined;
      await expect(
        operation === "link"
          ? harness.capture(3, [row("posted")])
          : db.unlinkPendingTransaction(command!),
      ).rejects.toThrow();
      expect(await harness.state()).toEqual(before);
      await db.raw(
        backend === "postgres"
          ? "DROP TRIGGER reject_posting_audit ON events"
          : "DROP TRIGGER reject_posting_audit",
      );
      if (operation === "link") {
        expect(await db.applyRun("posting-3", postingAdapter)).toMatchObject({
          updated: 1,
          created: 0,
        });
      } else {
        await db.unlinkPendingTransaction(command!);
      }
    },
  );

  it.each([false, true])(
    "excludes stale and equal-time captures: equal %s",
    async (equal) => {
      await harness.capture(3, [authorization()]);
      await harness.capture(equal ? 3 : 2, [row("posted")], postingAdapter, {
        runId: "different-run",
      });
      expect(
        (await db.listEvents()).filter(
          (change) => change.type === "transaction.posted",
        ),
      ).toEqual([]);
    },
  );

  it.each([
    [{}, ["authorizationMethod"], null],
    [{ authorizationMethod: "online" as const }, undefined, "online"],
  ])(
    "keeps a pending conflict through a manual link unless the posted row states the field (%j)",
    async (postedFacts, conflicts, authorizationMethod) => {
      const conflicted = emptyDetails();
      conflicted.issues = ["conflicting_payment_context"];
      await harness.capture(
        2,
        [
          authorization("pending", {
            authorizationMethod: null,
            details: conflicted,
          }),
        ],
        manualPostingAdapter,
      );
      await harness.capture(
        3,
        [row("posted", { wallet: "apple_pay", ...postedFacts })],
        manualPostingAdapter,
      );
      const pending = await harness.byKey("pending");
      const posted = await harness.byKey("posted");
      expect(pending.details.paymentContextConflicts).toEqual([
        "authorizationMethod",
      ]);
      const cursor = await db.latestEventId();
      const survivor = await db.linkPendingTransaction(
        await harness.command(pending.id, posted.id),
      );
      expect(survivor).toMatchObject({
        id: pending.id,
        authorizationMethod,
        wallet: "apple_pay",
      });
      expect(survivor.details.paymentContextConflicts).toEqual(conflicts);
      expect(
        survivor.details.issues.includes("conflicting_payment_context"),
      ).toBe(conflicts !== undefined);
      const resolved = (await db.listEvents({ after: cursor })).filter(
        (event) =>
          event.type === "transaction.review_resolved" &&
          event.transactionId === pending.id,
      );
      expect(resolved).toHaveLength(conflicts ? 0 : 1);
    },
  );

  it("keeps history and adapters without capability outside the automatic policy", async () => {
    await harness.capture(2, [authorization()]);
    await harness.capture(3, [row("historical")], postingAdapter, {
      history: true,
    });
    await harness.capture(4, [row("posted")], manualPostingAdapter);
    await harness.capture(5, [row("posted")]);
    expect(
      (await db.listEvents()).filter(
        (change) => change.type === "transaction.posted",
      ),
    ).toEqual([]);
  });

  it("plans an unapplied same-parser archive using current policy and recovers exactly once", async () => {
    await harness.capture(2, [authorization()]);
    await expect(
      harness.capture(3, [row("posted")], {
        ...postingAdapter,
        extract: () => {
          throw new Error("synthetic crash after archive");
        },
      }),
    ).rejects.toThrow("synthetic crash after archive");
    expect((await db.listTransactions())[0]!.status).toBe("pending");
    expect(await db.applyRun("posting-3", postingAdapter)).toMatchObject({
      created: 0,
      updated: 1,
    });
    const before = await harness.state();
    expect(await db.applyRun("posting-3", postingAdapter)).toMatchObject({
      replayed: true,
    });
    expect(await harness.state()).toEqual(before);
  });

  it("blocks unapplied cal-v5 archives under cal-v14 without changing evidence or financial state", async () => {
    await expect(
      db.ingestRun(
        {
          debugArchiveDays: 2,
          connectionId: harness.connectionId,
          runId: "cal-v5-unapplied",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:cal/recent",
              capturedAt: "2040-07-02T12:00:00Z",
              responseText: fixture("recent-01"),
            },
          ],
        },
        {
          ...calAdapter,
          parserVersion: "cal-v5",
          extract() {
            throw new Error("synthetic archive-only failure");
          },
        },
      ),
    ).rejects.toThrow("synthetic archive-only failure");
    const before = await harness.state();
    const runs = await db.listSyncRuns(harness.connectionId, {
      limit: 20,
    });
    expect(calAdapter.parserVersion).toBe("cal-v14");
    await expect(db.applyRun("cal-v5-unapplied", calAdapter)).rejects.toThrow(
      "Run parser version differs from adapter",
    );
    expect(await harness.state()).toEqual(before);
    expect(await db.listSyncRuns(harness.connectionId, { limit: 20 })).toEqual(
      runs,
    );
  });

  it.each([
    "expectedPendingVersion",
    "expectedPostedVersion",
    "expectedPendingAnnotationVersion",
    "expectedPostedAnnotationVersion",
  ] as const)(
    "rejects split %s conflicts without partial writes",
    async (field) => {
      const { pending, postedId } = await linked();
      const before = await harness.state();
      await expect(
        db.unlinkPendingTransaction({
          ...(await harness.command(pending.id, postedId)),
          [field]: 100,
        }),
      ).rejects.toThrow(ConflictError);
      expect(await harness.state()).toEqual(before);
    },
  );

  it("splits explicit confirmation using current facts and retains each annotation document", async () => {
    await harness.capture(
      2,
      [authorization(), row("posted")],
      manualPostingAdapter,
    );
    const pending = await harness.byKey("pending");
    const posted = await harness.byKey("posted");
    await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      notes: "Explicit note",
    });
    await db.linkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    await harness.capture(3, [
      row("posted", { amountMinor: -120 }),
      authorization(),
    ]);
    const before = await harness.state();
    const result = await db.unlinkPendingTransaction(
      await harness.command(pending.id, posted.id),
    );
    expect(result.pending).toMatchObject({
      status: "pending",
      presence: "seen",
      amountMinor: -100,
    });
    expect(result.posted).toMatchObject({
      status: "posted",
      presence: "seen",
      amountMinor: -120,
    });
    for (const row of before.rows) {
      expect((await db.getTransaction(row.id))!.annotation).toEqual(
        row.annotation,
      );
    }
  });

  it("derives split presence from each side's evidence after pending reappearance and posted removal", async () => {
    const { pending, postedId } = await linked();
    await harness.capture(4, [row("posted"), authorization()]);
    const survivor = (await db.getTransaction(pending.id))!;
    await db.confirmRemoval({
      transactionId: survivor.id,
      expectedVersion: survivor.version,
      reason: "Owner verified posted duplicate",
    });
    const split = await db.unlinkPendingTransaction(
      await harness.command(pending.id, postedId),
    );
    expect(split.pending.presence).toBe("seen");
    expect(split.posted.presence).toBe("removed");
  });

  it("keeps historical pending alias references on the pending side without restoring its presence", async () => {
    const { pending, postedId } = await linked();
    await harness.capture(4, [row("posted")]);
    await harness.capture(5, [authorization()], postingAdapter, {
      history: true,
    });
    const split = await db.unlinkPendingTransaction(
      await harness.command(pending.id, postedId),
    );
    expect(split.pending.presence).toBe("not_returned");
    expect(split.posted.presence).toBe("seen");
    expect(split.pending.details.sourceRefs.map((ref) => ref.runId)).toEqual([
      "posting-2",
      "posting-5",
    ]);
    expect(split.posted.details.sourceRefs.map((ref) => ref.runId)).toEqual([
      "posting-4",
    ]);
  });

  it("exposes a posted approval as stale after split without rewriting its document", async () => {
    const { survivor, postedId } = await linked();
    const annotation = await db.editAnnotation({
      transactionId: survivor.id,
      expectedVersion: 1,
      expectedTransactionVersion: survivor.version,
      review: { status: "approved" },
    });
    const command = await harness.command(survivor.id, postedId);
    const result = await db.unlinkPendingTransaction(command);
    expect(await db.getTransaction(survivor.id)).toMatchObject({
      annotation,
      reviewStale: true,
      reviewRequired: true,
    });
    expect(await db.unlinkPendingTransaction(command)).toEqual(result);
  });

  it("rejects legacy links without before-state provenance without inventing pending facts", async () => {
    const { survivor, postedId } = await linked();
    await db.raw(
      "UPDATE transaction_posting_links SET posting_link_json=NULL WHERE transaction_id=?",
      [survivor.id],
    );
    const before = await harness.state();
    await expect(
      db.unlinkPendingTransaction(await harness.command(survivor.id, postedId)),
    ).rejects.toThrow("Link provenance is unavailable");
    expect(await harness.state()).toEqual(before);
  });

  it.each([
    {
      name: "ILS purchase",
      symbol: "₪",
      billed: "ILS",
      original: "ILS",
      pendingAmount: 23.47,
      postedAmount: 23.47,
      refund: false,
      links: true,
    },
    {
      name: "USD purchase with sign normalization",
      symbol: "$",
      billed: "USD",
      original: "USD",
      pendingAmount: 23.47,
      postedAmount: 23.47,
      refund: false,
      links: true,
    },
    {
      name: "MXN purchase billed in ILS",
      symbol: "MXN",
      billed: "ILS",
      original: "MXN",
      pendingAmount: 23.47,
      postedAmount: 5.89,
      refund: false,
      links: true,
    },
    {
      name: "equal numbers in different currencies",
      symbol: "MXN",
      billed: "ILS",
      original: "USD",
      pendingAmount: 23.47,
      postedAmount: 23.47,
      refund: false,
      links: false,
    },
    {
      name: "original money overrides otherwise equal billed money",
      symbol: "$",
      billed: "USD",
      original: "MXN",
      pendingAmount: 23.47,
      postedAmount: 23.47,
      refund: false,
      links: false,
    },
    {
      name: "FX purchase without original money",
      symbol: "MXN",
      billed: "ILS",
      original: null,
      pendingAmount: 23.47,
      postedAmount: 23.47,
      refund: false,
      links: false,
    },
    {
      name: "same-currency fallback without original money",
      symbol: "$",
      billed: "USD",
      original: null,
      pendingAmount: 23.47,
      postedAmount: 23.47,
      refund: false,
      links: true,
    },
    {
      name: "signed refund",
      symbol: "$",
      billed: "USD",
      original: "USD",
      pendingAmount: -23.47,
      postedAmount: -23.47,
      refund: true,
      links: true,
    },
    {
      name: "refund versus equal-magnitude purchase",
      symbol: "$",
      billed: "USD",
      original: "USD",
      pendingAmount: -23.47,
      postedAmount: 23.47,
      refund: false,
      links: false,
    },
  ])(
    "uses CAL extraction and purchase money for $name",
    async ({
      symbol,
      billed,
      original,
      pendingAmount,
      postedAmount,
      refund,
      links,
    }) => {
      const first = JSON.parse(fixture("recent-01"));
      const second = JSON.parse(fixture("recent-02"));
      const pendingSource = first.result.clearanceRequests.find(
        (row: Record<string, unknown>) =>
          row.transactionID === "SYNTHETIC-AUTH-PENDING-POSTED",
      );
      const postedSource = second.result.transactions.find(
        (row: Record<string, unknown>) =>
          row.trnIntId === "SYNTHETIC-TXN-PENDING-POSTED",
      );
      postedSource.trnPurchaseDate = pendingSource.trnPurchaseDate;
      // Invented continuation: the base fixtures deliberately differ on presence.
      postedSource.transCardPresentInd = pendingSource.transCardPresentInd;
      pendingSource.trnCurrencySymbol = symbol;
      pendingSource.trnAmt = pendingAmount;
      pendingSource.trnTypeCode = pendingAmount < 0 ? "6" : "5";
      const billingCodes: Record<string, number> = { ILS: 3, USD: 1 };
      const currencySymbols: Record<string, string> = {
        ILS: "₪",
        USD: "$",
        MXN: "MXN",
      };
      const isoCodes: Record<string, string> = {
        ILS: "376",
        USD: "840",
        MXN: "484",
      };
      postedSource.debCrdCurrencyCode = billingCodes[billed];
      postedSource.currencyForDisplay = currencySymbols[billed];
      postedSource.debCrdCurrencySymbol = currencySymbols[billed];
      postedSource.amountForDisplay = postedAmount;
      postedSource.trnCurrencyIsoCode = original ? isoCodes[original] : null;
      postedSource.srcCurrencyCode = original ? isoCodes[original] : "";
      postedSource.transOriginalCurrencyCode = null;
      postedSource.trnCurrencySymbol = original
        ? currencySymbols[original]
        : null;
      postedSource.trnAmt = 23.47;
      postedSource.transactionTypeCode = refund ? 6 : 5;
      postedSource.refundInd = refund;
      first.result.transactions = [];
      first.result.clearanceRequests = [pendingSource];
      second.result.transactions = [postedSource];
      second.result.clearanceRequests = [];

      async function calCapture(runId: string, day: number, envelope: unknown) {
        return db.ingestRun(
          {
            debugArchiveDays: 2,
            connectionId: harness.connectionId,
            runId,
            responses: [
              {
                accountKey: "account",
                endpoint: "synthetic:cal/recent",
                capturedAt: `2040-08-0${day}T12:00:00Z`,
                responseText: JSON.stringify(envelope),
              },
            ],
          },
          calAdapter,
        );
      }

      await calCapture("cal-first", 1, first);
      const pending = (await db.listTransactions())[0]!;
      await calCapture("cal-second", 2, second);
      const survivor = (await db.getTransaction(pending.id))!;
      expect(survivor.status).toBe(links ? "posted" : "pending");
      if (links) {
        expect(survivor.details.postingLink?.automatic).toBe(true);
        expect(survivor.amountMinor).toBe(
          refund ? 2347 : -Math.round(postedAmount * 100),
        );
        expect(survivor.currency).toBe(billed);
      } else {
        expect(survivor.presence).toBe("not_returned");
        if (original === null) {
          // Missing original money with different pending/billing currencies is review evidence.
          expect(survivor.pendingPostingCandidates).toHaveLength(1);
        }
        expect(
          (await harness.state()).changes.some(
            (change) => change.type === "transaction.posted",
          ),
        ).toBe(false);
      }
    },
  );
});
