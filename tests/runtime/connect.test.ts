import { expect, it, vi } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import { addConnection } from "../../src/runtime/connect.js";

vi.mock("../../src/runtime/credentials.js", () => ({
  loadCredentials: async () => ({
    username: "INVENTED-USER",
    password: "INVENTED-PASSWORD",
  }),
}));

it("refuses a name claimed after the pre-check without opening the credential vault", async () => {
  const ensureConnection = vi
    .fn()
    .mockRejectedValue(new ConflictError("Connection already exists"));
  const openVault = vi.fn();
  await expect(
    addConnection({
      connectionId: "raced",
      provider: "cal",
      offline: false,
      openVault,
      connections: {
        getConnection: vi.fn().mockResolvedValue(undefined),
        ensureConnection,
      },
    }),
  ).rejects.toThrow("already exists");
  expect(ensureConnection).toHaveBeenCalledWith(
    { id: "raced", provider: "cal" },
    { requireNew: true },
  );
  expect(openVault).not.toHaveBeenCalled();
});

it("explains how to recover when credential persistence cannot be confirmed", async () => {
  const ensureConnection = vi
    .fn()
    .mockResolvedValue({ id: "added", provider: "cal" });
  const save = vi
    .fn()
    .mockRejectedValue(new Error("INVENTED-SECRET-IN-DRIVER-ERROR"));
  const error = await addConnection({
    connectionId: "added",
    provider: "cal",
    offline: false,
    openVault: () => ({ save, load: vi.fn() }),
    connections: {
      getConnection: vi.fn().mockResolvedValue(undefined),
      ensureConnection,
    },
  }).catch((error: unknown) => error);
  expect(ensureConnection).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
  expect(error).toEqual(
    new Error(
      "The connection was added, but saving credentials could not be confirmed. Retry with connect --connection <id>.",
    ),
  );
  expect(String(error)).not.toContain("INVENTED-");
});
