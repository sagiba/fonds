import type { SourceAdapter } from "../../domain/source-adapter.js";
import {
  mergeCalEvidence,
  projectCalState,
  retainCalEvidence,
} from "./evidence.js";
import { extractCal } from "./extract.js";
import { compatibleCalPostingGroups } from "./posting-evidence.js";
import { normalizeCalScope, validateCalScope } from "./scope.js";

export const calAdapter: SourceAdapter = {
  provider: "cal",
  parserVersion: "cal-v14",
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
  // Hypothesis-based margin inside the asserted 90 days; governing dates are unvalidated.
  recentComparableDays: 60,
  rejectEmptyRecentPosted: true,
  resourceKey(endpoint) {
    return endpoint === "synthetic:cal/recent" ||
      endpoint ===
        "https://api.cal-online.co.il/Transactions/api/LastTransactionsForBankAccount/LastTransactionsForBankAccount"
      ? "cal:recent"
      : endpoint;
  },
};
