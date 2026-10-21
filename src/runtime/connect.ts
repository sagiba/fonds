import type { CredentialStore } from "../application/credential-store.js";
import {
  connectionInputSchema,
  type FinancialStore,
  type InternalStore,
} from "../application/financial-store.js";
import { ConflictError } from "../domain/errors.js";
import type { CredentialVault } from "./credential-vault.js";
import { loadCredentials } from "./credentials.js";
import { runtimeProvider } from "./providers.js";

/** Fixed, value-free messages for operator command failures. */
export class ConnectError extends Error {}

const alreadyExists = () =>
  new ConnectError(
    "A connection with this name already exists. Use connect --connection <id> to update its credentials, or choose a different --name.",
  );

/** Register a login only after its credential input is valid; never overwrite another login. */
export async function addConnection(options: {
  connectionId: string;
  provider: string;
  connections: Pick<InternalStore, "getConnection" | "ensureConnection">;
  openVault: () => CredentialVault;
  offline: boolean;
  credentialFd?: number;
  forbiddenDirectory?: string;
}) {
  const provider = runtimeProvider(options.provider);
  const connection = { id: options.connectionId, provider: options.provider };
  if (!connectionInputSchema.safeParse(connection).success) {
    throw new ConnectError(
      'Invalid connection name: use a nonempty ID within the supported length, other than "." or "..".',
    );
  }
  if (await options.connections.getConnection(connection.id)) {
    throw alreadyExists();
  }
  const credentials = options.offline
    ? undefined
    : await loadCredentials({
        ...(options.credentialFd !== undefined && { fd: options.credentialFd }),
        ...(options.forbiddenDirectory && {
          forbiddenDirectory: options.forbiddenDirectory,
        }),
        input: provider.credentials,
        connection,
      });
  try {
    await options.connections.ensureConnection(connection, {
      requireNew: true,
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw alreadyExists();
    }
    throw error;
  }
  if (credentials) {
    try {
      await options.openVault().save(connection, credentials);
    } catch {
      throw new ConnectError(
        "The connection was added, but saving credentials could not be confirmed. Retry with connect --connection <id>.",
      );
    }
  }
  return {
    connectionId: connection.id,
    provider: connection.provider,
    credentials: credentials ? "stored" : "none",
  };
}

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
    throw new ConnectError(
      "Connection not found; add it with connect <provider> first.",
    );
  }
  const provider = runtimeProvider(connection.provider);
  const credentials = await loadCredentials({
    ...(options.credentialFd !== undefined && { fd: options.credentialFd }),
    ...(options.forbiddenDirectory && {
      forbiddenDirectory: options.forbiddenDirectory,
    }),
    input: provider.credentials,
    connection,
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

/**
 * Operator-only: removes one connection's stored credentials, so collection
 * stops discovering it. Its ledger, evidence and events are kept.
 */
export async function disconnectCredentials(options: {
  connectionId: string;
  connections: Pick<FinancialStore, "getConnection">;
  credentials: Pick<CredentialStore, "deleteCredentials">;
}) {
  const connection = await options.connections.getConnection(
    options.connectionId,
  );
  if (!connection) {
    throw new ConnectError("Connection not found.");
  }
  const removed = await options.credentials.deleteCredentials(
    options.connectionId,
  );
  return {
    connectionId: options.connectionId,
    provider: connection.provider,
    credentials: removed ? ("removed" as const) : ("none" as const),
  };
}
