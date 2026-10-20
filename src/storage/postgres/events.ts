import type { Pool } from "pg";

import {
  type EventSubscription,
  eventSubscriptionSchema,
  type EventSubscriptionStore,
} from "../../application/events.js";
import type { InternalStore } from "../../application/financial-store.js";

/**
 * Optimistic generations prevent stale delivery/refresh writes across invocations.
 * Event-feed cursors come from the financial store's own statements.
 */
export function createPostgresEventStore(
  pool: Pool,
  ledger: Pick<InternalStore, "latestEventId">,
): EventSubscriptionStore {
  function decode(row: { state_json: unknown }): EventSubscription {
    return eventSubscriptionSchema.parse(row.state_json);
  }

  return {
    async get(id) {
      const result = await pool.query<{ state_json: unknown }>(
        "SELECT state_json FROM operations.event_subscriptions WHERE id=$1",
        [id],
      );
      return result.rows[0] ? decode(result.rows[0]) : undefined;
    },
    async save(value, expectedGeneration) {
      const next = eventSubscriptionSchema.parse({
        ...value,
        generation: expectedGeneration + 1,
      });
      const result = await pool.query<{ state_json: unknown }>(
        `INSERT INTO operations.event_subscriptions
          (id,generation,status,expires_at,next_attempt_at,state_json)
         SELECT $1,$2,$3,$4,$5,$6 WHERE $7=0 OR EXISTS
          (SELECT 1 FROM operations.event_subscriptions WHERE id=$1)
         ON CONFLICT (id) DO UPDATE SET
          generation=EXCLUDED.generation,status=EXCLUDED.status,
          expires_at=EXCLUDED.expires_at,next_attempt_at=EXCLUDED.next_attempt_at,
          state_json=EXCLUDED.state_json
         WHERE event_subscriptions.generation=$7
         RETURNING state_json`,
        [
          next.id,
          next.generation,
          next.status,
          new Date(next.expiresAt),
          new Date(next.nextAttemptAt),
          JSON.stringify(next),
          expectedGeneration,
        ],
      );
      return result.rows[0] ? decode(result.rows[0]) : undefined;
    },
    async listDue(now, limit) {
      const result = await pool.query<{ state_json: unknown }>(
        `SELECT state_json FROM operations.event_subscriptions
         WHERE status='active' AND expires_at>$1 AND next_attempt_at<=$1
         ORDER BY next_attempt_at,id LIMIT $2`,
        [new Date(now), limit],
      );
      return result.rows.map(decode);
    },
    latestEventId: (connectionId) => ledger.latestEventId(connectionId),
  };
}
