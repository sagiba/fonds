import type { FinancialStore } from "../application/financial-store.js";
import type { CredentialVault } from "./credential-vault.js";
import { loadCredentials } from "./credentials.js";
import { runtimeProvider } from "./providers.js";

/** Fixed, value-free messages for operator command failures. */
export class ConnectError extends Error {}

/**
 * Operator-only: reads one connection's credentials from hidden terminal input
 * or a private descriptor and stores them encrypted. Never an HTTP/MCP operation.
 */
export async function connectCredentials(options: {
  connectionId: string;
  connections: Pick<FinancialStore, "getConnection">;
  /** Opened only after the connection and its credentials are valid. */
  openVault: () => CredentialVault;
  credentialFd?: number;
  forbiddenDirectory?: string;
}) {
  const connection = await options.connections.getConnection(
    options.connectionId,
  );
  if (!connection) {
    throw new ConnectError("Connection not found; initialize it first.");
  }
  const provider = runtimeProvider(connection.provider);
  const credentials = await loadCredentials({
    ...(options.credentialFd !== undefined && { fd: options.credentialFd }),
    ...(options.forbiddenDirectory && {
      forbiddenDirectory: options.forbiddenDirectory,
    }),
    input: provider.credentials,
  });
  await options
    .openVault()
    .save(
      { id: options.connectionId, provider: connection.provider },
      credentials,
    );
  return {
    connectionId: options.connectionId,
    provider: connection.provider,
    credentials: "stored" as const,
  };
}
