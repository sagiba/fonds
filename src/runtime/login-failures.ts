import { z } from "zod";

import {
  LOGIN_FAILURES_BEFORE_ATTENTION,
  MAX_LOGIN_FAILURES_BEFORE_ATTENTION,
} from "../application/refreshes.js";

/**
 * `FONDS_LOGIN_FAILURES_BEFORE_ATTENTION`: the consecutive refused logins
 * after which a connection requires attention, a whole number from 1 to 5.
 */
export const loginFailuresSchema = z
  .string()
  .regex(/^[1-9]$/)
  .transform(Number)
  .refine((count) => count <= MAX_LOGIN_FAILURES_BEFORE_ATTENTION);

/** Names the variable, never its value. */
export const LOGIN_FAILURES_INVALID = `FONDS_LOGIN_FAILURES_BEFORE_ATTENTION must be a whole number from 1 to ${MAX_LOGIN_FAILURES_BEFORE_ATTENTION}`;

/**
 * The configured count, or the default when the variable is unset. An
 * invalid value throws the caller's error, so each entry point reports it as
 * its other configuration errors.
 */
export function loginFailuresBeforeAttention(
  env: NodeJS.ProcessEnv,
  invalid: (message: string) => Error,
): number {
  const value = env.FONDS_LOGIN_FAILURES_BEFORE_ATTENTION;
  if (value === undefined) {
    return LOGIN_FAILURES_BEFORE_ATTENTION;
  }
  const parsed = loginFailuresSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(LOGIN_FAILURES_INVALID);
  }
  return parsed.data;
}
