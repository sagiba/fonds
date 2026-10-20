import { parse, stringify } from "lossless-json";

import type { SourceAdapter } from "../../domain/source-adapter.js";
import { extractCal } from "./extract.js";
import { calPostingEvidence } from "./posting-evidence.js";
import { normalizeCalScope, validateCalScope } from "./scope.js";

export const calAdapter: SourceAdapter = {
  provider: "cal",
  parserVersion: "cal-v11",
  extract: extractCal,
  validateScope: validateCalScope,
  normalizeScope: normalizeCalScope,
  pendingPostingCandidates: true,
  automaticPosting: {
    evidence: calPostingEvidence,
    pendingAmountBasis: "authorization",
    postedAmountBasis: "purchase_commitment",
  },
  // Hypothesis-based margin inside the asserted 90 days; governing dates are unvalidated.
  recentComparableDays: 60,
  rejectEmptyRecentPosted: true,
  contentFingerprint(responseText) {
    // `groupPid` is a per-request identifier; every other value is source data.
    try {
      const value = parse(responseText);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        delete (value as Record<string, unknown>).groupPid;
      }
      return stringify(value) ?? responseText;
    } catch {
      return responseText;
    }
  },
  resourceKey(endpoint) {
    return endpoint === "synthetic:cal/recent" ||
      endpoint ===
        "https://api.cal-online.co.il/Transactions/api/LastTransactionsForBankAccount/LastTransactionsForBankAccount"
      ? "cal:recent"
      : endpoint;
  },
};
