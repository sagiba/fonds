import { randomUUID } from "node:crypto";

import { createClient } from "@libsql/client/web";
import { describe, expect, it } from "vitest";

import { ConflictError } from "../../src/domain/errors.js";
import {
  databaseForClient,
  initializeTursoDatabase,
} from "../../src/storage/turso.js";
import { row, synthetic } from "../helpers/storage-harness.js";

const url = process.env.FONDS_TEST_LIBSQL_HTTP_URL;

describe.skipIf(!url)("uncertain user writes over libSQL HTTP", () => {
  it("reports a lost annotation acknowledgement and requires reading before another edit", async () => {
    let armed = false;
    let dropped = false;
    const client = createClient({
      url: url!,
      intMode: "number",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = await request.clone().text();
        const response = await fetch(request);
        if (armed && !dropped && body.includes("COMMIT")) {
          dropped = true;
          throw new TypeError("Synthetic lost annotation acknowledgement");
        }
        return response;
      },
    });
    const db = databaseForClient(client);
    const connectionId = `uncertain-annotation-${randomUUID()}`;
    try {
      await initializeTursoDatabase(client);
      await db.ensureConnection({ id: connectionId, provider: "cal" });
      await db.ingestRun(
        {
          runId: connectionId,
          connectionId,
          responses: [
            {
              accountKey: "account",
              endpoint: "synthetic",
              capturedAt: "2040-08-01T00:00:00Z",
              responseText: JSON.stringify([row("one")]),
            },
          ],
        },
        synthetic,
      );
      const transaction = (await db.listTransactionPage({ connectionId }))
        .transactions[0]!;
      armed = true;
      await expect(
        db.editAnnotation({
          transactionId: transaction.id,
          expectedVersion: 0,
          notes: "Committed synthetic note",
        }),
      ).rejects.toThrow();
      expect(dropped).toBe(true);
      const readClient = createClient({ url: url!, intMode: "number" });
      const reader = databaseForClient(readClient);
      try {
        expect(
          (await reader.getTransaction(transaction.id))?.annotation,
        ).toMatchObject({
          version: 1,
          data: { notes: "Committed synthetic note" },
        });
        await expect(
          reader.editAnnotation({
            transactionId: transaction.id,
            expectedVersion: 0,
            notes: "Unsafe repeat",
          }),
        ).rejects.toThrow(ConflictError);
        const annotated = (await reader.listEvents({ connectionId })).filter(
          (change) => change.type === "annotation.updated",
        );
        expect(annotated).toHaveLength(1);
      } finally {
        reader.close();
      }
    } finally {
      await db.close();
    }
  });
});
