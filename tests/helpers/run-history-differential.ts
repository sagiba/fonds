import { expect } from "vitest";

import {
  type RunHistoryComparison,
  verifyRunHistoryLoading,
} from "../../src/storage/store.js";

/**
 * Importing this module makes every sync application in the test file also
 * plan from every applied run and requires the same plan output, including
 * events, the run update and the run-history summary to be stored.
 */
export const runHistoryComparisons: Omit<
  RunHistoryComparison,
  "dependent" | "complete"
>[] = [];

verifyRunHistoryLoading(({ dependent, complete, ...comparison }) => {
  runHistoryComparisons.push(comparison);
  expect(dependent).toStrictEqual(complete);
});
