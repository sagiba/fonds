import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";

import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateCredentialsKey } from "../../src/runtime/credential-vault.js";
import {
  bootstrapHostedDatabase,
  issueHostedLoginLink,
  startHostedNodeService,
} from "../../src/runtime/hosted-node.js";
import { DRAIN_DEADLINE_MS } from "../../src/runtime/node-service.js";
import { postgresInstallation } from "../../src/runtime/postgres-environment.js";
import { dropWhenIdle } from "../helpers/postgres-database.js";

const postgresUrl = process.env.FONDS_TEST_POSTGRES_URL;

/** What `node server.js login-link` does, with its state resolved once. */
async function loginLink(env: NodeJS.ProcessEnv) {
  const resolved = await postgresInstallation(env, { create: false });
  return issueHostedLoginLink(resolved.env, resolved.installation);
}

/** A currently free loopback port, so the public origin can name it exactly. */
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Better Auth migrations and owner bootstrap take seconds on a busy server.
describe.skipIf(!postgresUrl)(
  "hosted PostgreSQL bootstrap",
  { timeout: 30_000 },
  () => {
    let admin: Pool;
    let databaseName: string;
    let connectionString: string;
    const config = () => ({
      publicOrigin: "https://fonds.synthetic.invalid",
      secret: "synthetic-auth-secret-00000000000000000000",
      ownerId: "synthetic-owner",
      ownerEmail: "owner@fonds.invalid",
      connectionString,
      credentialsKeyId: "synthetic-key-id",
    });

    beforeEach(async () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      admin = new Pool({ connectionString: postgresUrl });
      databaseName = `fonds_bootstrap_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(postgresUrl!);
      url.pathname = `/${databaseName}`;
      connectionString = url.href;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      // FORCE could kill a connection that is mid-shutdown and has no listener.
      await dropWhenIdle(admin, databaseName);
      await admin.end();
    });

    it("creates every schema and the owner once, and is idempotent", async () => {
      await bootstrapHostedDatabase(config());
      await bootstrapHostedDatabase(config());
      const pool = new Pool({ connectionString });
      try {
        const { rows } = await pool.query<{ schema: string; count: string }>(
          `SELECT table_schema AS schema, count(*) FROM information_schema.tables
         WHERE table_schema IN ('financial', 'identity', 'operations')
         GROUP BY table_schema ORDER BY table_schema`,
        );
        expect(rows.map((row) => row.schema)).toEqual([
          "financial",
          "identity",
          "operations",
        ]);
        expect(
          (await pool.query('SELECT id FROM identity."user"')).rows,
        ).toEqual([{ id: "synthetic-owner" }]);
      } finally {
        await pool.end();
      }
    });

    it.each([
      { secret: "different-auth-secret-0000000000000000000000" },
      { ownerId: "different-owner" },
      { credentialsKeyId: "different-key-id" },
      { credentialsKeyId: null },
    ])(
      "refuses secrets that differ from the installation's: %o",
      async (override) => {
        await bootstrapHostedDatabase(config());
        await expect(
          bootstrapHostedDatabase({ ...config(), ...override }),
        ).rejects.toThrow(/do not match the database's installation/);
      },
    );

    it("never adopts a populated database that has no installation record", async () => {
      await bootstrapHostedDatabase(config());
      const pool = new Pool({ connectionString });
      try {
        await pool.query("DELETE FROM operations.installation");
        for (const secrets of [
          config(),
          { ...config(), secret: "replacement-auth-secret-000000000000000000" },
        ]) {
          await expect(bootstrapHostedDatabase(secrets)).rejects.toThrow(
            /no installation record/,
          );
          // A refused start records nothing that could block the original secrets.
          expect(
            (await pool.query("SELECT 1 FROM operations.installation"))
              .rowCount,
          ).toBe(0);
        }
      } finally {
        await pool.end();
      }
    });

    it("resumes a first start interrupted after it began populating", async () => {
      // Better Auth rejects this origin after the fingerprint and the financial
      // schema exist but before the owner: an interrupted first start.
      await expect(
        bootstrapHostedDatabase({
          ...config(),
          publicOrigin: "http://not-loopback.invalid",
        }),
      ).rejects.toThrow();
      const pool = new Pool({ connectionString });
      try {
        expect(
          (await pool.query("SELECT owner_id FROM operations.installation"))
            .rows,
        ).toEqual([{ owner_id: "synthetic-owner" }]);
        expect(
          (await pool.query("SELECT to_regclass('financial.connections') AS t"))
            .rows[0].t,
        ).not.toBeNull();
      } finally {
        await pool.end();
      }
      await expect(
        bootstrapHostedDatabase({
          ...config(),
          secret: "replacement-auth-secret-000000000000000000",
        }),
      ).rejects.toThrow(/do not match/);
      await bootstrapHostedDatabase(config());
    });

    it("rate-limits auth by the trusted client address, never a forwarded claim", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const stateDir = await mkdtemp(`${tmpdir()}/fonds-hosted-state-`);
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const env = {
        FONDS_STATE_DIR: stateDir,
        FONDS_DATABASE_URL: connectionString,
        FONDS_DATABASE_TLS: "disable",
        FONDS_PUBLIC_ORIGIN: origin,
        HOST: "127.0.0.1",
        PORT: String(port),
      };
      const getSession = async (forwardedFor: string) =>
        (
          await fetch(`${origin}/api/auth/get-session`, {
            headers: { "X-Forwarded-For": forwardedFor },
          })
        ).status;
      try {
        // Direct ingress: every request is the socket's peer.
        let running = await startHostedNodeService(env);
        try {
          for (let i = 1; i <= 30; i += 1) {
            expect(await getSession(`203.0.113.${i}`), `request ${i}`).toBe(
              200,
            );
          }
          expect(await getSession("203.0.113.31")).toBe(429);
        } finally {
          await running.close();
        }
        // Behind one trusted proxy: the address it appended.
        running = await startHostedNodeService({
          ...env,
          FONDS_TRUST_PROXY: "1",
        });
        try {
          for (let i = 1; i <= 30; i += 1) {
            expect(
              await getSession(`203.0.113.${i}, 198.51.100.1`),
              `request ${i}`,
            ).toBe(200);
          }
          expect(await getSession("203.0.113.31, 198.51.100.1")).toBe(429);
          expect(await getSession("198.51.100.2")).toBe(200);
        } finally {
          await running.close();
        }
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("collects on the embedded schedule once per occurrence, only when it is on", async () => {
      const { mkdtemp, readFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { parseEnv } = await import("node:util");
      const stateDir = await mkdtemp(`${tmpdir()}/fonds-hosted-state-`);
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const env = {
        FONDS_STATE_DIR: stateDir,
        FONDS_DATABASE_URL: connectionString,
        FONDS_DATABASE_TLS: "disable",
        FONDS_PUBLIC_ORIGIN: origin,
        HOST: "127.0.0.1",
        PORT: String(port),
      };
      const runs = () =>
        vi
          .mocked(console.info)
          .mock.calls.filter(([line]) =>
            String(line).includes('"event":"fonds_scheduled_collection"'),
          ).length;
      const trigger = async () => {
        const state = parseEnv(await readFile(`${stateDir}/fonds.env`, "utf8"));
        return fetch(`${origin}/internal/triggers/recent`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${state.FONDS_SCHEDULE_SECRET}`,
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: "{}",
        });
      };
      // Past the start jitter, so the first tick runs this hour's occurrence.
      const minute = new Date(Date.now() - 10 * 60_000).getUTCMinutes();
      const scheduled = {
        ...env,
        FONDS_COLLECTION_SCHEDULE: "hourly",
        FONDS_COLLECTION_TIME: `00:${String(minute).padStart(2, "0")}`,
      };
      try {
        let running = await startHostedNodeService(env);
        try {
          expect((await trigger()).status).toBe(200);
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(runs()).toBe(0);
        } finally {
          await running.close();
        }
        for (const attempt of [1, 2]) {
          running = await startHostedNodeService(scheduled);
          try {
            await expect.poll(runs, { timeout: 10_000 }).toBe(1);
            // The trigger finds the occurrence claimed and collects nothing.
            const response = await trigger();
            expect(response.status, `attempt ${attempt}`).toBe(200);
            expect(await response.json()).toEqual({ refreshes: [] });
            expect(runs()).toBe(1);
          } finally {
            await running.close();
          }
        }
        const pool = new Pool({ connectionString });
        try {
          const { rows } = await pool.query(
            "SELECT status FROM financial.scheduled_collections",
          );
          expect(rows).toEqual([{ status: "finished" }]);
          // The random time is generated once into the database, and kept.
          const time = await pool.query(
            "SELECT value FROM financial.settings WHERE name = 'collection_time'",
          );
          expect(time.rows[0]?.value).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
          running = await startHostedNodeService(env);
          await running.close();
          expect(
            (
              await pool.query(
                "SELECT value FROM financial.settings WHERE name = 'collection_time'",
              )
            ).rows,
          ).toEqual(time.rows);
        } finally {
          await pool.end();
        }
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    it("serves the hosted surface from a fresh state directory and restarts with it", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const stateDir = await mkdtemp(`${tmpdir()}/fonds-hosted-state-`);
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const env = {
        FONDS_STATE_DIR: stateDir,
        FONDS_DATABASE_URL: connectionString,
        // The disposable test server has no TLS; production hosts use verify-full.
        FONDS_DATABASE_TLS: "disable",
        FONDS_PUBLIC_ORIGIN: origin,
        HOST: "127.0.0.1",
        PORT: String(port),
      };
      try {
        for (const attempt of [1, 2]) {
          const running = await startHostedNodeService(env);
          try {
            expect(running.url).toBe(origin);
            const metadata = await fetch(
              `${origin}/.well-known/oauth-protected-resource/mcp`,
            );
            expect(metadata.status, `attempt ${attempt}`).toBe(200);
            expect(await metadata.json()).toMatchObject({
              resource: `${origin}/mcp`,
            });
          } finally {
            await running.close();
          }
        }
        // The operator's login link signs the owner in on the running service.
        const running = await startHostedNodeService(env);
        try {
          const link = new URL(await loginLink(env));
          expect(link.origin).toBe(origin);
          const signIn = await fetch(link, { redirect: "manual" });
          expect(signIn.status).toBe(302);
          expect(signIn.headers.get("set-cookie")).toMatch(/session_token=/);
          // A link works once.
          expect(
            (await fetch(link, { redirect: "manual" })).headers.get(
              "set-cookie",
            ),
          ).toBeNull();
        } finally {
          await running.close();
        }
        // A replaced state file is a different installation, never a silent re-key.
        await rm(`${stateDir}/fonds.env`);
        await expect(startHostedNodeService(env)).rejects.toThrow(
          /do not match the database's installation/,
        );
        // Host environment secrets are ignored: the state file alone supplies them.
        await expect(
          startHostedNodeService({
            ...env,
            FONDS_CREDENTIALS_KEY: generateCredentialsKey(),
            FONDS_AUTH_SECRET: randomBytes(48).toString("base64url"),
          }),
        ).rejects.toThrow(/do not match/);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    });

    describe("shutdown", () => {
      let stateDir: string;
      let env: NodeJS.ProcessEnv;
      let release: () => void;
      /** Pool lifecycle in order: the paused checkout and each `end`. */
      let lifecycle: string[];

      beforeEach(async () => {
        const { mkdtemp } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        stateDir = await mkdtemp(`${tmpdir()}/fonds-hosted-shutdown-`);
        const port = await freePort();
        env = {
          FONDS_STATE_DIR: stateDir,
          FONDS_DATABASE_URL: connectionString,
          FONDS_DATABASE_TLS: "disable",
          FONDS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
          HOST: "127.0.0.1",
          PORT: String(port),
        };
        release = () => {};
        lifecycle = [];
      });

      afterEach(async () => {
        release();
        const { rm } = await import("node:fs/promises");
        await rm(stateDir, { recursive: true, force: true });
      });

      /**
       * Holds the second pool checkout from now until release(), so a request
       * that finished its first database stage waits before its next one.
       */
      function pauseNextCheckout() {
        const { connect, end } = Pool.prototype;
        let paused!: () => void;
        const reached = new Promise<void>((resolve) => {
          paused = resolve;
        });
        const resumed = new Promise<void>((resolve) => {
          release = resolve;
        });
        let checkouts = 0;
        vi.spyOn(Pool.prototype, "connect").mockImplementation(function (
          this: Pool,
          ...args: unknown[]
        ) {
          checkouts += 1;
          if (checkouts !== 2) {
            return Reflect.apply(connect, this, args);
          }
          lifecycle.push("paused");
          paused();
          return resumed.then(() => Reflect.apply(connect, this, args));
        } as Pool["connect"]);
        vi.spyOn(Pool.prototype, "end").mockImplementation(function (
          this: Pool,
          ...args: unknown[]
        ) {
          lifecycle.push("end");
          return Reflect.apply(end, this, args);
        } as Pool["end"]);
        return reached;
      }

      it("finishes a request paused between database stages before ending the pools", async () => {
        const running = await startHostedNodeService(env);
        let closed = false;
        try {
          const link = new URL(await loginLink(env));
          const reached = pauseNextCheckout();
          // The owner sign-in reads the one-time link, then writes the session.
          const signIn = fetch(link, { redirect: "manual" });
          await reached;
          const closing = running.close().then(() => {
            closed = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(lifecycle).toEqual(["paused"]);
          release();
          // The session write after the pause succeeded on an open pool.
          const response = await signIn;
          expect(response.status).toBe(302);
          expect(response.headers.get("set-cookie")).toMatch(/session_token=/);
          await closing;
          expect(lifecycle).toEqual(["paused", "end", "end"]);
        } finally {
          if (!closed) {
            release();
            await running.close();
          }
        }
      });

      it("closes a request that outlives the drain deadline, then ends the pools", async () => {
        const running = await startHostedNodeService(env);
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const link = new URL(await loginLink(env));
        const reached = pauseNextCheckout();
        const signIn = fetch(link, { redirect: "manual" }).then(
          () => "response",
          () => "disconnected",
        );
        await reached;
        const started = performance.now();
        await running.close();
        expect(performance.now() - started).toBeGreaterThanOrEqual(
          DRAIN_DEADLINE_MS - 50,
        );
        expect(await signIn).toBe("disconnected");
        expect(lifecycle).toEqual(["paused", "end", "end"]);
        // The abandoned handler resumes against an ended pool and fails quietly.
        release();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(errors.mock.calls.flat().join(" ")).not.toContain(
          connectionString,
        );
      });
    });
  },
);
