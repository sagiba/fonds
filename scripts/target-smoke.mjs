import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const token = "synthetic-isolated-smoke-token-000000000000";

/** A launcher's authenticated HTTP API and MCP endpoint, and its unauthenticated refusal. */
export async function verifyHttp(url, backend, bearer = token) {
  assert.equal((await fetch(`${url}/health`)).status, 401);
  const headers = { Authorization: `Bearer ${bearer}` };
  const health = await (await fetch(`${url}/health`, { headers })).json();
  assert.equal(health.storage, backend);
  const connections = await fetch(`${url}/v1/connections`, { headers });
  assert.equal(connections.status, 200);
  // The public list envelope: `{ data, nextCursor }`.
  assert.ok(Array.isArray((await connections.json()).data));
  const mcpResponse = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "isolated-synthetic-check", version: "1" },
      },
    }),
  });
  assert.equal(mcpResponse.status, 200);
  assert.match(await mcpResponse.text(), /serverInfo/);
}

async function launchProcess(entry, environment, backend) {
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_PATH: "",
      FONDS_API_TOKEN: token,
      FONDS_DATABASE_AUTH_TOKEN: "",
      PORT: "0",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Artifact launcher did not become ready")),
      20_000,
    );
    const collect = (data) => {
      output += data;
      const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    exited.then(({ code }) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Artifact launcher exited before readiness (${code}): ${output}`,
        ),
      );
    }, reject);
  });
  try {
    await verifyHttp(await ready, backend);
    assert.ok(!output.includes(token), "Launcher must not log its credential");
    child.kill("SIGTERM");
    let timeout;
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Artifact launcher did not shut down")),
          10_000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.deepEqual(result, { code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
  }
}

async function localTlsProxy(runtime, upstream) {
  const keyPath = join(runtime, "synthetic-proxy.key");
  const certPath = join(runtime, "synthetic-proxy.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" },
  );
  const tlsProxy = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) {
          chunks.push(chunk);
        }
        const headers = { ...request.headers };
        delete headers.host;
        delete headers.connection;
        delete headers["transfer-encoding"];
        const result = await fetch(new URL(request.url, upstream), {
          method: request.method,
          headers,
          ...(!["GET", "HEAD"].includes(request.method) && {
            body: Buffer.concat(chunks),
          }),
        });
        const responseHeaders = Object.fromEntries(result.headers);
        for (const key of [
          "connection",
          "transfer-encoding",
          "content-length",
          "content-encoding",
        ]) {
          delete responseHeaders[key];
        }
        response.writeHead(result.status, responseHeaders);
        response.end(Buffer.from(await result.arrayBuffer()));
      } catch {
        response.writeHead(502);
        response.end("Synthetic proxy failure");
      }
    },
  );
  await new Promise((resolve, reject) => {
    tlsProxy.once("error", reject);
    tlsProxy.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `https://localhost:${tlsProxy.address().port}`,
    certPath,
    close: async () => {
      const closed = new Promise((resolve, reject) =>
        tlsProxy.close((error) => (error ? reject(error) : resolve())),
      );
      tlsProxy.closeAllConnections();
      await closed;
    },
  };
}

/**
 * A Node launcher against a disposable libSQL server behind a local TLS proxy,
 * started directly and through a linked directory. SQLite and PostgreSQL ship
 * in the npm package instead, which npm run check:npm installs and runs.
 */
export async function smokeTarget(target, runtime) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const tlsProxy = await localTlsProxy(
    runtime,
    process.env.FONDS_TEST_LIBSQL_HTTP_URL,
  );
  try {
    const environment = {
      FONDS_DATABASE_URL: tlsProxy.url,
      FONDS_DATABASE_AUTH_TOKEN: "",
      NODE_EXTRA_CA_CERTS: tlsProxy.certPath,
    };
    await launchProcess(join(process.cwd(), "server.js"), environment, target);
    const linkedDirectory = join(runtime, "linked-artifact");
    await symlink(process.cwd(), linkedDirectory, "dir");
    await launchProcess(
      join(linkedDirectory, "server.js"),
      environment,
      target,
    );
    return {
      http: true,
      mcp: true,
      childProcess: true,
      symlink: true,
      gracefulShutdown: true,
    };
  } finally {
    await tlsProxy.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(
    JSON.stringify(
      await smokeTarget(
        process.env.FONDS_SMOKE_TARGET,
        process.env.FONDS_SMOKE_RUNTIME,
      ),
    ),
  );
}
