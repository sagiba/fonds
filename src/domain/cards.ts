import { z } from "zod";

import {
  billingAccountDiscoverySchema,
  labelSchema,
  resourceKeySchema,
} from "./accounts.js";

export const cardDisplayNameSchema = labelSchema;

const last4Schema = z
  .string()
  .length(4)
  .regex(/^[0-9]{4}$/)
  .nullable();

/** Private, allowlisted provider card facts; flat scalars only. */
export const cardAttributesSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(256), z.number(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 64);

export const cardSchema = z
  .object({
    id: resourceKeySchema,
    connectionId: resourceKeySchema,
    /** Private provider card key within the connection; never public. */
    providerKey: resourceKeySchema,
    billingAccountId: resourceKeySchema.nullable(),
    last4: last4Schema,
    displayName: cardDisplayNameSchema.nullable(),
    attributes: cardAttributesSchema.nullable(),
    /** Service catalog creation time, never the issuer's issuance date. */
    createdAt: z.iso.datetime(),
    /** Successful card discovery only; transaction references do not advance it. */
    lastSeenAt: z.iso.datetime().nullable(),
  })
  .strict();

export const cardDiscoverySchema = z
  .object({
    observedAt: z.iso.datetime(),
    cards: z
      .array(
        z
          .object({
            cardKey: resourceKeySchema,
            last4: last4Schema,
            displayName: cardDisplayNameSchema.nullable().optional(),
            /** The account that pays this card's bills, when the source evidences it. */
            billingAccount: billingAccountDiscoverySchema.optional(),
            attributes: cardAttributesSchema.optional(),
          })
          .strict(),
      )
      .max(1000)
      .refine(
        (cards) =>
          new Set(cards.map((card) => card.cardKey)).size === cards.length,
        "Card discovery must contain each card key once",
      )
      .refine((cards) => {
        const metadata = new Map<string, string>();
        return cards.every(({ billingAccount: account }) => {
          if (!account) {
            return true;
          }
          const value = JSON.stringify([
            account.institutionName ?? null,
            account.mask ?? null,
          ]);
          const seen = metadata.get(account.providerKey) ?? value;
          metadata.set(account.providerKey, value);
          return seen === value;
        });
      }, "Cards sharing a billing account must agree on its metadata"),
  })
  .strict();

export type Card = z.output<typeof cardSchema>;

export type CardDiscovery = z.output<typeof cardDiscoverySchema>;
