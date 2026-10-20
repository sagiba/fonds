import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildTarget } from "../../scripts/build-targets.mjs";
import { calAdapter } from "../../src/providers/cal/adapter.js";
import {
  d1Enabled,
  fixture,
  loadMiniflare,
  migrateD1,
  open,
} from "../helpers/storage-harness.js";

// No nodejs_compat flag: the bundle must run on the plain Workers runtime.
const worker = `
import { openD1Database } from "./application.js";
import { calAdapter } from "./cal-adapter.js";
export default {
  async fetch(request, env) {
    const store = openD1Database(env.DB);
    await store.ensureConnection({ id: "cal", provider: "cal" });
    const run = await store.ingestRun(
      {
        connectionId: "cal",
        runId: "worker-run",
        responses: [
          {
            accountKey: "account",
            endpoint: "synthetic:cal/recent",
            capturedAt: "2040-08-01T00:00:00Z",
            responseText: await request.text(),
          },
        ],
      },
      calAdapter,
    );
    const page = await store.listTransactionPage({ connectionId: "cal", limit: 200 });
    return Response.json({
      created: run.created,
      sourceKeys: page.transactions.map((row) => row.sourceKey).sort(),
      totals: await store.getTotals({ connectionId: "cal" }),
    });
  },
};
`;

// Enable with FONDS_TEST_D1=1; Miniflare loads only then.
describe.skipIf(!d1Enabled)("d1-web target", () => {
  let directory;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "fonds-d1-worker-"));
    await buildTarget("d1-web", { output: directory });
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("applies a CAL capture with the bundled D1 target inside workerd", async () => {
    const Miniflare = await loadMiniflare();
    const adapterBundle = await build({
      entryPoints: [
        new URL("../../src/providers/cal/adapter.ts", import.meta.url).pathname,
      ],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
    });
    const miniflare = new Miniflare({
      compatibilityDate: "2026-07-01",
      modules: [
        { type: "ESModule", path: "worker.js", contents: worker },
        {
          type: "ESModule",
          path: "cal-adapter.js",
          contents: adapterBundle.outputFiles[0].text,
        },
        {
          type: "ESModule",
          path: "application.js",
          contents: await readFile(join(directory, "application.js"), "utf8"),
        },
      ],
      d1Databases: ["DB"],
    });
    const reference = await open("sqlite");
    try {
      await migrateD1(await miniflare.getD1Database("DB"));
      const response = await miniflare.dispatchFetch("http://worker/", {
        method: "POST",
        body: fixture("recent-01"),
      });
      expect(response.status).toBe(200);
      const actual = await response.json();
      await reference.ensureConnection({ id: "cal", provider: "cal" });
      const run = await reference.ingestRun(
        {
          connectionId: "cal",
          runId: "worker-run",
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic:cal/recent",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: fixture("recent-01"),
            },
          ],
        },
        calAdapter,
      );
      const page = await reference.listTransactionPage({
        connectionId: "cal",
        limit: 200,
      });
      expect(actual.created).toBeGreaterThan(0);
      expect(actual).toEqual({
        created: run.created,
        sourceKeys: page.transactions.map((row) => row.sourceKey).sort(),
        totals: JSON.parse(
          JSON.stringify(await reference.getTotals({ connectionId: "cal" })),
        ),
      });
    } finally {
      await reference.close();
      await miniflare.dispose();
    }
  });
});
