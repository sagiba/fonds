// Post-deploy smoke checks against the public origin. Only unauthenticated
// boundary behavior is checked by default; `--refresh` additionally runs one
// bounded operator refresh using the private env file's refresh secret.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

async function check(name, request, expectation) {
  let response;
  try {
    response = await fetch(request, { redirect: "manual" });
  } catch {
    return { name, ok: false, detail: "unreachable" };
  }
  const body = response.headers.get("content-type")?.includes("json")
    ? await response.json().catch(() => null)
    : null;
  const ok = await expectation(response, body);
  return { name, ok, detail: String(response.status) };
}

export function smokeChecks(origin) {
  const json = (body) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return [
    [
      "health requires a bearer and advertises resource metadata",
      new Request(`${origin}/health`),
      (response) =>
        response.status === 401 &&
        (response.headers.get("www-authenticate") ?? "").includes(
          `${origin}/.well-known/oauth-protected-resource/mcp`,
        ),
    ],
    [
      "protected resource metadata names the exact MCP resource",
      new Request(`${origin}/.well-known/oauth-protected-resource/mcp`),
      (response, body) =>
        response.status === 200 &&
        body?.resource === `${origin}/mcp` &&
        body?.authorization_servers?.[0] === `${origin}/api/auth`,
    ],
    [
      "authorization server metadata has no dynamic registration",
      new Request(`${origin}/api/auth/.well-known/oauth-authorization-server`),
      (response, body) =>
        response.status === 200 &&
        body?.issuer === `${origin}/api/auth` &&
        body?.registration_endpoint === undefined,
    ],
    [
      "MCP rejects unauthenticated calls",
      new Request(
        `${origin}/mcp`,
        json({ jsonrpc: "2.0", id: 1, method: "ping" }),
      ),
      (response) => response.status === 401,
    ],
    [
      "public email signup is unavailable",
      new Request(
        `${origin}/api/auth/sign-up/email`,
        json({
          email: "x@example.invalid",
          password: "x".repeat(16),
          name: "x",
        }),
      ),
      (response) => response.status === 404,
    ],
    [
      "public email sign-in is unavailable",
      new Request(
        `${origin}/api/auth/sign-in/email`,
        json({ email: "owner@fonds.invalid", password: "x".repeat(16) }),
      ),
      (response) => response.status === 404,
    ],
    [
      "unknown OAuth clients are rejected before the issuer",
      new Request(`${origin}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials&client_id=unknown-smoke-client",
      }),
      (response, body) =>
        response.status === 400 && body?.error === "invalid_client",
    ],
    [
      // A complete, valid scheduled-refresh envelope: only Neon's ingress
      // stripping of the attestation header can reject it. If stripping
      // regressed, this runs one recent refresh and the check fails with
      // status 200.
      "public callers cannot forge a native trigger",
      new Request(`${origin}/internal/triggers/recent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Neon-Trigger-Invocation-Id": "forged-smoke",
        },
        body: JSON.stringify({
          version: 1,
          invocation_id: "forged-smoke",
          trigger: {
            type: "schedule",
            id: "forged",
            name: "scheduled-refresh",
          },
          data: { scheduled_at: new Date().toISOString() },
        }),
      }),
      (response) => response.status === 403,
    ],
  ];
}

export async function runSmoke(args) {
  const { values } = parseArgs({
    args,
    options: {
      "env-file": { type: "string" },
      refresh: { type: "boolean", default: false },
    },
  });
  const environment = parseEnv(
    await readFile(resolve(values["env-file"] ?? ""), "utf8"),
  );
  const origin = new URL(environment.FONDS_PUBLIC_ORIGIN ?? "").origin;
  const results = [];
  for (const [name, request, expectation] of smokeChecks(origin)) {
    results.push(await check(name, request, expectation));
  }
  if (values.refresh) {
    results.push(
      await check(
        "operator refresh completes",
        new Request(`${origin}/internal/refresh/recent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${environment.FONDS_REFRESH_SECRET}`,
          },
          body: "{}",
        }),
        // Every target's refresh started and completed within the wait.
        (response, body) =>
          response.status === 200 &&
          Array.isArray(body?.refreshes) &&
          body.refreshes.every(
            (entry) =>
              entry.reason === null && entry.refresh?.status === "completed",
          ),
      ),
    );
  }
  return results;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const results = await runSmoke(process.argv.slice(2));
    for (const { name, ok, detail } of results) {
      console.log(`${ok ? "ok  " : "FAIL"} ${name} (${detail})`);
    }
    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  } catch {
    console.error(
      "Smoke run failed; pass --env-file with FONDS_PUBLIC_ORIGIN.",
    );
    process.exitCode = 1;
  }
}
