import type { Operation } from "../application/operations.js";

export const FINANCIAL_SCOPES = ["financial:read", "financial:write"] as const;

export type FinancialScope = (typeof FINANCIAL_SCOPES)[number];

/** Provider-verified principal. Request headers and tool arguments are never identities. */
export interface TrustedIdentity {
  readonly source: string;
  readonly subject: string;
  readonly ownerId: string;
  readonly resource: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  /** Verified grant context for durable event subscriptions; never an access token. */
  readonly sessionId?: string;
  readonly expiresAt?: number;
}

/** The selected issuer verifies credentials and deliberately maps its subject to a Fonds owner. */
export interface HostedAuthProvider {
  readonly issuer: string;
  /** Issuer authorization scopes advertised when clients begin an OAuth grant. */
  readonly authorizationScopes?: readonly string[];
  /** Where an OAuth client obtains access tokens, as the API description states. */
  readonly endpoints: {
    readonly authorization: string;
    readonly token: string;
  };
  authenticate(request: Request): Promise<TrustedIdentity | null>;
}

export function operationScope(
  operation: Pick<Operation, "access">,
): FinancialScope {
  return operation.access === "read" ? "financial:read" : "financial:write";
}

export function permits(
  scopes: readonly string[],
  scope: FinancialScope,
): boolean {
  return scopes.includes(scope);
}

/** Hostnames of this machine, where plain HTTP is accepted for development. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export function isHttpsOrLoopback(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
}

/**
 * Keep the exact /mcp resource for both REST and MCP; do not derive it from an
 * incoming Host. Plain HTTP is a development exception for loopback hosts only:
 * OAuth issuers are HTTPS everywhere else.
 */
export function hostedOrigin(value: string): string {
  const url = new URL(value);
  if (
    !isHttpsOrLoopback(url) ||
    url.origin !== value ||
    url.username ||
    url.password
  ) {
    throw new Error("Invalid hosted public origin configuration");
  }
  return url.origin;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function acceptedIdentity(
  identity: TrustedIdentity | null,
  ownerId: string,
  resource: string,
): identity is TrustedIdentity {
  return (
    identity !== null &&
    typeof identity === "object" &&
    identity.ownerId === ownerId &&
    identity.resource === resource &&
    isNonEmptyString(identity.source) &&
    isNonEmptyString(identity.subject) &&
    isNonEmptyString(identity.clientId) &&
    Array.isArray(identity.scopes) &&
    identity.scopes.every((scope) => typeof scope === "string")
  );
}
