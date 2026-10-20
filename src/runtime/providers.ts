import {
  ProviderConfigurationError,
  type ProviderDefinition,
} from "../domain/source-adapter.js";
import { calProvider } from "../providers/cal/provider.js";
import { createIsracardHttpClient } from "../providers/isracard/node-http.js";
import { createIsracardProvider } from "../providers/isracard/provider.js";

// Static runtime composition is the only provider selection boundary. Shared
// workflows receive SourceAdapter/ProviderCollector and never inspect a provider ID.
const providers: Readonly<Record<string, ProviderDefinition>> = {
  cal: calProvider,
  isracard: createIsracardProvider(createIsracardHttpClient),
};

export const supportedProviders = Object.keys(providers);

export function runtimeProvider(provider: string): ProviderDefinition {
  if (!Object.hasOwn(providers, provider)) {
    throw new ProviderConfigurationError(
      "No source adapter or live collector is available for this provider.",
    );
  }
  return providers[provider]!;
}
