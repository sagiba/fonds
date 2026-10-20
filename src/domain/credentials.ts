import { z } from "zod";

export const credentialTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const usernamePasswordCredentialsSchema = z
  .object({
    username: credentialTextSchema.refine((value) => Boolean(value.trim())),
    password: credentialTextSchema,
  })
  .strict();

export type ProviderCredentials = Record<string, string>;

export interface CredentialInput {
  parse(value: unknown): ProviderCredentials;
  fields: Readonly<Record<string, string>>;
}

export const usernamePasswordInput: CredentialInput = {
  parse: (value) => usernamePasswordCredentialsSchema.parse(value),
  fields: { username: "Provider username", password: "Provider password" },
};

/** Messages intentionally contain no supplied data or upstream error text. */
export class CredentialInputError extends Error {}

export function parseCredentials(
  value: unknown,
  input: CredentialInput = usernamePasswordInput,
): ProviderCredentials {
  try {
    return input.parse(value);
  } catch (error) {
    if (error instanceof CredentialInputError) {
      throw error;
    }
    throw new CredentialInputError("Invalid credential input.");
  }
}
