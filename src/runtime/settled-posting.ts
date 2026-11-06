import { z } from "zod";

import { SETTLED_POSTING_MODES } from "../domain/plans/posting-settlement.js";
import type { StoreOptions } from "../storage/store.js";

/** `FONDS_SETTLED_POSTING`: `off` or `on`. */
export const settledPostingSchema = z.enum(SETTLED_POSTING_MODES);

/** Names the variable, never its value. */
export const SETTLED_POSTING_INVALID = `FONDS_SETTLED_POSTING must be one of ${SETTLED_POSTING_MODES.join(", ")}`;

/** The store's matching options; an invalid value throws the caller's error. */
export function postingOptions(
  env: NodeJS.ProcessEnv,
  invalid: (message: string) => Error,
): Pick<StoreOptions, "settledPosting"> {
  const parsed = settledPostingSchema.safeParse(
    env.FONDS_SETTLED_POSTING ?? "off",
  );
  if (!parsed.success) {
    throw invalid(SETTLED_POSTING_INVALID);
  }
  return { settledPosting: parsed.data };
}
