import type { JsonObject, JsonValue } from "./model.js";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }
    return item;
  });
}

/** Retain the maximum observed multiplicity without inventing a schedule or event identity. */
export function retainObservations<T>(previous: T[], current: T[]): T[] {
  const unmatchedPreviousCounts = new Map<string, number>();
  for (const item of previous) {
    const key = canonicalJson(item);
    unmatchedPreviousCounts.set(
      key,
      (unmatchedPreviousCounts.get(key) ?? 0) + 1,
    );
  }
  const observations = [...previous];
  for (const item of current) {
    const key = canonicalJson(item);
    const count = unmatchedPreviousCounts.get(key) ?? 0;
    if (count > 0) {
      unmatchedPreviousCounts.set(key, count - 1);
    } else {
      observations.push(item);
    }
  }
  return observations;
}

/**
 * Provider namespaces of `base`. Each namespace's `retained` object holds
 * arrays of untyped provider evidence kept across observations: arrays from
 * `earlier` then `later` combine at their maximum multiplicity. Other
 * namespace members are `base`'s own.
 */
export function retainProviderEvidence(
  base: Record<string, JsonObject>,
  earlier: Record<string, JsonObject>,
  later: Record<string, JsonObject>,
): Record<string, JsonObject> {
  const result = { ...base };
  for (const name of new Set([
    ...Object.keys(earlier),
    ...Object.keys(later),
  ])) {
    const before = retainedEvidence(earlier[name]);
    const after = retainedEvidence(later[name]);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    if (keys.size === 0) {
      continue;
    }
    result[name] = {
      ...result[name],
      retained: Object.fromEntries(
        [...keys].map((key) => [
          key,
          retainObservations(before[key] ?? [], after[key] ?? []),
        ]),
      ),
    };
  }
  return result;
}

function retainedEvidence(
  namespace: JsonObject | undefined,
): Record<string, JsonValue[]> {
  const retained = namespace?.retained;
  if (!retained || typeof retained !== "object" || Array.isArray(retained)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(retained).filter((entry): entry is [string, JsonValue[]] =>
      Array.isArray(entry[1]),
    ),
  );
}
