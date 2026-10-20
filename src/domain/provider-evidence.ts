import { isLosslessNumber } from "lossless-json";

import type { JsonObject, JsonValue } from "./model.js";
import {
  canonicalJson,
  compareEvidence,
  retainObservations,
} from "./observations.js";

export type EvidenceShape =
  | "scalar"
  | { [key: string]: EvidenceShape }
  | readonly [EvidenceShape, "set"?];

export function scalarFields(names: string): Record<string, EvidenceShape> {
  return Object.fromEntries(
    names
      .split(/\s+/)
      .filter(Boolean)
      .map((key) => [key, "scalar"]),
  );
}

/** A malformed known slot retains its type, without retaining undeclared descendants. */
export function projectEvidence(
  value: unknown,
  shape: EvidenceShape,
): JsonValue {
  if (isLosslessNumber(value)) {
    return value.value;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    if (!Array.isArray(shape)) {
      return [];
    }
    const items = value.map((item) => projectEvidence(item, shape[0]!));
    return shape[1] === "set" ? sortedEvidence(items) : items;
  }
  if (value && typeof value === "object") {
    if (shape === "scalar" || Array.isArray(shape)) {
      return {};
    }
    const row = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(shape as Record<string, EvidenceShape>)
        .filter(([key]) => Object.hasOwn(row, key))
        .map(([key, child]) => [key, projectEvidence(row[key], child)]),
    );
  }
  return null;
}

export function evidenceObject(
  value: unknown,
  shape: EvidenceShape,
): JsonObject {
  const projected = projectEvidence(value, shape);
  return projected !== null &&
    typeof projected === "object" &&
    !Array.isArray(projected)
    ? projected
    : {};
}

export function evidenceList(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** Current-capture evidence remains distinct from source statements retained from other scopes. */
export function currentSourceRows(namespace: JsonObject): JsonValue[] {
  const rows = evidenceList(namespace.rows);
  const identity = namespace.identity;
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    !Object.hasOwn(identity, "currentRows")
  ) {
    return rows;
  }
  const indices = identity.currentRows;
  if (
    !Array.isArray(indices) ||
    new Set(indices).size !== indices.length ||
    indices.some(
      (index) =>
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= rows.length,
    )
  ) {
    return [];
  }
  return (indices as number[]).map((index) => rows[index]!);
}

/** Select whole incoming statements without combining fields or reusing duplicate occurrences. */
export function currentSourceRowIndices(
  mergedRows: JsonValue[],
  incomingRows: JsonValue[],
): number[] {
  const available = new Map<string, { indices: number[]; used: number }>();
  for (const [index, row] of mergedRows.entries()) {
    const key = canonicalJson(row);
    const group = available.get(key) ?? { indices: [], used: 0 };
    group.indices.push(index);
    available.set(key, group);
  }
  const result: number[] = [];
  for (const row of incomingRows) {
    const group = available.get(canonicalJson(row));
    if (!group || group.used >= group.indices.length) {
      return [];
    }
    result.push(group.indices[group.used++]!);
  }
  return result;
}

export function sortedEvidence<Value extends JsonValue>(
  items: readonly Value[],
): Value[] {
  return [...items].sort(compareEvidence);
}

export function mergeEvidenceLists(
  previous: JsonValue[],
  incoming: JsonValue[],
): JsonValue[] {
  return sortedEvidence(retainObservations(previous, incoming));
}

/** Each present component is a fresh restatement; missing components are outside this observation. */
export function mergeEvidenceRows(
  previous: JsonValue[],
  incoming: JsonValue[],
  componentKey: (row: JsonValue) => string | null,
): JsonValue[] {
  // Separate partial source statements instead of synthesizing facts across scopes.
  const key = (row: JsonValue) => {
    const component = componentKey(row);
    return component !== null &&
      row &&
      typeof row === "object" &&
      !Array.isArray(row)
      ? canonicalJson([component, Object.keys(row).sort()])
      : null;
  };
  const before = Map.groupBy(previous, key);
  const after = Map.groupBy(incoming, key);
  const unkeyed = mergeEvidenceLists(
    before.get(null) ?? [],
    after.get(null) ?? [],
  );
  before.delete(null);
  after.delete(null);
  for (const [key, rows] of after) {
    before.set(key, rows);
  }
  return sortedEvidence([...before.values()].flat().concat(unkeyed));
}

export function mergeDeclaredEvidence(
  previous: JsonObject,
  incoming: JsonObject,
  declaration: {
    project(value: JsonObject): JsonObject;
    componentKey(row: JsonValue): string | null;
    retainedLists?: Record<string, readonly string[]>;
  },
): JsonObject {
  const before = declaration.project(previous);
  const after = declaration.project(incoming);
  const result = { ...before, ...after };
  result.rows = mergeEvidenceRows(
    evidenceList(before.rows),
    evidenceList(after.rows),
    declaration.componentKey,
  );
  const object = (value: JsonValue | undefined): JsonObject =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  for (const [container, keys] of Object.entries(
    declaration.retainedLists ?? {},
  )) {
    if (before[container] === undefined && after[container] === undefined) {
      continue;
    }
    const earlier = object(before[container]);
    const later = object(after[container]);
    result[container] = Object.fromEntries(
      keys
        .filter(
          (key) => Object.hasOwn(earlier, key) || Object.hasOwn(later, key),
        )
        .map((key) => [
          key,
          mergeEvidenceLists(
            evidenceList(earlier[key]),
            evidenceList(later[key]),
          ),
        ]),
    );
  }
  return result;
}
