import { fstatSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  type CredentialInput,
  CredentialInputError,
  parseCredentials,
  type ProviderCredentials,
  usernamePasswordInput,
} from "../domain/credentials.js";

const maximumBytes = 16 * 1024;

/** A bounded regular file with one link that only the current user can read. */
function isPrivateFile(stat: Stats): boolean {
  return (
    stat.isFile() &&
    stat.nlink === 1 &&
    (stat.mode & 0o077) === 0 &&
    (!process.getuid || stat.uid === process.getuid()) &&
    stat.size <= maximumBytes
  );
}

/** Whether a path, relative to a directory, is that directory or inside it. */
function isWithin(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`))
  );
}

/** Read a bounded private file already opened by the caller, never a filename argument. */
function credentialsFromDescriptor(
  fd: number,
  forbiddenDirectory: string | undefined,
  input: CredentialInput,
): ProviderCredentials {
  try {
    if (!Number.isSafeInteger(fd) || fd < 3) {
      throw new Error();
    }
    if (!isPrivateFile(fstatSync(fd))) {
      throw new Error();
    }
    if (forbiddenDirectory) {
      const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
      const path = realpathSync(`${fdRoot}/${fd}`);
      if (isWithin(relative(realpathSync(forbiddenDirectory), path))) {
        throw new Error();
      }
    }
    // Read one extra byte so a growing file cannot bypass the initial size bound.
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) {
        break;
      }
      length += count;
    }
    try {
      if (length > maximumBytes) {
        throw new Error();
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, length),
      );
      if (text.trimStart().startsWith("{")) {
        return parseCredentials(JSON.parse(text), input);
      }
      // Preserve every password character, including colons and surrounding spaces.
      // A single final LF or CRLF is the only text-format delimiter removed.
      const entry = text.replace(/\r?\n$/, "");
      const separator = entry.indexOf(":");
      if (separator < 1) {
        throw new Error();
      }
      return parseCredentials(
        {
          username: entry.slice(0, separator),
          password: entry.slice(separator + 1),
        },
        input,
      );
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    if (error instanceof CredentialInputError) {
      throw error;
    }
    throw new CredentialInputError(
      "Could not read credentials: use a private current-owner file outside the repository through a descriptor of at least 3.",
    );
  }
}

/** Both fields are hidden; raw terminal mode is restored on success or failure. */
function hiddenField(label: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) {
    throw new CredentialInputError(
      "Credentials require an interactive terminal or --credentials-fd.",
    );
  }
  return new Promise((resolveField, rejectField) => {
    const wasRaw = input.isRaw;
    const wasFlowing = input.readableFlowing === true;
    const decoder = new StringDecoder("utf8");
    let value = "";
    const finish = (error?: CredentialInputError) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.setRawMode(wasRaw);
      if (!wasFlowing) {
        input.pause();
      }
      process.stderr.write("\n");
      if (error) {
        rejectField(error);
      } else {
        resolveField(value);
      }
    };
    const onEnd = () =>
      finish(new CredentialInputError("Credential entry cancelled."));
    const onData = (chunk: Buffer | string) => {
      const characters =
        typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (const character of characters) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new CredentialInputError("Credential entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (!/[\u0000-\u001f]/.test(character)) {
          value += character;
        }
        if (value.length > 4096) {
          finish(new CredentialInputError("Invalid credential input."));
          return;
        }
      }
    };
    process.stderr.write(`${label} (hidden): `);
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onEnd);
    input.resume();
  });
}

export async function loadCredentials(
  options: {
    fd?: number;
    forbiddenDirectory?: string;
    input?: CredentialInput;
  } = {},
): Promise<ProviderCredentials> {
  const input = options.input ?? usernamePasswordInput;
  if (options.fd !== undefined) {
    return credentialsFromDescriptor(
      options.fd,
      options.forbiddenDirectory,
      input,
    );
  }
  const values: ProviderCredentials = {};
  for (const [name, label] of Object.entries(input.fields)) {
    values[name] = await hiddenField(label);
  }
  return parseCredentials(values, input);
}
