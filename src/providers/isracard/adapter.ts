import type { SourceAdapter } from "../../domain/source-adapter.js";
import { retainedPaymentContext } from "./enrichment.js";
import {
  mergeIsracardEvidence,
  projectIsracardState,
  retainIsracardEvidence,
} from "./evidence.js";
import { extractIsracard } from "./extract.js";
import { isracardFinancialAuthority } from "./financial-authority.js";
import { compatibleIsracardPostingGroups } from "./posting-evidence.js";
import { normalizeIsracardScope, validateIsracardScope } from "./scope.js";
import { ISRACARD_ENDPOINTS } from "./transport.js";

export const isracardAdapter: SourceAdapter = {
  provider: "isracard",
  parserVersion: "isracard-v16",
  retainProviderEvidence: retainIsracardEvidence,
  mergeProviderEvidence: mergeIsracardEvidence,
  paymentContextFromRetainedEvidence: retainedPaymentContext,
  projectProviderState: projectIsracardState,
  extract: extractIsracard,
  financialAuthority: isracardFinancialAuthority,
  validateScope: validateIsracardScope,
  normalizeScope: normalizeIsracardScope,
  pendingPostingCandidates: true,
  automaticPosting: {
    pendingAmountBasis: "authorization",
    postedAmountBasis: "purchase_commitment",
    compatibleGroups: compatibleIsracardPostingGroups,
  },
  resourceKey(endpoint) {
    return endpoint === ISRACARD_ENDPOINTS.transactions ||
      endpoint === ISRACARD_ENDPOINTS.legacy ||
      endpoint === "synthetic:isracard/card-month"
      ? "isracard:card-month"
      : endpoint;
  },
};
