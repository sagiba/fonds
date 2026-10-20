import { parse } from "lossless-json";
import { describe, expect, it } from "vitest";

import {
  currentSourceRowIndices,
  currentSourceRows,
  mergeEvidenceLists,
  mergeEvidenceRows,
  projectEvidence,
} from "../../src/domain/provider-evidence.js";

describe("declared provider evidence", () => {
  it("selects current complete statements without copying retained evidence or reusing occurrences", () => {
    const rows = [
      { id: "old" },
      { id: "same", amount: "10.00" },
      { amount: "10.00", id: "same" },
    ];
    const incoming = [
      { id: "same", amount: "10.00" },
      { id: "same", amount: "10.00" },
    ];
    const currentRows = currentSourceRowIndices(rows, incoming);
    expect(currentRows).toEqual([1, 2]);
    expect(currentSourceRows({ rows, identity: { currentRows } })).toEqual(
      incoming,
    );
    expect(currentSourceRows({ rows })).toEqual(rows);
    expect(currentSourceRowIndices(rows, [...incoming, incoming[0]!])).toEqual(
      [],
    );
    expect(currentSourceRowIndices(rows, [{ id: "missing" }])).toEqual([]);
  });

  it.each(
    [
      null,
      "0",
      {},
      [-1],
      [1.5],
      [2],
      [0, 0],
      ["0"],
      [true],
      [Number.MAX_SAFE_INTEGER + 1],
    ].map((currentRows) => ({ currentRows })),
  )(
    "rejects malformed current-row selectors $currentRows without falling back to historical rows",
    ({ currentRows }) => {
      expect(
        currentSourceRows({
          rows: [{ id: "one" }, { id: "two" }],
          identity: { currentRows },
        }),
      ).toEqual([]);
    },
  );
  it("canonicalizes declared set-like arrays with multiplicity while preserving ordered lists", () => {
    expect(
      projectEvidence(
        { unordered: ["b", "a", "a"], ordered: ["b", "a"] },
        { unordered: ["scalar", "set"], ordered: ["scalar"] },
      ),
    ).toEqual({ unordered: ["a", "a", "b"], ordered: ["b", "a"] });
  });

  it("retains complete partial statements and unkeyed evidence across alternating scopes", () => {
    const key = (row: unknown) => (row as { id?: string }).id ?? null;
    const first = [{ id: "1", amount: "10" }, { note: "one" }, { note: "one" }];
    const second = [
      { id: "1", amount: "10", currency: "ILS" },
      { note: "two" },
    ];
    const merged = mergeEvidenceRows(first, second, key);
    expect(merged).toHaveLength(5);
    expect(
      mergeEvidenceRows(mergeEvidenceRows(merged, first, key), second, key),
    ).toEqual(merged);
    expect(
      mergeEvidenceRows(
        merged,
        [{ id: "1", amount: "11", currency: "ILS" }],
        key,
      ),
    ).toContainEqual({ id: "1", amount: "11", currency: "ILS" });
    expect(
      mergeEvidenceRows(
        merged,
        [{ id: "1", amount: "11", currency: "ILS" }],
        key,
      ),
    ).not.toContainEqual(second[0]);
  });
  it("filters every nesting level while keeping decimal lexemes and null/missing distinctions", () => {
    const value = parse(
      '{"amount":0.2900,"absent":null,"rows":[{"name":"Synthetic","unknown":{"secret":"noise"}}],"unknown":{"deep":true}}',
    );
    expect(
      projectEvidence(value, {
        amount: "scalar",
        absent: "scalar",
        missing: "scalar",
        rows: [{ name: "scalar" }],
      }),
    ).toEqual({
      amount: "0.2900",
      absent: null,
      rows: [{ name: "Synthetic" }],
    });
  });

  it("keeps malformed known-slot types without retaining unknown nested contents", () => {
    expect(
      projectEvidence(
        {
          flag: { noise: "hidden" },
          code: [{ hidden: true }],
          nullSlot: null,
          list: { hidden: true },
        },
        {
          flag: "scalar",
          code: "scalar",
          nullSlot: "scalar",
          list: ["scalar"],
        },
      ),
    ).toEqual({ flag: {}, code: [], nullSlot: null, list: {} });
  });

  it("merges evidence at maximum multiplicity and ignores object insertion order", () => {
    expect(
      mergeEvidenceLists(
        [
          { a: 1, b: 2 },
          { a: 1, b: 2 },
        ],
        [{ b: 2, a: 1 }, "new"],
      ),
    ).toEqual(["new", { a: 1, b: 2 }, { a: 1, b: 2 }]);
  });

  it("retains missing components, replaces corrections and preserves duplicate occurrences", () => {
    const key = (row: unknown) => (row as { id: string }).id;
    const oldRows = [
      { id: "1", amount: "10" },
      { id: "2", amount: "20" },
    ];
    const correction = [
      { id: "2", amount: "21" },
      { id: "2", amount: "21" },
    ];
    const result = mergeEvidenceRows(oldRows, correction, key);
    expect(result).toEqual([{ id: "1", amount: "10" }, ...correction]);
    expect(mergeEvidenceRows(result, correction, key)).toEqual(result);
    expect(mergeEvidenceRows(result, [oldRows[0]!], key)).toEqual(result);
    expect(mergeEvidenceRows(result, [{ id: "2", amount: "22" }], key)).toEqual(
      [
        { id: "1", amount: "10" },
        { id: "2", amount: "22" },
      ],
    );
  });
});
