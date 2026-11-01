import { z } from "zod";

import {
  SYNC_SCOPE_DAYS,
  SYNC_SCOPE_MAX_DAYS,
} from "../domain/plans/sync-scope.js";

/**
 * `FONDS_SYNC_SCOPE_DAYS`: the days around each capture's requested dates
 * and observations that applying it reads, a whole number from 1 to 3660.
 */
export const syncScopeDaysSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,3}$/)
  .transform(Number)
  .refine((days) => days <= SYNC_SCOPE_MAX_DAYS);

/** Names the variable, never its value. */
export const SYNC_SCOPE_DAYS_INVALID = `FONDS_SYNC_SCOPE_DAYS must be a whole number of days from 1 to ${SYNC_SCOPE_MAX_DAYS}`;

/**
 * The configured padding, or the default when the variable is unset. An
 * invalid value throws the caller's error, so each entry point reports it as
 * its other configuration errors.
 */
export function syncScopeDays(
  env: NodeJS.ProcessEnv,
  invalid: (message: string) => Error,
): number {
  const value = env.FONDS_SYNC_SCOPE_DAYS;
  if (value === undefined) {
    return SYNC_SCOPE_DAYS;
  }
  const parsed = syncScopeDaysSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(SYNC_SCOPE_DAYS_INVALID);
  }
  return parsed.data;
}
