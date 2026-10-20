import type { SourceAdapter } from "../../domain/source-adapter.js";
import {
  mergeIsracardEvidence,
  projectIsracardState,
  retainIsracardEvidence,
} from "./evidence.js";
import { extractIsracard } from "./extract.js";
import { compatibleIsracardPostingGroups } from "./posting-evidence.js";
import { normalizeIsracardScope, validateIsracardScope } from "./scope.js";
import { ISRACARD_ENDPOINTS } from "./transport.js";

export const isracardAdapter: SourceAdapter = {
  provider: "isracard",
  parserVersion: "isracard-v13",
  retainProviderEvidence: retainIsracardEvidence,
  mergeProviderEvidence: mergeIsracardEvidence,
  projectProviderState: projectIsracardState,
  extract: extractIsracard,
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
