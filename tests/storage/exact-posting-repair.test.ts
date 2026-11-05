import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TransactionInput } from "../../src/domain/model.js";
import {
  REPAIR_MAX_ACCOUNT_ROWS,
  REPAIR_MAX_D1_ACCOUNT_ROWS,
} from "../../src/domain/plans/exact-posting-repair.js";
import {
  authorization,
  postingAdapter,
  postingHarness,
} from "../helpers/posting.js";
import {
  backends,
  type Harness,
  insertTransactionFixture,
  open,
  row,
} from "../helpers/storage-harness.js";

describe.each(backends)("%s exact repair", (backend) => {
  let db: Harness;
  let h: ReturnType<typeof postingHarness>;
  beforeEach(async () => {
    db = await open(backend);
    h = postingHarness(db);
    await db.ensureConnection({ id: h.connectionId, provider: "cal" });
  });
  afterEach(async () => db.close());
  const { automaticPosting: _automaticPosting, ...noAutomatic } =
    postingAdapter;
  const base = {
    from: "2040-07-01",
    to: "2040-07-31",
    reason: "Repair exact historical match",
  };

  async function setup(
    posted: Partial<TransactionInput> = {},
    extras: TransactionInput[] = [],
  ) {
    await h.capture(2, [authorization()], noAutomatic);
    await h.capture(3, [row("posted", posted), ...extras], noAutomatic);
    return {
      pending: await h.byKey("pending"),
      posted: await h.byKey("posted"),
    };
  }

  it("previews without writing, applies atomically, and does not relink an owner split", async () => {
    const { pending, posted } = await setup();
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Synthetic note",
    });
    const before = await h.state();
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    expect(preview.pairs).toHaveLength(1);
    expect(await h.state()).toEqual(before);
    expect(
      await db.repairExactPostings({
        ...command,
        mode: "apply",
        expected: preview.pairs,
      }),
    ).toEqual({ mode: "apply", pairs: preview.pairs });
    expect(await db.getTransaction(pending.id)).toMatchObject({
      status: "posted",
      annotation: { data: { notes: "Synthetic note" } },
    });
    expect((await db.getTransaction(posted.id))!.supersededById).toBe(
      pending.id,
    );
    expect(
      (await db.listEvents()).filter(
        (event) => event.type === "transaction.linked",
      ),
    ).toHaveLength(1);
    expect(
      (await db.repairExactPostings({ ...command, mode: "preview" })).pairs,
    ).toEqual([]);
    await db.unlinkPendingTransaction(await h.command(pending.id, posted.id));
    expect(
      (await db.repairExactPostings({ ...command, mode: "preview" })).pairs,
    ).toEqual([]);
  });
  it.each([
    ["merchant", { merchantName: "Different" }],
    ["date", { transactionDate: "2040-07-02" }],
    ["amount", { amountMinor: -101 }],
    ["currency", { currency: "USD" }],
    ["card", { cardKey: "another-card" }],
    ["installment", { installmentNumber: 1 }],
    ["unknown amount basis", { amountBasis: "unknown" }],
    ["booked-entry amount basis", { amountBasis: "booked_entry" }],
    [
      "conflicting original amount",
      { originalAmountMinor: -200, originalCurrency: "ILS" },
    ],
  ] satisfies [string, Partial<TransactionInput>][])(
    "skips %s",
    async (_label, fields) => {
      const { pending } = await setup(fields);
      expect(
        (
          await db.repairExactPostings({
            ...base,
            transactionId: pending.id,
            mode: "preview",
          })
        ).pairs,
      ).toEqual([]);
    },
  );
  it("counts unsupported same-merchant contenders before eligibility", async () => {
    const { pending } = await setup({}, [
      row("other", { installmentNumber: 1 }),
    ]);
    expect(
      (
        await db.repairExactPostings({
          ...base,
          transactionId: pending.id,
          mode: "preview",
        })
      ).pairs,
    ).toEqual([]);
  });
  it("blocks an FX contender whose original purchase money matches", async () => {
    await h.capture(
      2,
      [authorization("pending", { currency: "USD" })],
      noAutomatic,
    );
    await h.capture(
      3,
      [
        row("posted", { currency: "USD" }),
        row("fx", {
          amountMinor: -350,
          currency: "ILS",
          originalAmountMinor: -100,
          originalCurrency: "USD",
        }),
      ],
      noAutomatic,
    );
    const pending = await h.byKey("pending");
    expect(
      (
        await db.repairExactPostings({
          ...base,
          transactionId: pending.id,
          mode: "preview",
        })
      ).pairs,
    ).toEqual([]);
  });
  it("distinguishes a known different merchant with the same money and date", async () => {
    const { pending } = await setup({}, [
      row("different", { merchantName: "Different merchant" }),
    ]);
    expect(
      (
        await db.repairExactPostings({
          ...base,
          transactionId: pending.id,
          mode: "preview",
        })
      ).pairs,
    ).toHaveLength(1);
  });
  it.each([
    ["missing card", { cardKey: null }],
    ["missing date", { transactionDate: null }],
    ["missing merchant", { merchantName: null }],
    ["non-meaningful merchant", { merchantName: "???" }],
  ] satisfies [string, Partial<TransactionInput>][])(
    "treats a contender with %s as uncertain, not absent",
    async (_label, fields) => {
      const { pending } = await setup({}, [row("uncertain", fields)]);
      expect(
        (
          await db.repairExactPostings({
            ...base,
            transactionId: pending.id,
            mode: "preview",
          })
        ).pairs,
      ).toEqual([]);
    },
  );
  it("blocks an existing contender with unknown money", async () => {
    const { pending, posted } = await setup();
    const original = (await db.getTransaction(posted.id))!;
    await insertTransactionFixture(db, [
      {
        ...original,
        id: "unknown-money",
        sourceKey: "unknown-money",
        sourceAliases: [],
        amountMinor: null,
        currency: null,
      },
    ]);
    expect(
      (
        await db.repairExactPostings({
          ...base,
          transactionId: pending.id,
          mode: "preview",
        })
      ).pairs,
    ).toEqual([]);
  });
  it("rejects an oversized pair set without writes", async () => {
    const pendingRows = Array.from({ length: 21 }, (_, i) =>
      authorization(`pending-${i}`, { amountMinor: -100 - i }),
    );
    const postedRows = Array.from({ length: 21 }, (_, i) =>
      row(`posted-${i}`, { amountMinor: -100 - i }),
    );
    await h.capture(2, pendingRows, noAutomatic);
    await h.capture(3, postedRows, noAutomatic);
    const pending = await h.byKey("pending-0");
    const before = await h.state();
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow("too many pairs");
    expect(await h.state()).toEqual(before);
  });
  it("rolls back every write when event insertion fails", async () => {
    const { pending } = await setup();
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    const before = await h.state();
    if (backend === "postgres") {
      await db.raw(
        "CREATE FUNCTION fail_repair_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END; $$",
      );
      await db.raw(
        "CREATE TRIGGER fail_repair_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION fail_repair_event()",
      );
    } else {
      await db.raw(
        "CREATE TRIGGER fail_repair_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
      );
    }
    await expect(
      db.repairExactPostings({
        ...command,
        mode: "apply",
        expected: preview.pairs,
      }),
    ).rejects.toThrow();
    expect(await h.state()).toEqual(before);
  });
  it("requires an accepted pending absence and a current posted record", async () => {
    const { pending, posted } = await setup();
    const command = {
      ...base,
      transactionId: pending.id,
      mode: "preview" as const,
    };
    expect((await db.repairExactPostings(command)).pairs).toHaveLength(1);
    const pendingRecord = (await db.getTransaction(pending.id))!;
    const postedRecord = (await db.getTransaction(posted.id))!;
    await insertTransactionFixture(
      db,
      [{ ...pendingRecord, sourceAbsence: undefined, presence: "seen" }],
      "update",
    );
    expect((await db.repairExactPostings(command)).pairs).toEqual([]);
    await insertTransactionFixture(db, [pendingRecord], "update");
    await insertTransactionFixture(
      db,
      [
        {
          ...postedRecord,
          sourceAbsence: pendingRecord.sourceAbsence,
          presence: "not_returned",
        },
      ],
      "update",
    );
    expect((await db.repairExactPostings(command)).pairs).toEqual([]);
  });
  it.each([
    ["invalid absence", "not-a-time", "2040-07-03T08:00:00Z", 0],
    ["partial absence", "1", "2040-07-03T08:00:00Z", 0],
    [
      "invalid calendar date",
      "2040-02-30T00:00:00Z",
      "2040-01-01T00:00:00Z",
      0,
    ],
    ["invalid last seen", "2040-07-03T12:00:00Z", "not-a-time", 0],
    [
      "offset earlier despite lexical order",
      "2040-07-03T13:00:00+05:00",
      "2040-07-03T09:00:00Z",
      0,
    ],
    [
      "equal instants with offsets",
      "2040-07-03T07:00:00-05:00",
      "2040-07-03T12:00:00.000Z",
      1,
    ],
    [
      "offset later despite lexical order",
      "2040-07-03T07:00:00-05:00",
      "2040-07-03T08:00:00Z",
      1,
    ],
  ])(
    "compares absence instants: %s",
    async (_label, capturedAt, lastSeenAt, count) => {
      const { pending } = await setup();
      const record = (await db.getTransaction(pending.id))!;
      await insertTransactionFixture(
        db,
        [
          {
            ...record,
            sourceAbsence: {
              ...record.sourceAbsence!,
              capturedAt: capturedAt as string,
            },
            lastSeenAt: lastSeenAt as string,
          },
        ],
        "update",
      );
      expect(
        (
          await db.repairExactPostings({
            ...base,
            transactionId: pending.id,
            mode: "preview",
          })
        ).pairs,
      ).toHaveLength(count as number);
    },
  );
  it("does not use identities retired from matching", async () => {
    const { pending } = await setup();
    const record = (await db.getTransaction(pending.id))!;
    await insertTransactionFixture(
      db,
      [
        {
          ...record,
          sourceEvidence: {
            ...record.sourceEvidence,
            identity: {
              ...record.sourceEvidence?.identity,
              retiredFromMatching: true,
            },
          },
        },
      ],
      "update",
    );
    expect(
      (
        await db.repairExactPostings({
          ...base,
          transactionId: pending.id,
          mode: "preview",
        })
      ).pairs,
    ).toEqual([]);
  });
  it("does not load or overwrite a large connection configuration", async () => {
    const { pending } = await setup();
    const config = JSON.stringify({
      schemaVersion: 1,
      synthetic: "x".repeat(200000),
    });
    await db.raw("UPDATE connections SET config_json = ? WHERE id = ?", [
      config,
      h.connectionId,
    ]);
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    expect(preview.pairs).toHaveLength(1);
    await db.repairExactPostings({
      ...command,
      mode: "apply",
      expected: preview.pairs,
    });
    expect(
      (
        await db.raw("SELECT config_json FROM connections WHERE id = ?", [
          h.connectionId,
        ])
      )[0]!.config_json,
    ).toBe(config);
  });
  it("handles a large date window without hydrating unrelated postings", async () => {
    const { pending, posted } = await setup();
    const source = (await db.getTransaction(posted.id))!;
    await insertTransactionFixture(
      db,
      Array.from({ length: 1000 }, (_, i) => ({
        ...source,
        id: `unrelated-${i}`,
        sourceKey: `unrelated-${i}`,
        sourceAliases: [],
        amountMinor: -1000 - i,
        details: { ...source.details, pendingPostingCandidates: [] },
      })),
    );
    expect(
      (
        await db.repairExactPostings({
          ...base,
          transactionId: pending.id,
          mode: "preview",
        })
      ).pairs,
    ).toHaveLength(1);
  }, 30000);
  it("fails closed if an account record is missing a required companion row", async () => {
    const { pending } = await setup({}, [row("other")]);
    const other = await h.byKey("other");
    await db.raw(
      "DELETE FROM transaction_reconciliation WHERE transaction_id = ?",
      [other.id],
    );
    const events = (await db.listEvents()).length;
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow("incomplete transaction records");
    expect((await db.listEvents()).length).toBe(events);
  });
  it("rejects oversized malformed JSON before decoding it", async () => {
    if (backend === "d1-local") {
      return;
    }
    const { pending } = await setup();
    if (backend !== "postgres") {
      await db.raw("PRAGMA ignore_check_constraints = ON");
    }
    try {
      await db.raw(
        "UPDATE transactions SET source_aliases_json = ? WHERE id = ?",
        ["[" + "x".repeat(2050), pending.id],
      );
    } finally {
      if (backend !== "postgres") {
        await db.raw("PRAGMA ignore_check_constraints = OFF");
      }
    }
    const events = (await db.listEvents()).length;
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow("narrow field exceeds");
    expect((await db.listEvents()).length).toBe(events);
  });
  it("rejects an oversized projected merchant before planning", async () => {
    const { pending, posted } = await setup();
    const source = (await db.getTransaction(posted.id))!;
    await insertTransactionFixture(db, [
      {
        ...source,
        id: "long-merchant",
        sourceKey: "long-merchant",
        sourceAliases: [],
        merchantName: "x".repeat(2050),
      },
    ]);
    const events = (await db.listEvents()).length;
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow("narrow field exceeds");
    expect((await db.listEvents()).length).toBe(events);
  });
  it("rejects oversized selected provider evidence before decoding or writing", async () => {
    const { pending, posted } = await setup();
    await db.raw("UPDATE transactions SET provider_json = ? WHERE id = ?", [
      JSON.stringify({ cal: { retained: { text: "x".repeat(17000) } } }),
      posted.id,
    ]);
    const events = (await db.listEvents()).length;
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow("hydrated field exceeds");
    expect((await db.listEvents()).length).toBe(events);
  });
  it("fails closed when escaped legacy evidence hides retired identity", async () => {
    const { pending } = await setup();
    await db.raw(
      "UPDATE transaction_reconciliation SET source_evidence_json = ? WHERE transaction_id = ?",
      ['{"identity":{"\\u0072etiredFromMatching":true}}', pending.id],
    );
    const events = (await db.listEvents()).length;
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow();
    expect((await db.listEvents()).length).toBe(events);
  });
  it("fails closed on noncanonical link evidence", async () => {
    const { pending } = await setup();
    await db.raw(
      "UPDATE transaction_posting_links SET posting_link_json = ? WHERE transaction_id = ?",
      ["  {}", pending.id],
    );
    const events = (await db.listEvents()).length;
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow();
    expect((await db.listEvents()).length).toBe(events);
  });
  it("fails closed if legacy provider identity differs from its projection", async () => {
    const { pending } = await setup();
    await db.raw("UPDATE transactions SET provider_json = ? WHERE id = ?", [
      JSON.stringify({ cal: { identity: { legacy: "synthetic" } } }),
      pending.id,
    ]);
    const events = (await db.listEvents()).length;
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow();
    expect((await db.listEvents()).length).toBe(events);
  });
  it("hydrates and retargets billed-line and candidate-reference dependencies", async () => {
    const { pending, posted } = await setup();
    const source = (await db.getTransaction(posted.id))!;
    await insertTransactionFixture(db, [
      {
        ...source,
        id: "dependent-line",
        sourceKey: "dependent-line",
        sourceAliases: [],
        purchaseId: posted.id,
        installmentNumber: 1,
        transactionDate: "2040-06-01",
        details: { ...source.details, pendingPostingCandidates: [] },
      },
      {
        ...source,
        id: "dependent-review",
        sourceKey: "dependent-review",
        sourceAliases: [],
        transactionDate: "2040-06-02",
        details: {
          ...source.details,
          pendingPostingCandidates: [posted.id],
          issues: ["possible_pending_posted_match"],
        },
      },
    ]);
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    await db.repairExactPostings({
      ...command,
      mode: "apply",
      expected: preview.pairs,
    });
    expect((await db.getTransaction("dependent-line"))!.purchaseId).toBe(
      pending.id,
    );
    expect(
      (await db.getTransaction("dependent-review"))!.details
        .pendingPostingCandidates,
    ).not.toContain(posted.id);
  });
  it("aborts rather than partially writing when dependencies exceed hydration cap", async () => {
    const { pending, posted } = await setup();
    const source = (await db.getTransaction(posted.id))!;
    await insertTransactionFixture(
      db,
      Array.from({ length: 101 }, (_, i) => ({
        ...source,
        id: `line-${i}`,
        sourceKey: `line-${i}`,
        sourceAliases: [],
        purchaseId: posted.id,
        installmentNumber: i + 1,
        transactionDate: "2040-06-01",
        details: { ...source.details, pendingPostingCandidates: [] },
      })),
    );
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    const before = await h.state();
    await expect(
      db.repairExactPostings({
        ...command,
        mode: "apply",
        expected: preview.pairs,
      }),
    ).rejects.toThrow("hydration limit");
    expect(await h.state()).toEqual(before);
  });
  it("skips conflicting annotations", async () => {
    const { pending, posted } = await setup();
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "One",
    });
    await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      notes: "Two",
    });
    expect(
      (
        await db.repairExactPostings({
          ...base,
          transactionId: pending.id,
          mode: "preview",
        })
      ).pairs,
    ).toEqual([]);
  });
  it("rejects stale previews after annotation changes without writing", async () => {
    const { pending } = await setup();
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      notes: "Changed",
    });
    const before = await h.state();
    await expect(
      db.repairExactPostings({
        ...command,
        mode: "apply",
        expected: preview.pairs,
      }),
    ).rejects.toThrow();
    expect(await h.state()).toEqual(before);
  });
  it("aborts when the complete account exceeds the row limit", async () => {
    const { pending } = await setup();
    const source = (await db.getTransaction(pending.id))!;
    const limit =
      backend === "d1-local"
        ? REPAIR_MAX_D1_ACCOUNT_ROWS
        : REPAIR_MAX_ACCOUNT_ROWS;
    const rows = Array.from({ length: limit - 1 }, (_, index) => ({
      ...source,
      id: `overflow-${index}`,
      sourceKey: `overflow-key-${index}`,
      sourceAliases: [],
      transactionDate: "2040-06-01",
      details: { ...source.details, pendingPostingCandidates: [] },
    }));
    await insertTransactionFixture(db, rows);
    const before = await h.state();
    await expect(
      db.repairExactPostings({
        ...base,
        transactionId: pending.id,
        mode: "preview",
      }),
    ).rejects.toThrow("row or byte limit");
    expect(await h.state()).toEqual(before);
  }, 30000);
  it("serializes competing applies and creates only one link", async () => {
    const { pending } = await setup();
    const peer = await db.peer();
    try {
      const command = { ...base, transactionId: pending.id };
      const preview = await db.repairExactPostings({
        ...command,
        mode: "preview",
      });
      const apply = {
        ...command,
        mode: "apply" as const,
        expected: preview.pairs,
      };
      const results = await Promise.allSettled([
        db.repairExactPostings(apply),
        peer.repairExactPostings(apply),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (await db.listEvents()).filter(
          (event) => event.type === "transaction.linked",
        ),
      ).toHaveLength(1);
    } finally {
      await peer.close();
    }
  }, 30000);
  it("rechecks newly inserted unknown contenders after preview without mutating any pair", async () => {
    const { pending, posted } = await setup();
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    const record = (await db.getTransaction(posted.id))!;
    await insertTransactionFixture(db, [
      {
        ...record,
        id: "new-contender",
        sourceKey: "new-contender",
        sourceAliases: [],
        amountMinor: null,
        currency: null,
      },
    ]);
    const before = await h.state();
    await expect(
      db.repairExactPostings({
        ...command,
        mode: "apply",
        expected: preview.pairs,
      }),
    ).rejects.toThrow("preview changed");
    expect(await h.state()).toEqual(before);
  });
  it("rechecks pending reappearance even with unchanged financial fields", async () => {
    const { pending } = await setup();
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    await h.capture(4, [authorization(), row("posted")], noAutomatic);
    const before = await h.state();
    await expect(
      db.repairExactPostings({
        ...command,
        mode: "apply",
        expected: preview.pairs,
      }),
    ).rejects.toThrow("preview changed");
    expect(await h.state()).toEqual(before);
  });
  it("preserves posted-only annotation content through repair and unlink", async () => {
    const { pending, posted } = await setup();
    await db.editAnnotation({
      transactionId: posted.id,
      expectedVersion: 0,
      notes: "Synthetic posted-only note",
      tags: ["tag"],
      metadata: { project: "synthetic" },
      category: "Household",
    });
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    expect(preview.pairs).toHaveLength(1);
    await db.repairExactPostings({
      ...command,
      mode: "apply",
      expected: preview.pairs,
    });
    expect(
      (await db.getTransaction(pending.id))!.annotation?.data,
    ).toMatchObject({
      notes: "Synthetic posted-only note",
      tags: ["tag"],
      metadata: { project: "synthetic" },
      category: "Household",
    });
    expect(
      (await db.getTransaction(pending.id))!.details.postingLink,
    ).toMatchObject({
      automatic: false,
      policyVersion: "owner-exact-repair-v1",
      evidence: null,
    });
    await db.unlinkPendingTransaction(await h.command(pending.id, posted.id));
    expect((await db.getTransaction(posted.id))!.annotation?.data.notes).toBe(
      "Synthetic posted-only note",
    );
  });
  it("rejects incomplete expected pairs and stale successful retries without duplicate links", async () => {
    const { pending } = await setup();
    const command = { ...base, transactionId: pending.id };
    const preview = await db.repairExactPostings({
      ...command,
      mode: "preview",
    });
    const before = await h.state();
    await expect(
      db.repairExactPostings({ ...command, mode: "apply", expected: [] }),
    ).rejects.toThrow("preview changed");
    expect(await h.state()).toEqual(before);
    await db.repairExactPostings({
      ...command,
      mode: "apply",
      expected: preview.pairs,
    });
    const applied = await h.state();
    await expect(
      db.repairExactPostings({
        ...command,
        mode: "apply",
        expected: preview.pairs,
      }),
    ).rejects.toThrow("preview changed");
    expect(await h.state()).toEqual(applied);
  });
  it("serializes a posted annotation against repair without hiding it", async () => {
    const { pending, posted } = await setup();
    const peer = await db.peer();
    try {
      const command = { ...base, transactionId: pending.id };
      const preview = await db.repairExactPostings({
        ...command,
        mode: "preview",
      });
      const results = await Promise.allSettled([
        db.repairExactPostings({
          ...command,
          mode: "apply",
          expected: preview.pairs,
        }),
        peer.editAnnotation({
          transactionId: posted.id,
          expectedVersion: 0,
          notes: "Concurrent synthetic note",
        }),
      ]);
      const p = (await db.getTransaction(pending.id))!;
      const q = (await db.getTransaction(posted.id))!;
      if (results[1]!.status === "fulfilled") {
        expect(q.supersededById).toBeNull();
        expect(q.annotation?.data.notes).toBe("Concurrent synthetic note");
        expect(results[0]!.status).toBe("rejected");
      } else {
        expect(results[0]!.status).toBe("fulfilled");
        expect(q.supersededById).toBe(p.id);
      }
    } finally {
      await peer.close();
    }
  }, 30000);
});
