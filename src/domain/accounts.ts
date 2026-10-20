import { z } from "zod";

import { RESOURCE_ID_MAX_LENGTH } from "./model.js";

/** Short owner-facing labels; long digit runs could be account or card numbers. */
export const labelSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value))
  .refine((value) => !/(?:\p{Decimal_Number}[ -]?){12,}/u.test(value));

export const resourceKeySchema = z
  .string()
  .min(1)
  .max(RESOURCE_ID_MAX_LENGTH)
  .refine((value) => !value.includes("\0"));

/** The last four digits of an account number; null when unknown. */
export const accountMaskSchema = z.string().regex(/^[0-9]{4}$/);

/**
 * `depository` is a bank account, including one known only as the payer of
 * card bills. `credit` is reserved for an evidenced card credit account.
 */
export const accountTypeSchema = z.enum(["depository", "credit"]);

/** A connection-scoped account; never merged by name or mask. */
export const accountSchema = z
  .object({
    id: resourceKeySchema,
    connectionId: resourceKeySchema,
    /** Private provider identity (opaque or keyed hash); never public. */
    providerKey: resourceKeySchema,
    type: accountTypeSchema,
    institutionName: labelSchema.nullable(),
    mask: accountMaskSchema.nullable(),
    displayName: labelSchema.nullable(),
    /** Service catalog creation time. */
    createdAt: z.iso.datetime(),
    /** Latest discovery that observed the account. */
    lastSeenAt: z.iso.datetime().nullable(),
  })
  .strict();

export type Account = z.output<typeof accountSchema>;

/** Accounts come only from discovery, as the billing account of a card. */
export const billingAccountDiscoverySchema = z
  .object({
    providerKey: resourceKeySchema,
    institutionName: labelSchema.nullable().optional(),
    mask: accountMaskSchema.nullable().optional(),
  })
  .strict();

export type BillingAccountDiscovery = z.output<
  typeof billingAccountDiscoverySchema
>;
