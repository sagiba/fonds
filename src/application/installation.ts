/** Non-secret identities of the secrets a database is bound to. */
export interface InstallationFingerprint {
  ownerId: string;
  authSecretDigest: string;
  credentialsKeyId: string | null;
}

export function sameInstallation(
  left: InstallationFingerprint,
  right: InstallationFingerprint,
) {
  return (
    left.ownerId === right.ownerId &&
    left.authSecretDigest === right.authSecretDigest &&
    left.credentialsKeyId === right.credentialsKeyId
  );
}
