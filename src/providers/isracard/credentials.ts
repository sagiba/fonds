import { z } from "zod";

const credentialTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

/** Source authentication fields, shared by collection and runtime input validation. */
export const isracardCredentialsSchema = z
  .object({
    username: credentialTextSchema.refine((value) => Boolean(value.trim())),
    password: credentialTextSchema,
    cardSuffix: z.string().regex(/^\d{6}$/),
  })
  .strict();

export type IsracardCredentials = z.infer<typeof isracardCredentialsSchema>;
