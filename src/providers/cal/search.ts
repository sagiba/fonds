import { z } from "zod";

import { decimalToMinor } from "../../domain/money.js";
import type { RecordedCalSearchFilters } from "./scope.js";
import { CalTransportError } from "./transport.js";

const AMOUNT_FILTER = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;

/** Enumerations from the public CAL frontend reviewed 2026-10-13. */
const filtersSchema = z
  .object({
    merchantHebName: z
      .string()
      .max(30)
      .regex(/^[a-zA-Z\-\u0590-\u05FF0-9" ]*$/)
      .optional(),
    merchantHebCity: z
      .string()
      .max(100)
      .regex(/^[^\u0000-\u001f\u007f]*$/)
      .optional(),
    trnType: z.literal([0, 1, 5, 6, 7, 8, 9, 42, 44, 59, 60, 999]).optional(),
    fromTrnAmt: z.string().max(32).regex(AMOUNT_FILTER).optional(),
    toTrnAmt: z.string().max(32).regex(AMOUNT_FILTER).optional(),
    transactionsOrigin: z.literal([0, 1, 2]).optional(),
    transCardPresentInd: z.literal([0, 1, 2]).optional(),
    cardKeys: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .refine((value) => value.trim().length > 0)
          .regex(/^[^\u0000-\u001f\u007f]+$/),
      )
      .min(1)
      .max(1_000)
      .optional(),
  })
  .strict();

export type CalSearchFilters = z.input<typeof filtersSchema>;

export const CAL_EMPTY_SEARCH_DESCRIPTION =
  "לא נמצאו נתונים עבור הפרמטרים שהוזנו";

function normalizeAmountFilter(value: string | undefined): {
  requestAmount: number;
  recordedAmount: string;
  amountMinor: number;
} {
  // Two-decimal support is our conservative input boundary, not an issuer-wide rule.
  const amountMinor = decimalToMinor(value ?? "0", "ILS");
  const requestAmount = Number(value ?? "0");
  if (decimalToMinor(String(requestAmount), "ILS") !== amountMinor) {
    throw new CalTransportError("invalid_response", true);
  }
  const exact = BigInt(amountMinor);
  return {
    requestAmount,
    amountMinor,
    recordedAmount: `${exact / 100n}.${String(exact % 100n).padStart(2, "0")}`,
  };
}

/** No undocumented wallet/cash flags or arbitrary request fields are accepted. */
export function normalizeCalSearchFilters(input?: CalSearchFilters): {
  recorded: RecordedCalSearchFilters;
  request: Omit<RecordedCalSearchFilters, "fromTrnAmt" | "toTrnAmt"> & {
    fromTrnAmt: number;
    toTrnAmt: number;
  };
  cardKeys?: string[];
} {
  try {
    const parsed = filtersSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new CalTransportError("invalid_response", true);
    }
    const value = parsed.data;
    const minimumAmount = normalizeAmountFilter(value.fromTrnAmt);
    const maximumAmount = normalizeAmountFilter(value.toTrnAmt);
    if (
      maximumAmount.amountMinor !== 0 &&
      minimumAmount.amountMinor > maximumAmount.amountMinor
    ) {
      throw new CalTransportError("invalid_response", true);
    }
    const common = {
      merchantHebName: value.merchantHebName ?? "",
      merchantHebCity: value.merchantHebCity ?? "",
      trnType: value.trnType ?? 0,
      transactionsOrigin: value.transactionsOrigin ?? 0,
      transCardPresentInd: value.transCardPresentInd ?? 0,
    };
    return {
      recorded: {
        ...common,
        fromTrnAmt: minimumAmount.recordedAmount,
        toTrnAmt: maximumAmount.recordedAmount,
      },
      request: {
        ...common,
        fromTrnAmt: minimumAmount.requestAmount,
        toTrnAmt: maximumAmount.requestAmount,
      },
      ...(value.cardKeys ? { cardKeys: [...new Set(value.cardKeys)] } : {}),
    };
  } catch {
    throw new CalTransportError("invalid_response", true);
  }
}
