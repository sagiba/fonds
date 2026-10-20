import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calAdapter } from "../../src/providers/cal/adapter.js";
import { startServer } from "../../src/server.js";
import { localState, openBoundDatabase } from "../helpers/local-state.js";

let directory: string;
let dbPath: string;
let running: Awaited<ReturnType<typeof startServer>>;
const clients: Client[] = [];
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "fonds-server-test-"));
  dbPath = join(directory, "service.sqlite");
  const db = await openBoundDatabase(dbPath);
  await db.ensureConnection({ id: "synthetic-cal", provider: "cal" });
  await db.ingestRun(
    {
      runId: "synthetic-server-baseline",
      connectionId: "synthetic-cal",
      responses: [
        {
          accountKey: "synthetic-account",
          endpoint: "synthetic:cal/recent",
          capturedAt: "2040-08-01T00:00:00Z",
          responseText: readFileSync(
            new URL(
              "../providers/cal/fixtures/recent-01.json",
              import.meta.url,
            ),
            "utf8",
          ),
        },
      ],
    },
    calAdapter,
  );
  await db.close();
  chmodSync(dbPath, 0o600);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("runnable local server", () => {
  it("starts authenticated HTTP and MCP against the same existing private database", async () => {
    running = await startServer(["--db", dbPath, "--port", "0"]);
    expect(running?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const { secrets, stateDirectory } = await localState();
    const token = secrets.FONDS_API_TOKEN!;
    expect(statSync(join(stateDirectory!, "fonds.env")).mode & 0o777).toBe(
      0o600,
    );
    expect(existsSync(`${dbPath}.api-token`)).toBe(false);
    expect(
      vi.mocked(process.stderr.write).mock.calls.flat().join(""),
    ).not.toContain(token);
    expect((await fetch(`${running!.url}/v1/connections`)).status).toBe(401);
    const headers = { Authorization: `Bearer ${token}` };
    const data = await (
      await fetch(
        `${running!.url}/v1/transactions?connectionId=synthetic-cal&limit=2`,
        { headers },
      )
    ).json();
    expect(data.data).toHaveLength(2);
    const client = new Client({ name: "local-server-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${running!.url}/mcp`), {
        requestInit: { headers },
      }),
    );
    const result = await client.callTool({
      name: "get_transaction_totals",
      arguments: { connectionId: "synthetic-cal" },
    });
    const httpTotals = await (
      await fetch(
        `${running!.url}/v1/transactions/totals?connectionId=synthetic-cal`,
        {
          headers,
        },
      )
    ).json();
    expect(result.structuredContent).toEqual(httpTotals);
  });

  it("serves a real child-process stdio client with protocol-only stdout", async () => {
    const client = new Client({ name: "stdio-server-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          resolve("src/server.ts"),
          "--db",
          dbPath,
          "--transport",
          "stdio",
        ],
        // The SDK's default child environment omits FONDS_HOME, which keeps
        // the child's state directory out of the real data home.
        env: {
          PATH: process.env.PATH ?? "",
          FONDS_HOME: process.env.FONDS_HOME!,
        },
        stderr: "pipe",
      }),
    );
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "update_annotation")).toBe(
      true,
    );
    const result = await client.callTool({
      name: "list_connections",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: [{ id: "synthetic-cal" }],
    });
  });

  it("closes an active modern MCP subscription before draining the HTTP server", async () => {
    running = await startServer(["--db", dbPath, "--port", "0"]);
    const token = (await localState()).secrets.FONDS_API_TOKEN!;
    const abort = new AbortController();
    const response = await fetch(`${running!.url}/mcp`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "subscriptions/listen",
        params: {
          notifications: { toolsListChanged: true },
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: {
              name: "synthetic-shutdown-test",
              version: "1",
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      expect(
        response.status,
        response.status === 200 ? undefined : await response.clone().text(),
      ).toBe(200);
      reader = response.body?.getReader();
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      expect(reader).toBeDefined();
      expect((await reader!.read()).done).toBe(false);
      let streamComplete = false;
      const streamEnded = (async () => {
        while (!(await reader!.read()).done) {
          /* Drain the graceful-close result. */
        }
        streamComplete = true;
      })();
      await Promise.race([
        Promise.all([running!.close(), streamEnded]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Active MCP subscription prevented shutdown (stream complete: ${streamComplete})`,
                ),
              ),
            1000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      abort.abort();
      await reader?.cancel().catch(() => {});
    }
  });

  it("rejects an OAuth configuration option as unknown", async () => {
    for (const args of [
      ["--oauth-config", "/does-not-exist/private.json"],
      ["--oauth-config=/does-not-exist/private.json"],
    ]) {
      await expect(startServer(args)).rejects.toThrow("Unknown option");
    }
  });

  it("rejects public/symlinked files and incompatible startup options before serving", async () => {
    chmodSync(dbPath, 0o644);
    await expect(startServer(["--db", dbPath])).rejects.toThrow();
    chmodSync(dbPath, 0o600);
    const link = join(directory, "linked.sqlite");
    symlinkSync(dbPath, link);
    await expect(startServer(["--db", link])).rejects.toThrow();
    await expect(
      startServer(["--db", dbPath, "--port", "65536"]),
    ).rejects.toThrow();
    await expect(
      startServer(["--db", dbPath, "--transport", "stdio", "--port", "0"]),
    ).rejects.toThrow();
    await expect(
      startServer(["--db", dbPath, "--token-file", "unused"]),
    ).rejects.toThrow();
  });
});
