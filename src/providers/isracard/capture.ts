import { isLosslessNumber, parse, stringify } from "lossless-json";
import { z } from "zod";

import type { FinancialResponse } from "../../domain/records.js";

export const ISRACARD_CAPTURE_ENDPOINT = "isracard:card-month";

const canonicalIdentitySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\u0000"));

/** Isracard's own cards (`11`) and co-branded cards (`77`). */
export const ISRACARD_COMPANY_CODES = ["11", "77"] as const;

/** A billing-month label, `YYYY-MM`. */
export const ISRACARD_BILLING_MONTH_PATTERN =
  /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/;

export const isracardCardSchema = z
  .object({
    companyCode: z.enum(ISRACARD_COMPANY_CODES),
    cardGuid: canonicalIdentitySchema,
    cardSuffix: z.string().regex(/^\d{4}$/),
  })
  .strict();

/** Financial response bodies stay verbatim strings, including whitespace and numeric lexemes. */
export const isracardCaptureSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("isracard"),
    mode: z.enum(["recent", "history"]),
    billingMonth: z.string().regex(ISRACARD_BILLING_MONTH_PATTERN),
    /** Actual DigitalV3 request flag; absent without that response or in older captures. */
    isNextBillingDate: z.boolean().optional(),
    card: isracardCardSchema,
    /** Binding established from a unique company+suffix match in the archived card list. */
    legacyCardIndex: z.string().regex(/^\d+$/).optional(),
    responses: z
      .object({
        /**
         * New captures hold the allowlisted projection from
         * `projectIsracardCardList`; older captures hold the raw card list.
         */
        cardList: z.string(),
        digital: z.string().optional(),
        legacy: z.string().optional(),
        details: z
          .array(
            z
              .object({
                voucherNumber: canonicalIdentitySchema,
                responseText: z.string(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
  })
  .strict();

export type IsracardCard = z.infer<typeof isracardCardSchema>;

export type IsracardCapture = z.infer<typeof isracardCaptureSchema>;

/** Only Isracard's own cards have the legacy statement; co-branded cards have DigitalV3 only. */
export function hasLegacyStatement(
  card: Pick<IsracardCard, "companyCode">,
): boolean {
  return card.companyCode === "11";
}

/**
 * Company plus final four digits, the provider's own card addressing. Each login
 * session returns a new `cardGuid` for every card, so the GUID is session
 * evidence only and never canonical identity.
 */
export function isracardCardKey(
  card: Pick<IsracardCard, "companyCode" | "cardSuffix">,
): string {
  return `isracard:card:${JSON.stringify([card.companyCode, card.cardSuffix])}`;
}

export function serializeIsracardCapture(capture: IsracardCapture): string {
  return JSON.stringify(isracardCaptureSchema.parse(capture));
}

/**
 * The capture without its session `cardGuid` values, for identical-capture
 * skipping. Every login returns new GUIDs, so keeping them would make each
 * repeat capture look new. Capture binding compares the envelope GUID with the
 * card list's, so the outcome of that comparison stays in the fingerprint.
 * Every financial response text stays exact.
 */
export function isracardContentFingerprint(responseText: string): string {
  try {
    const capture = isracardCaptureSchema.parse(JSON.parse(responseText));
    const cardList: unknown = parse(capture.responses.cardList);
    const object = (value: unknown): value is Record<string, unknown> =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !isLosslessNumber(value);
    const cards =
      object(cardList) &&
      object(cardList.data) &&
      Array.isArray(cardList.data.cardsList)
        ? cardList.data.cardsList
        : [];
    for (const card of cards) {
      if (!object(card) || !("cardGuid" in card)) {
        continue;
      }
      // The binding check's token semantics: a string or a number's lexeme.
      const guid = isLosslessNumber(card.cardGuid)
        ? card.cardGuid.value
        : card.cardGuid;
      card.cardGuid = guid === capture.card.cardGuid;
    }
    // Tagged so that no raw fallback can equal a normalized capture.
    return `capture:${JSON.stringify({
      ...capture,
      card: { ...capture.card, cardGuid: null },
      responses: { ...capture.responses, cardList: stringify(cardList) },
    })}`;
  } catch {
    return `raw:${responseText}`;
  }
}

/** Derive offline ingestion context from the provider's archived capture format. */
export function isracardCaptureContext(
  responseText: string,
): Pick<FinancialResponse, "accountKey" | "endpoint" | "scope"> {
  const capture = isracardCaptureSchema.parse(JSON.parse(responseText));
  const cardKey = isracardCardKey(capture.card);
  return {
    accountKey: cardKey,
    endpoint: ISRACARD_CAPTURE_ENDPOINT,
    scope: { kind: capture.mode, month: capture.billingMonth, cardKey },
  };
}

/** A card's billing account, derived from its card-list entry. */
export interface IsracardBillingAccount {
  /** The raw `bank|branch|accountNumber`: private, never in public output. */
  providerKey: string;
  /** Last four characters of the account number (leading zeros kept), when digits. */
  mask: string | null;
}

function accountPart(value: unknown): string | null {
  const text = isLosslessNumber(value)
    ? value.value
    : typeof value === "string"
      ? value.trim()
      : null;
  return text && !text.includes("|") ? text : null;
}

/** Missing or malformed bank, branch or account number means unknown. */
export function isracardBillingAccount(
  card: Record<string, unknown>,
): IsracardBillingAccount | undefined {
  const bank = accountPart(card.bank);
  const branch = accountPart(card.branch);
  const accountNumber = accountPart(card.accountNumber);
  if (!bank || !branch || !accountNumber) {
    return undefined;
  }
  const mask = accountNumber.slice(-4);
  return {
    providerKey: `${bank}|${branch}|${accountNumber}`,
    mask: /^[0-9]{4}$/.test(mask) ? mask : null,
  };
}

function cardListText(value: unknown): string | null {
  if (isLosslessNumber(value)) {
    return value.value;
  }
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function projectedBillingAccount(
  value: unknown,
): IsracardBillingAccount | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const { providerKey, mask } = value as Record<string, unknown>;
  return typeof providerKey === "string" &&
    (mask === null || typeof mask === "string")
    ? { providerKey, mask }
    : undefined;
}

/**
 * The allowlisted card list archived in new captures: per card `companyCode`,
 * `cardSuffix`, `cardGuid` and `cardName`, plus its `billingAccount`
 * (`providerKey` and `mask`). Holder names, limits and every other card-list
 * field are dropped. The envelope keeps `isSuccess` and `data.cardsList`, so
 * capture binding reads projected and raw lists alike. The same projection
 * prepares old raw archives for replay, and projecting a projected list returns
 * it unchanged.
 */
export function projectIsracardCardList(responseText: string): string {
  const payload: unknown = parse(responseText);
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const data = object(payload) ? payload.data : undefined;
  const cards =
    object(data) && Array.isArray(data.cardsList) ? data.cardsList : [];
  return JSON.stringify({
    isSuccess: object(payload) && payload.isSuccess === true,
    data: {
      cardsList: cards.filter(object).map((card) => {
        const billingAccount =
          isracardBillingAccount(card) ??
          projectedBillingAccount(card.billingAccount);
        return {
          companyCode: cardListText(card.companyCode),
          cardSuffix: cardListText(card.cardSuffix),
          cardGuid: cardListText(card.cardGuid),
          cardName: typeof card.cardName === "string" ? card.cardName : null,
          ...(billingAccount ? { billingAccount } : {}),
        };
      }),
    },
  });
}
