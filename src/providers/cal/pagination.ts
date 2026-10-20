import { isLosslessNumber } from "lossless-json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

const CONTINUATION_KEYS = [
  "nextPage",
  "nextCursor",
  "nextPageToken",
  "continuationToken",
  "cursor",
  "pagination",
];

/** No paging contract is validated; any continuation signal makes absence unsafe. */
export function calHasUnsupportedPagination(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  const containers = [
    payload,
    ...(isRecord(payload.result) ? [payload.result] : []),
  ];
  return containers.some((object) => {
    if (object.hasMore === true) {
      return true;
    }
    const totalPages = isLosslessNumber(object.totalPages)
      ? Number(object.totalPages.value)
      : object.totalPages;
    if (typeof totalPages === "number" && totalPages > 1) {
      return true;
    }
    return CONTINUATION_KEYS.some(
      (key) =>
        Object.hasOwn(object, key) &&
        object[key] != null &&
        object[key] !== "" &&
        object[key] !== false,
    );
  });
}
