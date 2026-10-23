import type { SourceAdapter } from "../../domain/source-adapter.js";
import {
  mergeCalEvidence,
  projectCalState,
  retainCalEvidence,
} from "./evidence.js";
import { extractCal } from "./extract.js";
import { compatibleCalPostingGroups } from "./posting-evidence.js";
import { normalizeCalScope, validateCalScope } from "./scope.js";

// Hypothesis-based margin inside the asserted 90 days; governing dates are unvalidated.
const RECENT_COMPARABLE_DAYS = 60;

export const calAdapter: SourceAdapter = {
  provider: "cal",
  parserVersion: "cal-v15",
  retainProviderEvidence: retainCalEvidence,
  mergeProviderEvidence: mergeCalEvidence,
  projectProviderState: projectCalState,
  extract: extractCal,
  validateScope: validateCalScope,
  normalizeScope: normalizeCalScope,
  pendingPostingCandidates: true,
  automaticPosting: {
    compatibleGroups: compatibleCalPostingGroups,
    pendingAmountBasis: "authorization",
    postedAmountBasis: "purchase_commitment",
  },
  recentComparableDays: RECENT_COMPARABLE_DAYS,
  rejectEmptyRecent: true,
  sourceCoverage: {
    kind: "account_window",
    statuses: ["pending"],
    resources: ["cal:recent"],
    dateField: "transactionDate",
    days: RECENT_COMPARABLE_DAYS,
    requireOriginMatch: true,
  },
  resourceKey(endpoint) {
    return endpoint === "synthetic:cal/recent" ||
      endpoint ===
        "https://api.cal-online.co.il/Transactions/api/LastTransactionsForBankAccount/LastTransactionsForBankAccount"
      ? "cal:recent"
      : endpoint;
  },
};
