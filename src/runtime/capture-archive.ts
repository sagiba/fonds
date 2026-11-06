import { brotliCompressSync, constants } from "node:zlib";

import { z } from "zod";

import {
  CAPTURE_ARCHIVE_MAX_DAYS,
  type CaptureArchiveOptions,
} from "../storage/capture-archive.js";
import type { StoreOptions } from "../storage/store.js";

/** `FONDS_CAPTURE_ARCHIVE_DAYS`: days each source capture is kept, 0 to keep none. */
export const captureArchiveDaysSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]?)$/)
  .transform(Number)
  .refine((days) => days <= CAPTURE_ARCHIVE_MAX_DAYS);

/** Names the variable, never its value. */
export const CAPTURE_ARCHIVE_DAYS_INVALID = `FONDS_CAPTURE_ARCHIVE_DAYS must be a whole number of days from 0 to ${CAPTURE_ARCHIVE_MAX_DAYS}`;

/** Maximum effort: a capture compresses once, and is rarely read again. */
function compress(text: string): Uint8Array {
  return brotliCompressSync(text, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text),
    },
  });
}

export function captureArchive(
  days: number,
): Pick<StoreOptions, "captureArchive"> {
  const options: CaptureArchiveOptions = { days, compress };
  return days > 0 ? { captureArchive: options } : {};
}

/** The store's capture retention; an invalid value throws the caller's error. */
export function captureArchiveOptions(
  env: NodeJS.ProcessEnv,
  invalid: (message: string) => Error,
): Pick<StoreOptions, "captureArchive"> {
  const parsed = captureArchiveDaysSchema.safeParse(
    env.FONDS_CAPTURE_ARCHIVE_DAYS ?? "0",
  );
  if (!parsed.success) {
    throw invalid(CAPTURE_ARCHIVE_DAYS_INVALID);
  }
  return captureArchive(parsed.data);
}
