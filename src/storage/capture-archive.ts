import { parse } from "lossless-json";

import type { CardDiscovery } from "../domain/cards.js";
import { canonicalJson } from "../domain/observations.js";
import type { RunInput } from "../domain/plans/sync.js";
import type { SourceAdapter } from "../domain/source-adapter.js";
import { contentDigest } from "./run-evidence.js";

export const CAPTURE_ARCHIVE_MAX_DAYS = 90;

/** Retained source captures; the host supplies compression, so web targets stay free of it. */
export interface CaptureArchiveOptions {
  /** Whole days from 1 to {@link CAPTURE_ARCHIVE_MAX_DAYS}. */
  days: number;
  compress(text: string): Uint8Array;
}

/** Source number text, so long identifiers keep every digit and never equal a string. */
class SourceNumber {
  constructor(readonly text: string) {}
}

function parsedJson(text: string): unknown {
  const start = text.trimStart()[0];
  if (start !== "{" && start !== "[") {
    return undefined;
  }
  try {
    return parse(text, undefined, {
      parseNumber: (value) => new SourceNumber(value),
    });
  } catch {
    return undefined;
  }
}

/**
 * Source content as a comparison sees it. Providers nest JSON inside strings and
 * reorder keys between identical answers, and `volatile` names field paths a
 * source regenerates per session; lists and nested JSON add no path segment. Tags
 * keep every remaining difference distinct, such as a number and its text, or an
 * object and a string holding it. Only the digest uses this form: bodies stay as
 * received.
 */
function comparable(
  value: unknown,
  volatile: ReadonlySet<string>,
  path = "",
): unknown {
  if (typeof value === "string") {
    const nested = parsedJson(value);
    return nested === undefined
      ? ["string", value]
      : ["json", comparable(nested, volatile, path)];
  }
  if (value instanceof SourceNumber) {
    return ["number", value.text];
  }
  if (Array.isArray(value)) {
    return value.map((item) => comparable(item, volatile, path));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const field = `${path}\0${key}`;
        return volatile.has(field)
          ? []
          : [[key, comparable(item, volatile, field)]];
      }),
    );
  }
  return value;
}

/** What a run received, and a digest that capture times and volatile fields cannot move. */
export async function runCapture(
  run: Pick<RunInput, "collectorVersion" | "responses" | "failures">,
  adapter: SourceAdapter,
) {
  // A separator no JSON key contains, so a key holding a dot cannot alias a path.
  const volatile = new Set(
    adapter.volatileCaptureFields?.map(
      (path) => `\0${path.replaceAll(".", "\0")}`,
    ),
  );
  const failures = run.failures ?? [];
  return {
    text: JSON.stringify({
      schemaVersion: 1,
      collectorVersion: run.collectorVersion ?? null,
      parserVersion: adapter.parserVersion,
      responses: run.responses,
      failures,
    }),
    digest: await contentDigest({
      digestSchema: "fonds-capture-v1",
      responses: run.responses.map(({ capturedAt: _, ...response }) => ({
        ...response,
        responseText: comparable(response.responseText, volatile),
      })),
      failures: failures.map(({ failedAt: _, ...failure }) => failure),
    }),
  };
}

export async function discoveryCapture(discovery: CardDiscovery) {
  const { observedAt: _, ...content } = discovery;
  return {
    text: canonicalJson({ schemaVersion: 1, ...discovery }),
    digest: await contentDigest({
      digestSchema: "fonds-card-discovery-v1",
      content,
    }),
  };
}
