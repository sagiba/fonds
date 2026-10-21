import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialInputError } from "../../src/domain/credentials.js";
import { loadCredentials } from "../../src/runtime/credentials.js";
import { runtimeProvider } from "../../src/runtime/providers.js";

describe("private credential input", () => {
  let directory: string;
  const descriptors: number[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "fonds-credentials-"));
  });

  afterEach(() => {
    for (const fd of descriptors.splice(0)) {
      closeSync(fd);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  function descriptor(contents: string, mode = 0o600): number {
    const path = join(directory, `input-${descriptors.length}.json`);
    writeFileSync(path, contents, { mode });
    const fd = openSync(path, "r");
    descriptors.push(fd);
    return fd;
  }

  it("reads invented credentials from a private descriptor without logging them", async () => {
    const fd = descriptor(
      JSON.stringify({
        username: "invented-user",
        password: "invented-password",
      }),
    );
    const output = [
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method),
      ),
    ];
    try {
      await expect(loadCredentials({ fd })).resolves.toEqual({
        username: "invented-user",
        password: "invented-password",
      });
      for (const spy of output) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of output) {
        spy.mockRestore();
      }
    }
  });

  it("reads a provider-defined token without assuming username/password fields", async () => {
    const token = "synthetic-token";
    const parse = (value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("token" in value) ||
        typeof value.token !== "string"
      ) {
        throw new Error("invalid input");
      }
      return { token: value.token };
    };
    expect(
      await loadCredentials({
        fd: descriptor(JSON.stringify({ token })),
        input: { fields: { token: "Provider token" }, parse },
      }),
    ).toEqual({ token });
  });

  it("requires exact six-digit Isracard suffixes while preserving CAL's credential shape", async () => {
    const credentials = {
      username: "invented-user",
      password: "invented-password",
    };
    const input = { ...credentials, cardSuffix: "001234" };
    await expect(
      loadCredentials({
        fd: descriptor(JSON.stringify(input)),
        input: runtimeProvider("isracard").credentials,
      }),
    ).resolves.toEqual(input);
    await expect(
      loadCredentials({
        fd: descriptor(
          JSON.stringify({ ...input, token: "synthetic-private-extra" }),
        ),
        input: runtimeProvider("isracard").credentials,
      }),
    ).rejects.toBeInstanceOf(CredentialInputError);
    for (const cardSuffix of [
      undefined,
      "12345",
      "1234567",
      " 123456",
      "12345a",
      "",
      null,
      123456,
    ]) {
      await expect(
        loadCredentials({
          fd: descriptor(JSON.stringify({ ...credentials, cardSuffix })),
          input: runtimeProvider("isracard").credentials,
        }),
      ).rejects.toBeInstanceOf(CredentialInputError);
    }
    await expect(
      loadCredentials({
        fd: descriptor(
          JSON.stringify({ ...credentials, cardSuffix: "001234" }),
        ),
        input: runtimeProvider("cal").credentials,
      }),
    ).rejects.toBeInstanceOf(CredentialInputError);
  });

  it("applies private-descriptor restrictions to Isracard suffix input", async () => {
    const credentials = JSON.stringify({
      username: "invented-user",
      password: "invented-password",
      cardSuffix: "001234",
    });
    await expect(
      loadCredentials({
        fd: descriptor(credentials, 0o644),
        input: runtimeProvider("isracard").credentials,
      }),
    ).rejects.toBeInstanceOf(CredentialInputError);
    await expect(
      loadCredentials({
        fd: descriptor(credentials),
        input: runtimeProvider("isracard").credentials,
        forbiddenDirectory: directory,
      }),
    ).rejects.toBeInstanceOf(CredentialInputError);
  });

  it("rejects public files, oversized payloads, malformed JSON and extra fields with value-free errors", async () => {
    const examples: [string, number?][] = [
      [
        JSON.stringify({
          username: "invented-user",
          password: "DO-NOT-ECHO-SYNTHETIC",
        }),
        0o644,
      ],
      ["DO-NOT-ECHO-SYNTHETIC"],
      [
        JSON.stringify({
          username: "invented-user",
          password: "DO-NOT-ECHO-SYNTHETIC",
          token: "extra",
        }),
      ],
      [JSON.stringify({ username: "", password: "DO-NOT-ECHO-SYNTHETIC" })],
      [
        JSON.stringify({
          username: "invented-user",
          password: "DO-NOT-ECHO-SYNTHETIC\n",
        }),
      ],
      ["DO-NOT-ECHO-SYNTHETIC".repeat(1000)],
    ];
    for (const [contents, mode] of examples) {
      const fd = descriptor(contents, mode);
      try {
        await loadCredentials({ fd });
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialInputError);
        expect((error as Error).message).not.toContain("DO-NOT-ECHO-SYNTHETIC");
      }
    }
  });

  it("reads user:password text, splits the first colon, and removes only one final newline", async () => {
    for (const ending of ["", "\n", "\r\n"]) {
      const fd = descriptor(`invented-user:  invented:password:  ${ending}`);
      await expect(loadCredentials({ fd })).resolves.toEqual({
        username: "invented-user",
        password: "  invented:password:  ",
      });
    }
    for (const text of [
      "invented-user:invented-password\n\n",
      "invented-user:",
      ":invented-password",
      "invented-user:invented\tpassword",
    ]) {
      await expect(
        loadCredentials({ fd: descriptor(text) }),
      ).rejects.toBeInstanceOf(CredentialInputError);
    }
  });

  it("rejects descriptors into forbidden storage and standard streams", async () => {
    const fd = descriptor(
      JSON.stringify({
        username: "invented-user",
        password: "invented-password",
      }),
    );
    await expect(
      loadCredentials({ fd, forbiddenDirectory: directory }),
    ).rejects.toBeInstanceOf(CredentialInputError);
    for (const fd of [0, 1, 2, -1, Number.NaN]) {
      await expect(loadCredentials({ fd })).rejects.toBeInstanceOf(
        CredentialInputError,
      );
    }
  });

  it("requires a terminal when no private descriptor is supplied", async () => {
    await expect(loadCredentials()).rejects.toThrow("interactive terminal");
  });
});
