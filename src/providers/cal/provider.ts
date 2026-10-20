import { usernamePasswordCredentialsSchema } from "../../domain/credentials.js";
import {
  ProviderConfigurationError,
  type ProviderDefinition,
} from "../../domain/source-adapter.js";
import { calAdapter } from "./adapter.js";
import {
  CAL_COLLECTOR_VERSION,
  type CalSession,
  collectCal,
} from "./collect.js";

export const calProvider: ProviderDefinition = {
  adapter: calAdapter,
  credentials: {
    parse: (value) => usernamePasswordCredentialsSchema.parse(value),
    fields: { username: "Provider username", password: "Provider password" },
  },
  validateCollectionOptions({ callBudget, maxDetails }) {
    if (callBudget !== undefined) {
      throw new ProviderConfigurationError(
        "--call-budget is not supported by this provider.",
      );
    }
    if (maxDetails !== undefined) {
      throw new ProviderConfigurationError(
        "--max-details is not supported by this provider.",
      );
    }
  },
  createCollector(credentials, options = {}) {
    const parsed = usernamePasswordCredentialsSchema.parse(credentials);
    const session: CalSession = {};
    return {
      provider: calAdapter.provider,
      collectorVersion: CAL_COLLECTOR_VERSION,
      collect: (request) =>
        collectCal({
          credentials: parsed,
          session,
          ...request,
          ...(options.historyMode && { historyMode: options.historyMode }),
          ...(options.searchWindowMonths && {
            searchWindowMonths: options.searchWindowMonths,
          }),
          ...(options.onDiagnostic && { onDiagnostic: options.onDiagnostic }),
        }),
    };
  },
  prepareCapture() {
    return { endpoint: "synthetic:cal/recent" };
  },
};
