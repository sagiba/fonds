import { z } from "zod";

import { canonicalJson } from "../../domain/observations.js";
import type { CollectionScope } from "../../domain/records.js";

export type RecordedCalSearchFilters = {
  merchantHebName: string;
  merchantHebCity: string;
  trnType: 0 | 1 | 5 | 6 | 7 | 8 | 9 | 42 | 44 | 59 | 60 | 999;
  fromTrnAmt: string;
  toTrnAmt: string;
  transactionsOrigin: 0 | 1 | 2;
  transCardPresentInd: 0 | 1 | 2;
};

const calFilterDefaults: RecordedCalSearchFilters = {
  merchantHebName: "",
  merchantHebCity: "",
  trnType: 0,
  fromTrnAmt: "0.00",
  toTrnAmt: "0.00",
  transactionsOrigin: 0,
  transCardPresentInd: 0,
};
const RECORDED_AMOUNT = /^(?:0|[1-9]\d*)\.\d{2}$/;

const calFiltersSchema = z
  .object({
    merchantHebName: z.string(),
    merchantHebCity: z.string(),
    trnType: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
      z.literal(42),
      z.literal(44),
      z.literal(59),
      z.literal(60),
      z.literal(999),
    ]),
    fromTrnAmt: z.string().regex(RECORDED_AMOUNT),
    toTrnAmt: z.string().regex(RECORDED_AMOUNT),
    transactionsOrigin: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    transCardPresentInd: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

export function validateCalScope(scope: CollectionScope): CollectionScope {
  // Keep the original CAL schema's field order for archived-run retry compatibility.
  return scope.filters
    ? {
        ...scope,
        filters: z
          .object({ cal: calFiltersSchema })
          .strict()
          .parse(scope.filters),
      }
    : scope;
}

/** Older unfiltered captures and explicit defaults describe the same health unit. */
export function normalizeCalScope(scope: CollectionScope): CollectionScope {
  return scope.filters &&
    canonicalJson(scope.filters.cal) === canonicalJson(calFilterDefaults)
    ? { ...scope, filters: undefined }
    : scope;
}
