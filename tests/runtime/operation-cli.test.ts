import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createApplication,
  type OperationDefinition,
  operationDefinitions,
  type OperationInvoker,
} from "../../src/application/operations.js";
import type { RefreshStartResult } from "../../src/application/refreshes.js";
import { main } from "../../src/cli.js";
import {
  enclosingCheckout,
  protectedDirectory,
} from "../../src/runtime/checkout.js";
import { startNodeService } from "../../src/runtime/node-service.js";
import {
  aliasNames,
  operationFields,
  operationForCommand,
  operationHelp,
  operationInput,
  operationOptions,
  runOperationCli,
} from "../../src/runtime/operation-cli.js";
import { openDatabase } from "../../src/storage/sqlite/database.js";
import { createHttpService } from "../../src/transport/http.js";
import {
  createRestClient,
  remoteOrigin,
} from "../../src/transport/rest-client.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const token = "synthetic-local-api-token-000000000000000000";

/** Runs the CLI in process; its stdout is the command's JSON output. */
async function cli(...args: string[]) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((text) => {
    stdout += String(text);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    stderr += String(text);
    return true;
  });
  try {
    const status = await main(args);
    return { status, stdout, stderr };
  } finally {
    vi.restoreAllMocks();
  }
}

const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The command line for an operation input: scalars as text, the rest as JSON. */
function flagsFor(input: Record<string, unknown>): string[] {
  return Object.entries(input).flatMap(([key, value]) => [
    `--${kebab(key)}`,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}

/** Write times differ between copies; everything else must match exactly. */
function withoutTimes(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutTimes);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        ["createdAt", "updatedAt"].includes(key)
          ? "<time>"
          : withoutTimes(entry),
      ]),
    );
  }
  return value;
}

async function seedConnection(db: string, id: string, provider: string) {
  expect((await cli("init", "--db", db)).status).toBe(0);
  return cli("connect", provider, "--name", id, "--offline", "--db", db);
}

describe("operation commands", () => {
  let directory: string;
  let seed: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "fonds-operation-cli-"));
    chmodSync(directory, 0o700);
    vi.stubEnv("FONDS_STATE_DIR", directory);
    seed = join(directory, "seed.sqlite");
    expect((await seedConnection(seed, "synthetic-cli", "cal")).status).toBe(0);
    for (const [run, file] of [
      ["synthetic-run-1", "recent-01.json"],
      ["synthetic-run-2", "recent-02.json"],
    ]) {
      const result = await cli(
        "ingest",
        "--db",
        seed,
        "--connection",
        "synthetic-cli",
        "--account",
        "synthetic-account",
        "--run",
        run!,
        "--file",
        join(repositoryRoot, "tests/providers/cal/fixtures", file!),
        "--captured-at",
        "2040-06-01T00:00:00Z",
      );
      expect(result.status).toBe(0);
    }
    const database = await openDatabase(seed);
    try {
      // Card discovery adds the billing account that get_account reads.
      await database.recordCardDiscovery("synthetic-cli", {
        observedAt: "2040-06-01T00:00:00Z",
        cards: [
          {
            cardKey: "SYNTHETIC-CARD-A",
            last4: null,
            billingAccount: { providerKey: "synthetic-account" },
          },
        ],
      });
    } finally {
      await database.close();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("names every operation as a kebab-case command with derived flags", () => {
    for (const definition of operationDefinitions) {
      expect(operationForCommand(definition.name.replaceAll("_", "-"))).toBe(
        definition,
      );
    }
    expect(operationForCommand("list")?.name).toBe("list_transactions");
    expect(operationForCommand("list_transactions")).toBeUndefined();
    expect(operationForCommand("ingest")).toBeUndefined();
    const update = operationForCommand("update-annotation")!;
    expect(
      operationInput(update, {
        "transaction-id": "synthetic",
        "expected-version": "3",
        notes: "",
        "expected-transaction-version": "2",
        tags: '["a"]',
        review: "null",
      }),
    ).toEqual({
      transactionId: "synthetic",
      expectedVersion: 3,
      expectedTransactionVersion: 2,
      notes: null,
      tags: ["a"],
      review: null,
    });
    expect(() =>
      operationInput(update, { "transaction-id": "synthetic" }),
    ).toThrow("--expected-version is required.");
    // Validator messages could quote supplied keys; only fixed text is shown.
    let message = "";
    try {
      operationInput(update, {
        "transaction-id": "synthetic",
        "expected-version": "0",
        "expected-transaction-version": "1",
        review: '{"Bearer synthetic-secret": 1}',
        metadata: '{"nested": {"Bearer synthetic-secret": []}}',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Invalid input: --review /);
    expect(message).not.toContain("synthetic-secret");
    for (const flag of ["billing-account-id", "purchase-id", "card-id"]) {
      expect(() =>
        operationInput(operationForCommand("list")!, {
          [flag]: "..",
          perspective: "all",
        }),
      ).toThrow(`--${flag}: Identifiers cannot be`);
    }
  });

  it.each(operationDefinitions.map((definition) => definition.name))(
    "gives %s a summary and an example its operation accepts",
    (name) => {
      const definition = operationDefinitions.find(
        (entry) => entry.name === name,
      )!;
      const command = name.replaceAll("_", "-");
      const help = operationHelp(definition);
      expect(help.split("\n")[0]).toMatch(new RegExp(`^${command} — \\S`));
      const example = /^Example:\n {2}(.+)$/m.exec(help)![1]!;
      const [typed, ...args] = [...example.matchAll(/'([^']*)'|(\S+)/g)].map(
        (match) => match[1] ?? match[2]!,
      );
      expect(typed).toBe(command);
      const { values } = parseArgs({
        args,
        strict: true,
        options: operationOptions(definition),
      });
      expect(() =>
        operationInput(definition, values as Record<string, string>),
      ).not.toThrow();
    },
  );

  it.each(aliasNames())("names the %s alias in both helps", (alias) => {
    const definition = operationForCommand(alias)!;
    expect(operationHelp(definition, {}, { name: alias })).toMatch(
      new RegExp(
        `^${alias} — .*\\nAlias of ${definition.name.replaceAll("_", "-")}\\.`,
      ),
    );
    expect(operationHelp(definition)).toContain(`Alias: ${alias}.`);
  });

  it("matches the application in process and over REST for every read and mutation", async () => {
    const copies: string[] = [];
    for (const name of ["cli", "direct", "rest"]) {
      // A coherent backup; copying the file alone would miss WAL contents.
      const path = join(directory, `${name}.sqlite`);
      expect((await cli("backup", "--db", seed, "--out", path)).status).toBe(0);
      copies.push(path);
    }
    const [cliPath, directPath, restPath] = copies as [string, string, string];
    const directStore = await openDatabase(directPath);
    const restStore = await openDatabase(restPath);
    const refreshed: RefreshStartResult = {
      connectionId: "synthetic-cli",
      reason: null,
      refresh: {
        id: "synthetic-refresh",
        connectionId: "synthetic-cli",
        trigger: "manual",
        status: "completed",
        skipReason: null,
        range: null,
        occurrence: null,
        scheduledAt: null,
        createdAt: "2040-01-01T00:00:00.000Z",
        startedAt: "2040-01-01T00:00:00.000Z",
        finishedAt: "2040-01-01T00:00:01.000Z",
        requiresAttention: false,
        counts: {
          captures: 0,
          unchanged: 0,
          observed: 0,
          unchangedTransactions: 0,
          unlisted: 0,
          failures: 0,
          created: 0,
          updated: 0,
        },
        failureCodes: [],
        failureReason: null,
        missed: null,
        windows: [],
      },
    };
    // The CLI has no refresh capability; direct and REST get a synthetic one.
    const capabilities = {
      refreshes: {
        start: async () => refreshed,
        startAll: async () => [refreshed],
      },
    };
    const service = createHttpService(
      createApplication(restStore, capabilities),
      { token },
    );
    const exercised = new Set<string>();
    try {
      const direct: OperationInvoker = {
        invoke: (name, input) =>
          createApplication(directStore, capabilities)
            .operations.find((operation) => operation.name === name)!
            .execute(input),
      };
      const rest = createRestClient({
        origin: "http://127.0.0.1",
        token,
        fetch: async (url, init) => service.app.fetch(new Request(url, init)),
      });
      const compare = async (name: string, input: Record<string, unknown>) => {
        exercised.add(name);
        const command = name.replaceAll("_", "-");
        const fromCli = await cli(command, "--db", cliPath, ...flagsFor(input));
        expect(fromCli.stderr, command).toBe("");
        const expected = await direct.invoke(name, input);
        expect(withoutTimes(JSON.parse(fromCli.stdout)), command).toEqual(
          withoutTimes(expected),
        );
        expect(withoutTimes(await rest.invoke(name, input)), command).toEqual(
          withoutTimes(expected),
        );
        return expected;
      };
      const transactions = (await compare("list_transactions", {
        perspective: "all",
        limit: 50,
      })) as { data: { id: string; status: string; version: number }[] };
      const target = transactions.data.find((row) => row.status === "posted")!;
      const cards = (await compare("list_cards", {
        connectionId: "synthetic-cli",
      })) as { data: { id: string }[] };
      for (const [name, input] of [
        ["list_connections", {}],
        ["get_connection", { connectionId: "synthetic-cli" }],
        ["get_card", { cardId: cards.data[0]!.id }],
        ["list_accounts", { connectionId: "synthetic-cli" }],
        [
          "get_account",
          {
            accountId: (
              (await direct.invoke("list_accounts", {
                connectionId: "synthetic-cli",
              })) as { data: { id: string }[] }
            ).data[0]!.id,
          },
        ],
        [
          "list_transactions",
          {
            status: "posted",
            merchantName: "בית עסק סינתטי REGULAR",
            limit: 2,
          },
        ],
        [
          "get_transaction",
          { transactionId: target.id, includeEvidence: true },
        ],
        ["get_transaction", { transactionId: target.id, detail: false }],
        [
          "get_transaction_totals",
          { connectionId: "synthetic-cli", perspective: "billing" },
        ],
        ["list_events", { connectionId: "synthetic-cli", limit: 3 }],
        ["list_sync_runs", { connectionId: "synthetic-cli", limit: 1 }],
      ] as const) {
        await compare(name, input);
      }

      await compare("update_annotation", {
        transactionId: target.id,
        expectedVersion: 0,
        expectedTransactionVersion: target.version,
        notes: "Synthetic note",
        category: "Synthetic category",
        tags: ["synthetic-b", "synthetic-a"],
        metadata: { source: "parity", count: 2 },
        review: { status: "approved" },
      });
      const events = (await direct.invoke("list_events", {
        connectionId: "synthetic-cli",
        limit: 200,
      })) as { data: { id: number; type: string }[] };
      await compare("undo_annotation", {
        eventId: events.data.findLast(
          (event) => event.type === "annotation.updated",
        )!.id,
        expectedVersion: 1,
      });

      const rows = (await direct.invoke("list_transactions", {
        perspective: "all",
        limit: 200,
      })) as { data: { id: string; status: string; version: number }[] };
      // Source keys are private, so the pair is found through storage.
      const stored = await directStore.listTransactions({});
      const bySource = (part: string) =>
        stored.find((row) => row.sourceKey.includes(part))!.id;
      const pendingId = bySource("SYNTHETIC-AUTH-PENDING-POSTED");
      const postedId = bySource("SYNTHETIC-TXN-PENDING-POSTED");
      const version = (id: string) =>
        rows.data.find((row) => row.id === id)!.version;
      const posting = {
        transactionId: pendingId,
        postedId,
        expectedPendingTransactionVersion: version(pendingId),
        expectedPostedTransactionVersion: version(postedId),
        expectedPendingAnnotationVersion: 0,
        expectedPostedAnnotationVersion: 0,
        reason: "Synthetic owner confirmation",
      };
      const linked = (await compare("link_pending_transaction", posting)) as {
        transaction: { version: number };
      };
      const retired = (await direct.invoke("get_transaction", {
        transactionId: postedId,
      })) as { transaction: { version: number } };
      const unlinked = (await compare("unlink_pending_transaction", {
        ...posting,
        expectedPendingTransactionVersion: linked.transaction.version,
        expectedPostedTransactionVersion: retired.transaction.version,
        reason: "Synthetic owner correction",
      })) as { pending: { version: number } };
      await compare("confirm_removal", {
        transactionId: pendingId,
        expectedTransactionVersion: unlinked.pending.version,
        reason: "Synthetic owner removal",
      });
      await compare("list_events", {
        connectionId: "synthetic-cli",
        limit: 200,
      });
      await compare("list_transactions", {
        perspective: "all",
        includeSuperseded: true,
        limit: 200,
      });

      await compare("list_refreshes", { connectionId: "synthetic-cli" });
      exercised.add("get_refresh");
      for (const invoker of [direct, rest]) {
        await expect(
          invoker.invoke("get_refresh", { refreshId: "missing" }),
        ).rejects.toThrow();
      }
      // Refresh exists only where the runtime supplies collection.
      exercised.add("refresh_connection");
      expect(await rest.invoke("refresh_connection", {})).toEqual(
        await direct.invoke("refresh_connection", {}),
      );
      expect(
        await rest.invoke("refresh_connection", {
          connectionId: "synthetic-cli",
        }),
      ).toEqual(
        await direct.invoke("refresh_connection", {
          connectionId: "synthetic-cli",
        }),
      );
      expect(
        await cli(
          "refresh-connection",
          "--db",
          cliPath,
          "--connection-id",
          "synthetic-cli",
        ),
      ).toMatchObject({
        status: 1,
        stderr: "This operation is not available on this backend.\n",
      });
      expect([...exercised].sort()).toEqual(
        operationDefinitions.map((definition) => definition.name).sort(),
      );

      const missing = await cli(
        "get-account",
        "--db",
        cliPath,
        "--account-id",
        "missing",
      );
      expect(missing).toMatchObject({
        status: 1,
        stdout: "",
        stderr: "not_found: Requested record was not found.\n",
      });
      await expect(
        rest.invoke("get_account", { accountId: "missing" }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
    } finally {
      await service.close();
      await Promise.all([directStore.close(), restStore.close()]);
    }
  });

  it("calls a running service with --remote and a private token file", async () => {
    const store = await openDatabase(seed);
    const running = await startNodeService(store, { token, port: 0 });
    const tokenFile = join(directory, "api-token");
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    try {
      const remote = await cli(
        "list-connections",
        "--remote",
        running.url,
        "--token-file",
        tokenFile,
      );
      expect(remote).toMatchObject({ status: 0, stderr: "" });
      expect(JSON.parse(remote.stdout).data).toEqual([
        expect.objectContaining({ id: "synthetic-cli", provider: "cal" }),
      ]);
      // A terminal renders a remote result exactly as the embedded one.
      const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        configurable: true,
      });
      try {
        const shown = await cli(
          "list-connections",
          "--remote",
          running.url,
          "--token-file",
          tokenFile,
        );
        expect(shown.stdout).toMatch(/ID +Provider +Name +Last refresh/);
        expect(shown).toEqual(await cli("list-connections", "--db", seed));
      } finally {
        if (tty) {
          Object.defineProperty(process.stdout, "isTTY", tty);
        } else {
          delete (process.stdout as { isTTY?: boolean }).isTTY;
        }
      }
      // No token is sent without an explicit --token-file, not even the
      // environment's or the local state's to a loopback port.
      vi.stubEnv("FONDS_API_TOKEN", token);
      expect(await cli("list-connections", "--remote", running.url)).toEqual({
        status: 1,
        stdout: "",
        stderr:
          "--remote needs --token-file <a private 0600 file holding the API token>.\n",
      });
      vi.stubEnv("FONDS_API_TOKEN", undefined);
      expect(
        await cli("list-connections", "--remote", running.url, "--db", seed),
      ).toMatchObject({
        status: 1,
        stderr: "--db does not apply with --remote.\n",
      });
      const wrongToken = join(directory, "wrong-token");
      writeFileSync(wrongToken, `${"x".repeat(43)}\n`, { mode: 0o600 });
      expect(
        await cli(
          "list-connections",
          "--remote",
          running.url,
          "--token-file",
          wrongToken,
        ),
      ).toMatchObject({
        status: 1,
        stdout: "",
        stderr: "unauthorized: Authentication required.\n",
      });
      chmodSync(tokenFile, 0o644);
      const exposed = await cli(
        "list-connections",
        "--remote",
        running.url,
        "--token-file",
        tokenFile,
      );
      expect(exposed.status).toBe(1);
      expect(exposed.stderr).toContain("private current-owner 0600 file");
      // "." cannot travel as a path segment, so every transport rejects it alike.
      const dot =
        'Invalid input: --connection-id: Identifiers cannot be "." or "..".\n';
      for (const args of [
        ["get-connection", "--connection-id", ".", "--db", seed],
        [
          "get-connection",
          "--connection-id",
          "..",
          "--remote",
          running.url,
          "--token-file",
          join(directory, "wrong-token"),
        ],
      ]) {
        expect(await cli(...args)).toMatchObject({ status: 1, stderr: dot });
      }
      await expect(
        createRestClient({ origin: running.url, token }).invoke(
          "get_connection",
          { connectionId: "." },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect((await seedConnection(seed, "..", "cal")).status).toBe(1);
      for (const [args, message] of [
        [
          ["list-connections", "--remote", "https://fonds.example.invalid"],
          "--remote needs --token-file <a private 0600 file holding the API token>.",
        ],
        [
          ["list-connections", "--remote", "http://example.invalid"],
          "The remote must be an https:// origin, or http:// on this machine, without a path.",
        ],
        [
          ["ingest", "--remote", running.url, "--connection", "x"],
          "Operator commands use a local database only; --remote runs operation commands.",
        ],
        [
          ["list-connections", "--token-file", tokenFile, "--db", seed],
          "--token-file requires --remote.",
        ],
      ] as const) {
        const result = await cli(...args);
        expect(result).toMatchObject({ status: 1, stdout: "" });
        expect(result.stderr).toBe(`${message}\n`);
        expect(result.stderr).not.toContain(token);
      }
    } finally {
      await running.close();
      await store.close();
    }
  });

  it("prints fixed local text for remote errors, never the remote's own", async () => {
    const respond = (status: number, body: unknown) =>
      createRestClient({
        origin: "https://fonds.example.invalid",
        token,
        fetch: async () => Response.json(body, { status }),
      });
    const secret = "Bearer synthetic-leaked-token-value";
    await expect(
      respond(409, { error: { code: "conflict", message: secret } }).invoke(
        "list_connections",
        {},
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "State changed or the action conflicts with current state. Read it again before retrying.",
    });
    for (const body of [
      { error: { code: secret, message: secret } },
      { error: { code: "toString", message: secret } },
      secret,
    ]) {
      const failure = await respond(500, body)
        .invoke("list_connections", {})
        .catch((error: Error) => error);
      expect(failure).toMatchObject({
        code: "request_failed",
        message: "The remote request failed with HTTP 500.",
      });
      expect(JSON.stringify(failure)).not.toContain("synthetic-leaked");
    }
  });

  it("returns a failing status with a fixed message when closing fails", async () => {
    const leak = "postgres://synthetic:synthetic-password@host/db";
    for (const invoke of [
      async () => ({}),
      async () => {
        throw new Error(leak);
      },
    ]) {
      let stderr = "";
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation((text) => {
        stderr += String(text);
        return true;
      });
      try {
        expect(
          await runOperationCli({
            definition: operationForCommand("list-connections")!,
            args: [],
            connect: async () => ({
              invoker: { invoke },
              close: async () => {
                throw new Error(leak);
              },
            }),
          }),
        ).toBe(1);
      } finally {
        vi.restoreAllMocks();
      }
      expect(stderr).toContain("Could not close the database.\n");
      expect(stderr).not.toContain("synthetic-password");
    }
  });

  it("finds the checkout from a bundled entry at any depth", () => {
    const checkout = mkdtempSync(join(tmpdir(), "fonds-checkout-"));
    try {
      mkdirSync(join(checkout, ".git"));
      writeFileSync(join(checkout, ".git/HEAD"), "ref: refs/heads/main\n");
      const bundled = join(checkout, "dist/targets/sqlite/cli.js");
      mkdirSync(dirname(bundled), { recursive: true });
      writeFileSync(bundled, "");
      expect(enclosingCheckout(pathToFileURL(bundled).href)).toBe(
        realpathSync(checkout),
      );
      // A bare `.git` name without HEAD is not a checkout.
      rmSync(join(checkout, ".git/HEAD"));
      expect(enclosingCheckout(pathToFileURL(bundled).href)).not.toBe(
        realpathSync(checkout),
      );
      // Installed, the package directory is protected, never its parent.
      writeFileSync(join(checkout, "dist/targets/sqlite/package.json"), "{}");
      expect(protectedDirectory(pathToFileURL(bundled).href)).toBe(
        realpathSync(dirname(bundled)),
      );
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("accepts only HTTPS or loopback HTTP origins without paths", () => {
    expect(remoteOrigin("https://fonds.example.invalid")).toBe(
      "https://fonds.example.invalid",
    );
    expect(remoteOrigin("http://[::1]:8787/")).toBe("http://[::1]:8787");
    for (const value of [
      "http://fonds.example.invalid",
      "https://user:pw@fonds.example.invalid",
      "https://fonds.example.invalid/prefix",
      "https://fonds.example.invalid/?token=x",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(() => remoteOrigin(value), value).toThrow();
    }
  });
});

describe("operation flag schemas", () => {
  const base = operationForCommand("list-connections")!;
  const withInput = (shape: z.ZodRawShape): OperationDefinition => ({
    ...base,
    inputSchema: z.object(shape),
  });

  it("derives flags for every supported schema kind", () => {
    const definition = withInput({
      text: z.string(),
      choice: z.enum(["a", "b"]),
      count: z.number().int(),
      enabled: z.boolean(),
      version: z.union([z.number().int().positive(), z.literal(0)]),
      same: z.union([z.string(), z.enum(["c"])]),
      mixed: z.union([z.string(), z.number()]),
      list: z.array(z.string()),
      nested: z.object({ value: z.string() }),
      map: z.record(z.string(), z.number()),
      later: z.string().optional(),
      fallback: z.number().default(1),
      cleared: z.string().nullable(),
      clearedLater: z.boolean().nullable().optional(),
    });
    expect(
      operationFields(definition).map(({ key, kind, required, nullable }) => [
        key,
        kind,
        required,
        nullable,
      ]),
    ).toEqual([
      ["text", "string", true, false],
      ["choice", "string", true, false],
      ["count", "number", true, false],
      ["enabled", "boolean", true, false],
      ["version", "number", true, false],
      ["same", "string", true, false],
      ["mixed", "json", true, false],
      ["list", "json", true, false],
      ["nested", "json", true, false],
      ["map", "json", true, false],
      ["later", "string", false, false],
      ["fallback", "number", false, false],
      ["cleared", "string", true, true],
      ["clearedLater", "boolean", false, true],
    ]);
    expect(
      operationInput(definition, {
        text: "x",
        choice: "a",
        count: "-2",
        enabled: "false",
        version: "0",
        same: "c",
        mixed: "3",
        list: '["y"]',
        nested: '{"value":"z"}',
        map: '{"k":1}',
        cleared: "",
        "cleared-later": "true",
      }),
    ).toEqual({
      text: "x",
      choice: "a",
      count: -2,
      enabled: false,
      version: 0,
      same: "c",
      mixed: 3,
      list: ["y"],
      nested: { value: "z" },
      map: { k: 1 },
      cleared: null,
      clearedLater: true,
    });
  });

  it("derives flags for every operation", () => {
    for (const definition of operationDefinitions) {
      expect(() => operationFields(definition), definition.name).not.toThrow();
    }
  });

  it.each([
    ["pipe", z.string().transform((value) => value.length)],
    ["date", z.date()],
    ["bigint", z.bigint()],
    ["unknown", z.unknown()],
    ["readonly", z.array(z.string()).readonly()],
    ["catch", z.string().catch("x")],
    ["lazy", z.lazy(() => z.string())],
    ["literal", z.literal("x")],
    ["literal", z.union([z.number(), z.literal("x")])],
    ["optional", z.union([z.number(), z.string().optional()])],
  ])(
    "rejects an unsupported %s schema before reading input",
    async (kind, schema) => {
      const definition = withInput({ field: schema });
      const message = `Input field field uses a schema kind the command line does not support (${kind}).`;
      expect(() => operationFields(definition)).toThrow(message);
      expect(() => operationInput(definition, {})).toThrow(message);
      const connect = vi.fn();
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        expect(
          await runOperationCli({
            definition,
            args: ["--field", "1"],
            connect,
          }),
        ).toBe(1);
      } finally {
        vi.restoreAllMocks();
      }
      expect(connect).not.toHaveBeenCalled();
    },
  );
});
