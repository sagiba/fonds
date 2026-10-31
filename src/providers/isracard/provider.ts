import { CredentialInputError } from "../../domain/credentials.js";
import {
  ProviderConfigurationError,
  type ProviderDefinition,
} from "../../domain/source-adapter.js";
import { isracardAdapter } from "./adapter.js";
import { isracardCaptureContext } from "./capture.js";
import {
  collectIsracard,
  ISRACARD_COLLECTOR_VERSION,
  type IsracardSession,
} from "./collect.js";
import { isracardCredentialsSchema } from "./credentials.js";
import type { IsracardHttpClient } from "./transport.js";

/** The HTTP client is injected so this module stays portable; see node-http.ts. */
export function createIsracardProvider(
  createHttpClient: () => IsracardHttpClient,
): ProviderDefinition {
  return {
    adapter: isracardAdapter,
    credentials: {
      parse(value) {
        const parsed = isracardCredentialsSchema.safeParse(value);
        if (!parsed.success) {
          throw new CredentialInputError(
            "Isracard credentials require username, password and cardSuffix with exactly six digits.",
          );
        }
        return parsed.data;
      },
      fields: {
        username: "Provider username",
        password: "Provider password",
        cardSuffix: "Card's final six digits (required for Isracard)",
      },
    },
    // One login per refresh; each unit lists cards, then for each billing
    // month (one per window; the next and last for a recent refresh) requests
    // every card and, when a card has one, the shared legacy statement.
    estimateRequests: ({ windows, cards }) =>
      1 + (windows ?? 1) * (1 + (windows === null ? 2 : 1) * (cards + 1)),
    validateCollectionOptions({ historyMode, searchWindowMonths }) {
      if (historyMode || searchWindowMonths) {
        throw new ProviderConfigurationError(
          "--history-mode and --search-window-months are not supported by this provider.",
        );
      }
    },
    createCollector(credentials, options = {}) {
      const parsed = isracardCredentialsSchema.parse(credentials);
      const session: IsracardSession = {};
      return {
        provider: isracardAdapter.provider,
        collectorVersion: ISRACARD_COLLECTOR_VERSION,
        drainsOnAbort: true,
        collect: (request) =>
          collectIsracard({
            credentials: parsed,
            session,
            ...request,
            ...(options.callBudget !== undefined && {
              callBudget: options.callBudget,
            }),
            ...(options.maxDetails !== undefined && {
              maxDetails: options.maxDetails,
            }),
            httpClient: createHttpClient(),
          }),
      };
    },
    prepareCapture(responseText, accountKey) {
      const { accountKey: captureAccountKey, ...context } =
        isracardCaptureContext(responseText);
      if (accountKey !== captureAccountKey) {
        throw new ProviderConfigurationError(
          "--account must match the capture's account identity.",
        );
      }
      return context;
    },
  };
}
