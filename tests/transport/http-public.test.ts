import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application } from "../../src/application/operations.js";
import {
  createHttpService,
  type HttpServiceOptions,
} from "../../src/transport/http.js";

const publicOrigin = "https://financial.synthetic.invalid";
const token = "synthetic-local-token-000000000000000000000";
const application: Application = { backend: "postgres", operations: [] };
const services: ReturnType<typeof createHttpService>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function setup() {
  const authenticate = vi.fn(async () => null);
  const publicRoutes = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname !== "/auth/login") {
      return null;
    }
    return new Response(await request.text(), {
      headers: {
        "Content-Type": "text/plain",
        "Set-Cookie": "synthetic=session; Secure; HttpOnly; SameSite=Lax",
      },
    });
  });
  const service = createHttpService(application, {
    publicOrigin,
    ownerId: "synthetic-owner",
    authProvider: { issuer: `${publicOrigin}/auth`, authenticate },
    publicRoutes,
  });
  services.push(service);
  return { service, authenticate, publicRoutes };
}

describe("hosted public authentication routes", () => {
  it("serves login before bearer authentication and preserves headers", async () => {
    const { service, authenticate, publicRoutes } = setup();
    const response = await service.app.request(`${publicOrigin}/auth/login`, {
      method: "POST",
      body: "synthetic-login-body",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("synthetic-login-body");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(authenticate).not.toHaveBeenCalled();
    expect(publicRoutes).toHaveBeenCalledOnce();
    expect((await service.app.request(`${publicOrigin}/health`)).status).toBe(
      401,
    );
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("rejects untrusted origins and hosts before invoking public routes", async () => {
    const { service, publicRoutes, authenticate } = setup();
    for (const [url, headers] of [
      [`${publicOrigin}/auth/login`, { Origin: "https://attacker.invalid" }],
      [`${publicOrigin}/auth/login`, { Host: "attacker.invalid" }],
      ["https://attacker.invalid/auth/login", {}],
    ] as const) {
      expect((await service.app.request(url, { headers })).status).toBe(403);
    }
    expect(publicRoutes).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("bounds public endpoint bodies before dispatch regardless of declared length", async () => {
    const { service, publicRoutes, authenticate } = setup();
    for (const headers of [
      {},
      { "content-length": "1" },
      { "content-length": "65537" },
    ]) {
      const response = await service.app.request(`${publicOrigin}/auth/login`, {
        method: "POST",
        headers,
        body: "x".repeat(65537),
      });
      expect(response.status).toBe(413);
    }
    expect(publicRoutes).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects legacy OAuth and public bearer-token configurations", async () => {
    for (const extra of [
      { publicOrigin },
      { publicRoutes: async () => null },
    ]) {
      expect(() =>
        createHttpService(application, {
          token,
          ...extra,
        } as unknown as HttpServiceOptions),
      ).toThrow();
    }
    const local = createHttpService(application, { token });
    services.push(local);
    expect(
      (
        await local.app.request(`${publicOrigin}/health`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await local.app.request(
          "http://127.0.0.1/.well-known/oauth-authorization-server",
          {
            headers: { authorization: `Bearer ${token}` },
          },
        )
      ).status,
    ).toBe(404);
  });
});
