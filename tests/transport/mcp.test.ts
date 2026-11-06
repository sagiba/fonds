import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type Application,
  createApplication,
} from "../../src/application/operations.js";
import {
  presentAccount,
  presentCard,
  presentWireEvent,
  presentWireTotals,
  presentWireTransaction,
} from "../../src/application/wire-output.js";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  type Database,
  openDatabase,
} from "../../src/storage/sqlite/database.js";
import { createMcpHttpHandler } from "../../src/transport/mcp.js";

const connectionId = "synthetic-mcp-cal";
const modes = ["modern", "legacy"] as const;

type Mode = (typeof modes)[number];

describe("MCP SDK v2 over HTTP", () => {
  let db: Database;
  let application: Application;
  let handler: McpHttpHandler;
  let server: Server;
  let url: URL;
  const clients: Client[] = [];
  const requests: { method: string; params?: Record<string, unknown> }[] = [];
  const responses: {
    method: string;
    status: number;
    contentType: string | null;
    sessionId: string | null;
  }[] = [];

  async function capture(name: string, day: number, adapter = calAdapter) {
    return await db.ingestRun(
      {
        runId: `synthetic-mcp-${name}-${day}`,
        connectionId,
        responses: [
          {
            accountKey: "synthetic-account",
            endpoint: "/synthetic-financial-response",
            capturedAt: `2040-08-${String(day).padStart(2, "0")}T00:00:00Z`,
            responseText: readFileSync(
              new URL(
                `../providers/cal/fixtures/${name}.json`,
                import.meta.url,
              ),
              "utf8",
            ),
          },
        ],
      },
      adapter,
    );
  }

  async function connect(mode: Mode) {
    const client = new Client(
      { name: "synthetic-mcp-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy",
        },
      },
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body =
            request.method === "POST"
              ? await request.clone().json()
              : undefined;
          if (body) {
            requests.push(body);
          }
          const response = await fetch(request);
          responses.push({
            method: body?.method ?? request.method,
            status: response.status,
            contentType: response.headers.get("content-type"),
            sessionId: response.headers.get("mcp-session-id"),
          });
          return response;
        },
      }),
    );
    return client;
  }

  beforeEach(async () => {
    requests.length = 0;
    responses.length = 0;
    db = await openDatabase(":memory:");
    await db.ensureConnection({
      id: connectionId,
      provider: "cal",
      displayName: "Synthetic card",
    });
    await capture("recent-01", 1);
    application = createApplication(db);
    handler = createMcpHttpHandler(application);
    const app = new Hono();
    // The HTTP boundary normally supplies the verified grant.
    app.all("/mcp", (c) =>
      handler.fetch(c.req.raw, {
        authInfo: {
          token: "",
          clientId: "local",
          scopes: ["financial:read", "financial:write"],
        },
      }),
    );
    server = await new Promise<Server>((resolve) => {
      const instance = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        () => resolve(instance as Server),
      );
    });
    url = new URL(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    );
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await handler.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await db.close();
  });

  it.each(modes)(
    "advertises schemas and uses the %s protocol handshake",
    async (mode) => {
      await db.recordCardDiscovery(connectionId, {
        observedAt: "2040-02-01T00:00:00Z",
        cards: [
          {
            cardKey: "synthetic/card:0012",
            last4: "0012",
            displayName: "Synthetic card",
            billingAccount: { providerKey: "SYNTHETIC-PRIVATE-ACCOUNT" },
          },
        ],
      });
      await db.updateConfig(connectionId, (config) => ({
        ...config,
        privateSetting: "SYNTHETIC-PRIVATE",
      }));
      const client = await connect(mode);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        application.operations.map((operation) => operation.name),
      );
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "list_accounts",
          "get_account",
          "list_cards",
          "get_card",
          "get_transaction_totals",
          "list_events",
          "list_sync_runs",
          "link_pending_transaction",
          "unlink_pending_transaction",
          "confirm_removal",
        ]),
      );
      for (const operation of application.operations) {
        expect(
          tools.find((tool) => tool.name === operation.name),
        ).toMatchObject({
          description: operation.description,
          inputSchema: { type: "object", additionalProperties: false },
          outputSchema: { type: "object", additionalProperties: false },
          annotations: {
            // Every read, refresh reads included, is pure and stays inside Fonds.
            readOnlyHint: operation.access === "read",
            destructiveHint: operation.access === "write",
            idempotentHint: operation.access === "read",
            openWorldHint: false,
          },
        });
      }
      expect(
        tools.find((tool) => tool.name === "update_annotation")?.inputSchema,
      ).toMatchObject({
        required: expect.arrayContaining(["transactionId", "expectedVersion"]),
        properties: {
          expectedVersion: { type: "integer", minimum: 0 },
          expectedTransactionVersion: { type: "integer" },
        },
      });
      for (const name of ["list_transactions", "get_transaction_totals"]) {
        expect(
          tools.find((tool) => tool.name === name)?.inputSchema,
        ).toMatchObject({
          properties: {
            presence: {
              enum: ["seen", "not_returned", "removed", "current", "all"],
              default: "current",
            },
          },
        });
        const historical = await client.callTool({
          name,
          arguments: { presence: "all" },
        });
        expect(historical.isError).not.toBe(true);
      }
      const annotationTool = tools.find(
        (tool) => tool.name === "update_annotation",
      )!;
      expect(annotationTool.inputSchema).not.toHaveProperty(
        "properties.expectedAnnotationVersion",
      );
      expect(annotationTool.inputSchema).not.toHaveProperty("properties.data");
      expect(annotationTool.inputSchema).not.toHaveProperty(
        "properties.expectedFinancialVersion",
      );
      const postingTool = tools.find(
        (tool) => tool.name === "link_pending_transaction",
      )!;
      expect(postingTool.inputSchema).toMatchObject({
        required: expect.arrayContaining([
          "transactionId",
          "postedId",
          "expectedPendingTransactionVersion",
          "expectedPostedTransactionVersion",
        ]),
      });
      expect(postingTool.inputSchema).not.toHaveProperty(
        "properties.pendingId",
      );
      expect(postingTool.inputSchema).not.toHaveProperty(
        "properties.expectedPendingVersion",
      );
      expect(postingTool.inputSchema).not.toHaveProperty(
        "properties.expectedPostedVersion",
      );
      expect(requests[0]?.method).toBe(
        mode === "modern" ? "server/discover" : "initialize",
      );
      if (mode === "modern") {
        expect(
          requests.some((request) => request.method === "initialize"),
        ).toBe(false);
        expect(
          responses
            .filter((response) => response.status === 200)
            .every((response) =>
              response.contentType?.includes("application/json"),
            ),
        ).toBe(true);
      } else {
        expect(requests[0]?.params?.protocolVersion).toBe("2025-11-25");
      }
      expect(responses.every((response) => response.sessionId === null)).toBe(
        true,
      );
      const listed = await client.callTool({
        name: "list_connections",
        arguments: {},
      });
      expect(listed.structuredContent).toEqual({
        data: [
          {
            id: connectionId,
            provider: "cal",
            displayName: "Synthetic card",
            createdAt: expect.any(String),
            latestRefresh: null,
          },
        ],
        hasMore: false,
        nextCursor: null,
      });
      const cards = await client.callTool({
        name: "list_cards",
        arguments: { connectionId, limit: 1 },
      });
      const cardPage = await db.listCards({ connectionId, limit: 1 });
      expect(cards.structuredContent).toEqual({
        data: cardPage.cards.map(presentCard),
        hasMore: cardPage.hasMore,
        nextCursor: cardPage.hasMore ? expect.any(String) : null,
      });
      const discovered = (await db.listCards({ connectionId })).cards.find(
        (card) => card.providerKey === "synthetic/card:0012",
      )!;
      const readCard = await client.callTool({
        name: "get_card",
        arguments: { cardId: discovered.id },
      });
      expect(readCard.structuredContent).toEqual({
        card: presentCard(discovered),
      });
      const accounts = await client.callTool({
        name: "list_accounts",
        arguments: { connectionId },
      });
      const [account] = (await db.listAccounts({ connectionId })).accounts;
      expect(accounts.structuredContent).toEqual({
        data: [presentAccount(account!)],
        hasMore: false,
        nextCursor: null,
      });
      const readAccount = await client.callTool({
        name: "get_account",
        arguments: { accountId: discovered.billingAccountId },
      });
      expect(readAccount.structuredContent).toEqual({
        account: presentAccount(account!),
      });
      expect(JSON.stringify([accounts, readAccount])).not.toContain(
        "SYNTHETIC-PRIVATE",
      );
      const missingCard = await client.callTool({
        name: "get_card",
        arguments: { cardId: "missing" },
      });
      expect(missingCard).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "not_found" } },
      });
      expect(JSON.stringify(cards)).not.toContain("SYNTHETIC-PRIVATE");
      expect(JSON.stringify(readCard)).not.toMatch(
        /accountKey|cardKey|providerKey|synthetic\/card:0012/,
      );
      expect(listed.content).toEqual([
        { type: "text", text: JSON.stringify(listed.structuredContent) },
      ]);
      expect(JSON.stringify(listed)).not.toContain("config");
      expect(JSON.stringify(listed)).not.toContain("SYNTHETIC-PRIVATE");
    },
  );

  it.each(modes)(
    "publishes only patterns without lookaround or named groups using %s",
    async (mode) => {
      // Connector-side JSON Schema validators commonly lack these ECMAScript extensions.
      const { tools } = await (await connect(mode)).listTools();
      const patterns: string[] = [];
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(collect);
        } else if (value !== null && typeof value === "object") {
          for (const [key, entry] of Object.entries(value)) {
            if (key === "pattern" && typeof entry === "string") {
              patterns.push(entry);
            } else {
              collect(entry);
            }
          }
        }
      };
      collect(tools);
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns.filter((pattern) => /\(\?[=!<]/.test(pattern))).toEqual(
        [],
      );
    },
  );

  it.each(modes)(
    "shares canonical reads, annotation writes and conflicts using %s",
    async (mode) => {
      const client = await connect(mode);
      const row = (await db.listTransactions()).find((row) =>
        row.sourceKey.includes("SYNTHETIC-TXN-REGULAR"),
      )!;
      const totals = await client.callTool({
        name: "get_transaction_totals",
        arguments: { connectionId },
      });
      expect(totals.structuredContent).toEqual(
        presentWireTotals(await db.getTotals({ connectionId })),
      );
      const edited = await client.callTool({
        name: "update_annotation",
        arguments: {
          transactionId: row.id,
          expectedVersion: 0,
          notes: "Synthetic MCP note",
        },
      });
      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toEqual({
        annotation: { transactionId: row.id, version: 1 },
      });
      const current = (await db.getTransaction(row.id))!;
      expect(current.annotation).toMatchObject({
        version: 1,
        data: { notes: "Synthetic MCP note" },
      });
      const beforeConflict = await db.listEvents();
      const conflict = await client.callTool({
        name: "update_annotation",
        arguments: {
          transactionId: row.id,
          expectedVersion: 0,
          notes: "Stale edit",
        },
      });
      expect(conflict).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "conflict" } },
      });
      expect(await db.getTransaction(row.id)).toEqual(current);
      expect(await db.listEvents()).toEqual(beforeConflict);
      const read = await client.callTool({
        name: "get_transaction",
        arguments: { transactionId: row.id },
      });
      expect(read.structuredContent).toEqual({
        transaction: presentWireTransaction(current, true),
      });
      const changes = await client.callTool({
        name: "list_events",
        arguments: { connectionId, limit: 200 },
      });
      expect(changes.structuredContent).toEqual({
        data: beforeConflict.map(presentWireEvent),
        hasMore: false,
        nextCursor: expect.any(String),
      });
    },
  );

  it("returns stored review candidates and reasons by default over MCP", async () => {
    const adapter = { ...calAdapter };
    delete adapter.automaticPosting;
    await capture("recent-02", 2, adapter);
    const rows = await db.listTransactions();
    const pending = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-AUTH-PENDING-POSTED"),
    )!;
    const posted = rows.find((row) =>
      row.sourceKey.includes("SYNTHETIC-TXN-PENDING-POSTED"),
    )!;
    await db.editAnnotation({
      transactionId: pending.id,
      expectedVersion: 0,
      expectedTransactionVersion: pending.version,
      review: { status: "needs_review" },
    });
    const client = await connect("modern");
    const read = await client.callTool({
      name: "get_transaction",
      arguments: { transactionId: pending.id },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      transaction: {
        id: pending.id,
        version: pending.version,
        annotation: { version: 1 },
        review: {
          pendingPostingCandidateIds: [posted.id],
          reasons: expect.arrayContaining([
            "possible_pending_posted_match",
            "user_needs_review",
          ]),
          sourceIssues: ["possible_pending_posted_match"],
          truncated: false,
          counts: {
            pendingPostingCandidateIds: 1,
            reasons: 2,
            sourceIssues: 1,
          },
        },
      },
    });
    expect(read.structuredContent).not.toHaveProperty("transaction.evidence");
    const candidate = await client.callTool({
      name: "get_transaction",
      arguments: { transactionId: posted.id },
    });
    expect(candidate.structuredContent).toMatchObject({
      transaction: {
        id: posted.id,
        version: posted.version,
        annotation: null,
        review: { pendingPostingCandidateIds: [pending.id] },
      },
    });
  });

  it("reads a later canonical correction and retains independent annotations", async () => {
    const client = await connect("modern");
    const before = (await db.listTransactions()).find((row) =>
      row.sourceKey.includes("SYNTHETIC-TXN-CORRECTED"),
    )!;
    const approved = await client.callTool({
      name: "update_annotation",
      arguments: {
        transactionId: before.id,
        expectedVersion: 0,
        expectedTransactionVersion: before.version,
        notes: "Retained note",
        review: { status: "approved" },
      },
    });
    expect(approved.isError).not.toBe(true);
    await capture("recent-02", 2);
    const after = (await db.getTransaction(before.id))!;
    expect(after).toMatchObject({
      amountMinor: -7560,
      version: 2,
      reviewStale: true,
      annotation: { version: 1, data: { notes: "Retained note" } },
    });
    const read = await client.callTool({
      name: "get_transaction",
      arguments: { transactionId: before.id },
    });
    expect(read.structuredContent).toEqual({
      transaction: presentWireTransaction(after, true),
    });
    const staleReview = await client.callTool({
      name: "update_annotation",
      arguments: {
        transactionId: before.id,
        expectedVersion: 1,
        expectedTransactionVersion: 1,
        review: { status: "approved" },
      },
    });
    expect(staleReview).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "conflict" } },
    });
    expect(await db.getTransaction(before.id)).toEqual(after);
  });

  it("rejects invalid and missing input and returns fixed errors for database failures", async () => {
    const client = await connect("modern");
    const row = (await db.listTransactions())[0]!;
    const missing = await client.callTool({
      name: "get_transaction",
      arguments: { transactionId: "synthetic-missing" },
    });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "not_found",
          message: "Requested record was not found.",
        },
      },
    });
    const invalid = await client.callTool({
      name: "update_annotation",
      arguments: {
        transactionId: row.id,
        expectedVersion: 0,
        notes: "ignored",
        actor: "untrusted-actor-value",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("untrusted-actor-value");
    expect((await db.getTransaction(row.id))?.annotation).toBeNull();
    await db.client.executeMultiple(
      "CREATE TRIGGER mcp_failure BEFORE INSERT ON annotations BEGIN SELECT RAISE(ABORT, 'synthetic-private-database-detail'); END;",
    );
    const failed = await client.callTool({
      name: "update_annotation",
      arguments: {
        transactionId: row.id,
        expectedVersion: 0,
        notes: "Synthetic failing edit",
      },
    });
    expect(failed).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "internal_error", message: "Operation failed." },
      },
    });
    expect(JSON.stringify(failed)).not.toContain(
      "synthetic-private-database-detail",
    );
    expect((await db.getTransaction(row.id))?.annotation).toBeNull();
  });

  it("bounds incoming HTTP bodies before creating or invoking tools", async () => {
    const before = await db.listEvents();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(64 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(await db.listEvents()).toEqual(before);
  });
});
