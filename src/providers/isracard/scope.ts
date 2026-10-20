import { z } from "zod";

import type { CollectionScope } from "../../domain/records.js";
import { ISRACARD_BILLING_MONTH_PATTERN } from "./capture.js";

const isracardScopeSchema = z
  .object({
    kind: z.enum(["recent", "history"]),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    windowFrom: z.iso.date().optional(),
    windowTo: z.iso.date().optional(),
    month: z.string().regex(ISRACARD_BILLING_MONTH_PATTERN).optional(),
    cardKey: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (scope) => !scope.from || !scope.to || scope.from <= scope.to,
    "Invalid date range",
  );

export function validateIsracardScope(scope: CollectionScope): CollectionScope {
  return isracardScopeSchema.parse(scope);
}

/** Purchase-date bounds do not change a billing-month request; fresh and historical scopes remain distinct. */
export function normalizeIsracardScope(
  scope: CollectionScope,
): CollectionScope {
  const parsed = isracardScopeSchema.safeParse(scope);
  if (!parsed.success) {
    return scope;
  }
  const validated = parsed.data;
  if (!validated.month || !validated.cardKey) {
    // Authentication/discovery and interrupted history can fail before a card/month is known.
    return validated;
  }
  return {
    kind: validated.kind,
    month: validated.month,
    cardKey: validated.cardKey,
  };
}
