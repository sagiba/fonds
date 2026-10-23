import { z } from "zod";

import { InvalidInputError } from "../domain/errors.js";
import {
  amountBasisSchema,
  authorizationMethodSchema,
  calendarDateSchema,
  CANONICAL_TEXT_MAX_LENGTH,
  currencySchema,
  kindSchema,
  merchantCategoryCodeSchema,
  presenceSchema,
  RESOURCE_ID_MAX_LENGTH,
  transactionStatusSchema,
  walletSchema,
} from "../domain/model.js";
import { PERSPECTIVES } from "../domain/read-model.js";

export const filtersSchema = z
  .object({
    connectionId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH).optional(),
    /** Matches transactions whose card is currently billed to this account. */
    billingAccountId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH).optional(),
    cardId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH).optional(),
    status: transactionStatusSchema.optional(),
    presence: z
      .enum([...presenceSchema.options, "current", "all"])
      .default("current"),
    includeSuperseded: z.boolean().default(false),
    merchantName: z.string().min(1).max(CANONICAL_TEXT_MAX_LENGTH).optional(),
    merchantCategoryCode: merchantCategoryCodeSchema.optional(),
    dateRole: z.enum(["transaction", "booking", "billing"]).optional(),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    currency: currencySchema.optional(),
    amountBasis: amountBasisSchema.optional(),
    kind: kindSchema.optional(),
    cardPresent: z.boolean().optional(),
    authorizationMethod: authorizationMethodSchema.optional(),
    wallet: walletSchema.optional(),
    threeDSecureUsed: z.boolean().optional(),
    recurring: z.boolean().optional(),
    purchaseId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH).optional(),
    perspective: z.enum(PERSPECTIVES).default("spending"),
  })
  .strict()
  .refine(
    validateDateFilters,
    "Date bounds require an explicit role and ordered range",
  )
  .refine(
    (input) =>
      input.purchaseId === undefined || input.perspective !== "spending",
    "A purchaseId filter requires the billing or all perspective",
  );

const pageLimitSchema = z.number().int().min(1).max(200).default(50);
/**
 * Opaque list cursor text; its contents are not part of the public contract.
 * Keyset cursors carry a resource ID (up to 1024 characters) and its sort key.
 */
export const listCursorSchema = z.string().min(1).max(12_288);

const resourceIdSchema = z.string().min(1).max(RESOURCE_ID_MAX_LENGTH);

/** Internal store page; public operations accept an opaque cursor instead. */
export const pageSchema = filtersSchema.safeExtend({
  limit: pageLimitSchema,
  after: z
    .object({
      transactionDate: calendarDateSchema.nullable(),
      id: resourceIdSchema,
    })
    .strict()
    .optional(),
});

/** What store callers pass; the store parses it and applies the defaults. */
export type TransactionFilters = z.input<typeof filtersSchema>;

export type TransactionPageInput = z.input<typeof pageSchema>;

/** Parsed filters with defaults applied, as storage statements query them. */
export type TransactionQuery = z.output<typeof filtersSchema> &
  Partial<Pick<z.output<typeof pageSchema>, "limit" | "after">>;

export const transactionListSchema = filtersSchema.safeExtend({
  limit: pageLimitSchema,
  cursor: listCursorSchema.optional(),
});

type CursorKind = "event";

function toBase64Url(text: string): string {
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(cursor: string): string {
  return atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
}

function cursorValue(kind: CursorKind, cursor: string): number | undefined {
  let text: string;
  try {
    text = fromBase64Url(cursor);
  } catch {
    return undefined;
  }
  const match = /^([a-z]+):(0|[1-9][0-9]{0,15})$/.exec(text);
  const value = Number(match?.[2]);
  return match?.[1] === kind &&
    Number.isSafeInteger(value) &&
    toBase64Url(text) === cursor
    ? value
    : undefined;
}

export function encodeCursor(kind: CursorKind, value: number): string {
  return toBase64Url(`${kind}:${value}`);
}

/** Decode an opaque cursor; malformed or foreign cursors are invalid input. */
export function decodeCursor(kind: CursorKind, cursor: string): number {
  const value = cursorValue(kind, cursor);
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(value);
}

/** Browsing lists and the sort tuple each keyset cursor carries. */
const keysetSchemas = {
  transactions: z.tuple([calendarDateSchema.nullable(), resourceIdSchema]),
  cards: z.tuple([z.string().min(1), resourceIdSchema]),
  accounts: z.tuple([z.string().min(1), resourceIdSchema]),
  sync_runs: z.tuple([z.string().min(1), resourceIdSchema]),
  refreshes: z.tuple([z.string().min(1), resourceIdSchema]),
};

export type KeysetKind = keyof typeof keysetSchemas;

type Keyset<Kind extends KeysetKind> = z.infer<(typeof keysetSchemas)[Kind]>;

function utf8ToBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return toBase64Url(binary);
}

/** An opaque cursor for the position after the row with this sort tuple. */
export function encodeKeyset<Kind extends KeysetKind>(
  kind: Kind,
  values: Keyset<Kind>,
): string {
  return utf8ToBase64Url(JSON.stringify([kind, ...values]));
}

/** Decode a keyset cursor; malformed or foreign cursors are invalid input. */
export function decodeKeyset<Kind extends KeysetKind>(
  kind: Kind,
  cursor: string,
): Keyset<Kind> {
  let decoded: unknown;
  try {
    const binary = fromBase64Url(cursor);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    decoded = utf8ToBase64Url(text) === cursor ? JSON.parse(text) : undefined;
  } catch {
    decoded = undefined;
  }
  const [cursorKind, ...values] = Array.isArray(decoded) ? decoded : [];
  if (cursorKind !== kind) {
    throw new InvalidInputError("Invalid cursor");
  }
  return keysetSchemas[kind].parse(values) as Keyset<Kind>;
}

const catalogPositionSchema = z
  .object({ createdAt: z.string().min(1), id: resourceIdSchema })
  .strict();

/** Internal catalog page (cards or accounts) for one connection. */
export const catalogPageSchema = z
  .object({
    connectionId: resourceIdSchema,
    limit: pageLimitSchema,
    after: catalogPositionSchema.optional(),
  })
  .strict();

export type CatalogPageInput = z.input<typeof catalogPageSchema>;

export type CatalogQuery = z.output<typeof catalogPageSchema>;

export const catalogListSchema = z
  .object({
    connectionId: resourceIdSchema,
    limit: pageLimitSchema,
    cursor: listCursorSchema.optional(),
  })
  .strict();

export const cursorSchema = z
  .object({
    connectionId: z.string().min(1).max(RESOURCE_ID_MAX_LENGTH).optional(),
    after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

export type EventPageInput = z.input<typeof cursorSchema>;

export type EventQuery = z.output<typeof cursorSchema>;

/** Totals over `all` would double-count purchases and their billed lines. */
export const totalsSchema = filtersSchema.safeExtend({
  perspective: z.enum(PERSPECTIVES).exclude(["all"]).default("spending"),
});

/** Date bounds are inclusive and must name the financial date they constrain. */
export function validateDateFilters(input: {
  dateRole?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): boolean {
  const unnamedBound = Boolean((input.from || input.to) && !input.dateRole);
  const reversed = Boolean(input.from && input.to && input.from > input.to);
  return !unnamedBound && !reversed;
}
