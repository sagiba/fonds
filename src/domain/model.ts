import { z } from "zod";

import { countryCodeSchema } from "./countries.js";
import { isSupportedCurrency } from "./money.js";

export const reconciliationFailureCodeSchema = z.enum(["implausible_empty"]);

export type ReconciliationFailureCode = z.infer<
  typeof reconciliationFailureCodeSchema
>;

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

const jsonNumberSchema = z
  .number()
  .refine(
    (value) => !Number.isInteger(value) || Number.isSafeInteger(value),
    "Unsafe JSON integers must be retained as strings",
  );

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    jsonNumberSchema,
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const safeIntegerSchema = z
  .number()
  .int()
  .refine(Number.isSafeInteger, "Must be a safe integer");
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use an uppercase alphabetic currency code")
  .refine(isSupportedCurrency, "Unsupported currency precision");
export const amountBasisSchema = z.enum([
  "booked_entry",
  "authorization",
  "purchase_commitment",
  "unknown",
]);
export const kindSchema = z.enum([
  "purchase",
  "refund",
  "income",
  "transfer",
  "fee",
  "interest",
  "cash_withdrawal",
  "unknown",
]);
const nullableString = z.string().nullable();
export const transactionStatusSchema = z.enum(["posted", "pending"]);
export const presenceSchema = z.enum(["seen", "not_returned", "removed"]);
export const merchantCategoryCodeSchema = z
  .string()
  .length(4)
  .regex(/^[0-9]{4}$/);
export const CANONICAL_TEXT_MAX_LENGTH = 4096;
export const RESOURCE_ID_MAX_LENGTH = 1024;
export const ANNOTATION_MAX_BYTES = 64 * 1024;
// Canonical SQL text must be portable; raw source and JSON documents remain exact.
const canonicalTextSchema = z
  .string()
  .refine(
    (value) => !value.includes("\u0000"),
    "Canonical text must not contain NUL",
  );
const nullableCanonicalText = canonicalTextSchema
  .max(CANONICAL_TEXT_MAX_LENGTH)
  .nullable();
const nullableDate = z.iso.date().nullable();

/** Preserve source precision and any supplied offset; no offset means timezone unknown. */
export const transactionDateTimeSchema = z.iso
  .datetime({ local: true, offset: true })
  .max(64)
  .regex(/^(?!0000)/);

/** Exact decimal text as the source states it; never a float. */
export const exchangeRateSchema = z
  .string()
  .max(64)
  .regex(/^\d+(?:\.\d+)?$/);

/** One stated currency conversion step (Berlin Group `currencyExchange` names). */
export const currencyExchangeSchema = z
  .object({
    sourceCurrency: currencySchema,
    targetCurrency: currencySchema,
    unitCurrency: currencySchema,
    exchangeRate: exchangeRateSchema,
    quotationDate: nullableDate,
  })
  .strict();

export type CurrencyExchange = z.infer<typeof currencyExchangeSchema>;

/** Payment context retained as versioned transaction content. */
export const paymentContextFields = [
  "cardPresent",
  "authorizationMethod",
  "wallet",
  "threeDSecureUsed",
  "recurring",
] as const;

export type PaymentContextField = (typeof paymentContextFields)[number];

/** Adapter-derived state is stored separately from retained source content. */
export const providerStateFields = [
  "identity",
  "observations",
  "monetaryEvidence",
  "billingMonth",
  "currencyMapping",
] as const;

const sourceDetailsSchema = z
  .object({
    schemaVersion: z.literal(1),
    transactionDateTime: transactionDateTimeSchema.nullable().optional(),
    additionalInformation: z.array(z.string()).optional(),
    merchant: z
      .object({
        address: nullableString,
        phone: nullableString,
        city: nullableString.optional(),
        /** ISO 3166-1 alpha-3, only when the source supplies a valid code. */
        countryCode: countryCodeSchema.nullable().optional(),
      })
      .strict(),
    currencyExchange: z.array(currencyExchangeSchema).min(1).max(8).optional(),
    sourceRefs: z.array(
      z
        .object({
          runId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH),
          path: z.string(),
        })
        .strict(),
    ),
    issues: z.array(z.string()),
    /** Private: payment-context fields a conflict left unknown (never public). */
    paymentContextConflicts: z
      .array(z.enum(paymentContextFields))
      .min(1)
      .optional(),
    pendingPostingCandidates: z.array(z.string().min(1)).optional(),
    provider: z.record(z.string(), jsonObjectSchema),
    rejectedPostingKeys: z.array(z.string().min(1)).optional(),
  })
  .strict();

function pairedMoney(
  value: { amountMinor: number | null; currency: string | null },
  context: z.RefinementCtx,
): void {
  if ((value.amountMinor === null) !== (value.currency === null)) {
    context.addIssue({
      code: "custom",
      path: ["currency"],
      message: "Amount and currency must both be known or both null",
    });
  }
}

const sourceFactsShape = {
  /** Private collection partition and source-identity scope; never public. */
  sourceScope: canonicalTextSchema.min(1).max(RESOURCE_ID_MAX_LENGTH),
  sourceKey: canonicalTextSchema.min(1),
  sourceAliases: z.array(z.string().min(1)).default([]),
  identityStrength: z.enum(["native", "weak", "ambiguous"]),
  status: transactionStatusSchema,
  description: nullableCanonicalText,
  counterpartyName: nullableCanonicalText,
  kind: kindSchema,
  merchantName: nullableCanonicalText,
  merchantProviderId: nullableCanonicalText,
  merchantCategoryCode: merchantCategoryCodeSchema.nullable(),
  transactionDate: nullableDate,
  bookingDate: nullableDate,
  billingDate: nullableDate,
  amountMinor: safeIntegerSchema.nullable(),
  currency: currencySchema.nullable(),
  amountBasis: amountBasisSchema,
  originalAmountMinor: safeIntegerSchema.nullable(),
  originalCurrency: currencySchema.nullable(),
  installmentCount: safeIntegerSchema.nonnegative().nullable(),
};

const serviceIdSchema = canonicalTextSchema.min(1).max(RESOURCE_ID_MAX_LENGTH);

export const authorizationMethodSchema = z.enum([
  "chip",
  "contactless",
  "keyed_in",
  "online",
  "swipe",
]);
export const walletSchema = z.enum(["apple_pay", "google_pay", "samsung_pay"]);

/**
 * Ledger columns beyond adapter facts. The planner resolves `cardId` from the
 * adapter's provider card key; the other facts stay null until parsed.
 */
const ledgerFactsShape = {
  cardId: serviceIdSchema.nullable(),
  cardPresent: z.boolean().nullable(),
  authorizationMethod: authorizationMethodSchema.nullable(),
  wallet: walletSchema.nullable(),
  threeDSecureUsed: z.boolean().nullable(),
  recurring: z.boolean().nullable(),
  purchaseId: serviceIdSchema.nullable(),
  installmentNumber: safeIntegerSchema.positive().nullable(),
  providerTransactionCode: nullableCanonicalText,
  fxFeeMinor: safeIntegerSchema.nullable(),
  fxFeeCurrency: currencySchema.nullable(),
};

const ledgerFactsSchema = z.object(ledgerFactsShape).strict();

export type LedgerFacts = z.infer<typeof ledgerFactsSchema>;

/** Not-yet-parsed ledger facts; null means unknown. */
export function unknownLedgerFacts(cardId: string | null): LedgerFacts {
  return {
    cardId,
    cardPresent: null,
    authorizationMethod: null,
    wallet: null,
    threeDSecureUsed: null,
    recurring: null,
    purchaseId: null,
    installmentNumber: null,
    providerTransactionCode: null,
    fxFeeMinor: null,
    fxFeeCurrency: null,
  };
}

/**
 * Payment context as one read states it. A value is evidence; `null` is
 * conflicting evidence (unknown now); `undefined` is no evidence, so the
 * stored value stands. Only writes and reads of stored rows normalize to null.
 */
export type ReadPaymentContext = {
  [Field in PaymentContextField]?: LedgerFacts[Field] | undefined;
};

/**
 * Ledger facts an adapter may parse from the source. The planner resolves the
 * remaining ledger facts (card and purchase IDs).
 */
const parsedLedgerFactsShape = {
  cardPresent: ledgerFactsShape.cardPresent.optional(),
  authorizationMethod: ledgerFactsShape.authorizationMethod.optional(),
  wallet: ledgerFactsShape.wallet.optional(),
  threeDSecureUsed: ledgerFactsShape.threeDSecureUsed.optional(),
  recurring: ledgerFactsShape.recurring.optional(),
  providerTransactionCode: ledgerFactsShape.providerTransactionCode.optional(),
  installmentNumber: ledgerFactsShape.installmentNumber.optional(),
  fxFeeMinor: ledgerFactsShape.fxFeeMinor.optional(),
  fxFeeCurrency: ledgerFactsShape.fxFeeCurrency.optional(),
};

type ParsedFacts = Pick<
  LedgerFacts,
  Exclude<keyof typeof parsedLedgerFactsShape, PaymentContextField>
>;

/**
 * The adapter's parsed ledger facts: omitted source facts are unknown (null);
 * payment context keeps the read's own absence (`undefined`).
 */
export function parsedLedgerFacts(
  input: {
    [Field in keyof ParsedFacts]?: ParsedFacts[Field] | undefined;
  } & ReadPaymentContext,
): ParsedFacts & ReadPaymentContext {
  return {
    cardPresent: input.cardPresent,
    authorizationMethod: input.authorizationMethod,
    wallet: input.wallet,
    threeDSecureUsed: input.threeDSecureUsed,
    recurring: input.recurring,
    providerTransactionCode: input.providerTransactionCode ?? null,
    installmentNumber: input.installmentNumber ?? null,
    fxFeeMinor: input.fxFeeMinor ?? null,
    fxFeeCurrency: input.fxFeeCurrency ?? null,
  };
}

/** Stored payment context after a read: absent evidence keeps the stored value. */
export function storedPaymentContext(
  read: ReadPaymentContext,
  stored: Pick<LedgerFacts, PaymentContextField> | undefined,
): Pick<LedgerFacts, PaymentContextField> {
  return {
    cardPresent:
      read.cardPresent === undefined
        ? (stored?.cardPresent ?? null)
        : read.cardPresent,
    authorizationMethod:
      read.authorizationMethod === undefined
        ? (stored?.authorizationMethod ?? null)
        : read.authorizationMethod,
    wallet: read.wallet === undefined ? (stored?.wallet ?? null) : read.wallet,
    threeDSecureUsed:
      read.threeDSecureUsed === undefined
        ? (stored?.threeDSecureUsed ?? null)
        : read.threeDSecureUsed,
    recurring:
      read.recurring === undefined
        ? (stored?.recurring ?? null)
        : read.recurring,
  };
}

/**
 * Payment-context fields still unknown by conflict after a read: the read's
 * own conflicts (`null`), plus earlier ones the read states no evidence for.
 * Evidence for one field never clears another field's conflict.
 */
export function paymentContextConflicts(
  read: ReadPaymentContext,
  earlier: readonly PaymentContextField[] = [],
): PaymentContextField[] {
  return paymentContextFields.filter(
    (field) =>
      read[field] === null ||
      (read[field] === undefined && earlier.includes(field)),
  );
}

const retainedPendingSchema = z
  .object({
    ...sourceFactsShape,
    ...ledgerFactsShape,
    status: z.literal("pending"),
    details: sourceDetailsSchema,
    id: z.string().min(1),
    connectionId: z.string().min(1),
    presence: presenceSchema,
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    lastSeenRunId: z.string(),
    version: safeIntegerSchema.positive(),
    supersededById: z.null(),
  })
  .strict();

const splitReceiptSchema = z
  .object({
    expectedPendingVersion: safeIntegerSchema.positive(),
    expectedPostedVersion: safeIntegerSchema.positive(),
    expectedPendingAnnotationVersion: safeIntegerSchema.nonnegative(),
    expectedPostedAnnotationVersion: safeIntegerSchema.nonnegative(),
    pendingVersion: safeIntegerSchema.positive(),
    postedVersion: safeIntegerSchema.positive(),
    reason: z.string(),
    actor: z.string(),
  })
  .strict();

const postingLinkSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.string().min(1),
    automatic: z.boolean(),
    postedId: z.string().min(1),
    pending: retainedPendingSchema,
    pendingKeys: z.array(z.string().min(1)),
    postedKeys: z.array(z.string().min(1)),
    evidence: z
      .object({
        runId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH),
        capturedAt: z.string(),
      })
      .strict()
      .nullable(),
    split: splitReceiptSchema.optional(),
  })
  .strict();

export const detailsSchema = sourceDetailsSchema.extend({
  postingLink: postingLinkSchema.optional(),
});

export type TransactionDetails = z.infer<typeof detailsSchema>;

export function emptyDetails(): TransactionDetails {
  return {
    schemaVersion: 1,
    merchant: { address: null, phone: null },
    sourceRefs: [],
    issues: [],
    provider: {},
  };
}

/**
 * One normalized row as an adapter emits it. `cardKey` is the provider's card
 * key within the connection; the planner resolves it to a service card ID.
 * A billed line names its purchase by `purchaseKey`, the purchase row's source
 * key in the same collection scope; the planner resolves it to the current
 * surviving purchase ID. Billed lines carry `installmentNumber` (ordinal >= 1).
 */
export const transactionInputSchema = z
  .object({
    ...sourceFactsShape,
    /** Omitted optional evidence may preserve a resolved native transfer's name. */
    counterpartyName: nullableCanonicalText.optional(),
    cardKey: canonicalTextSchema.min(1).max(RESOURCE_ID_MAX_LENGTH).nullable(),
    purchaseKey: canonicalTextSchema.min(1).nullable().optional(),
    ...parsedLedgerFactsShape,
    details: detailsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    pairedMoney(value, context);
    if (value.purchaseKey != null && value.purchaseKey === value.sourceKey) {
      context.addIssue({
        code: "custom",
        path: ["purchaseKey"],
        message: "A billed line cannot be its own purchase",
      });
    }
    if (
      ((value.fxFeeMinor ?? null) === null) !==
      ((value.fxFeeCurrency ?? null) === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["fxFeeCurrency"],
        message: "FX fee amount and currency must both be known or both null",
      });
    }
    if (
      value.details.transactionDateTime != null &&
      value.details.transactionDateTime.slice(0, 10) !== value.transactionDate
    ) {
      context.addIssue({
        code: "custom",
        path: ["details", "transactionDateTime"],
        message:
          "Transaction time must use the same source-local transaction date",
      });
    }
    if (
      (value.originalAmountMinor === null) !==
      (value.originalCurrency === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["originalCurrency"],
        message: "Original amount and currency must both be known or both null",
      });
    }
  });

export type TransactionInput = z.infer<typeof transactionInputSchema>;

/** A resolved ledger row's facts: adapter facts plus service references. */
export type TransactionFacts = Omit<
  TransactionInput,
  | "cardKey"
  | "purchaseKey"
  | "installmentNumber"
  | "counterpartyName"
  | PaymentContextField
> & { counterpartyName: string | null } & Omit<
    LedgerFacts,
    PaymentContextField
  > &
  ReadPaymentContext;

/** A stored ledger row's facts: payment context is a value or null. */
export type StoredTransactionFacts = Omit<
  TransactionFacts,
  PaymentContextField
> &
  Pick<LedgerFacts, PaymentContextField>;

/** Billed lines (a purchase link or an ordinal) are never pending/posted matched. */
export function isBilledLine(
  row: Pick<LedgerFacts, "purchaseId" | "installmentNumber">,
): boolean {
  return row.purchaseId !== null || row.installmentNumber !== null;
}

const reviewBasisSchema = z
  .object({
    amountMinor: safeIntegerSchema.nullable(),
    currency: currencySchema.nullable(),
    amountBasis: amountBasisSchema,
    kind: kindSchema,
  })
  .strict()
  .superRefine(pairedMoney);

export const ANNOTATION_TEXT_MAX_LENGTH = 100;
export const ANNOTATION_TAGS_MAX = 50;
export const annotationCategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(ANNOTATION_TEXT_MAX_LENGTH);
export const annotationTagSchema = annotationCategorySchema;
const annotationTagsSchema = z
  .array(annotationTagSchema)
  .max(ANNOTATION_TAGS_MAX);

export const annotationSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    notes: nullableString.default(null),
    category: annotationCategorySchema.nullable().default(null),
    tags: annotationTagsSchema.default([]),
    metadata: jsonObjectSchema.default({}),
    review: z
      .object({
        status: z.enum(["approved", "needs_review"]),
        financialVersion: safeIntegerSchema.positive(),
        basis: reviewBasisSchema,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      ANNOTATION_MAX_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: `Serialized annotation must not exceed ${ANNOTATION_MAX_BYTES} UTF-8 bytes`,
      });
    }
  });

export type AnnotationData = z.infer<typeof annotationSchema>;
