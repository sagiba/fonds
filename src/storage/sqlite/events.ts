import {
  type EventSubscription,
  eventSubscriptionSchema,
  type EventSubscriptionStore,
} from "../../application/events.js";
import type { InternalStore } from "../../application/financial-store.js";

/** Runs one statement and returns its rows; values bind positionally. */
export type SqlQuery = (
  sql: string,
  args: (string | number | null)[],
) => Promise<Record<string, unknown>[]>;

function decode(row: Record<string, unknown>): EventSubscription {
  return eventSubscriptionSchema.parse(JSON.parse(String(row.state_json)));
}

/**
 * Subscription state beside the ledger, as PostgreSQL keeps it in its
 * operations schema. Optimistic generations prevent stale delivery and
 * refresh writes across processes; event-feed cursors come from the ledger.
 */
export function createSqliteEventStore(
  query: SqlQuery,
  ledger: Pick<InternalStore, "latestEventId">,
): EventSubscriptionStore {
  return {
    async get(id) {
      const rows = await query(
        "SELECT state_json FROM event_subscriptions WHERE id=?",
        [id],
      );
      return rows[0] ? decode(rows[0]) : undefined;
    },
    async save(value, expectedGeneration) {
      const next = eventSubscriptionSchema.parse({
        ...value,
        generation: expectedGeneration + 1,
      });
      // The SELECT's WHERE clause is required: it also tells SQLite that
      // ON CONFLICT belongs to the INSERT.
      const rows = await query(
        `INSERT INTO event_subscriptions
          (id,generation,status,expires_at,next_attempt_at,state_json)
         SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS
          (SELECT 1 FROM event_subscriptions WHERE id=?)
         ON CONFLICT (id) DO UPDATE SET
          generation=excluded.generation,status=excluded.status,
          expires_at=excluded.expires_at,next_attempt_at=excluded.next_attempt_at,
          state_json=excluded.state_json
         WHERE event_subscriptions.generation=?
         RETURNING state_json`,
        [
          next.id,
          next.generation,
          next.status,
          next.expiresAt,
          next.nextAttemptAt,
          JSON.stringify(next),
          expectedGeneration,
          next.id,
          expectedGeneration,
        ],
      );
      return rows[0] ? decode(rows[0]) : undefined;
    },
    async listDue(now, limit) {
      const rows = await query(
        `SELECT state_json FROM event_subscriptions
         WHERE status='active' AND expires_at>? AND next_attempt_at<=?
         ORDER BY next_attempt_at,id LIMIT ?`,
        [now, now, limit],
      );
      return rows.map(decode);
    },
    latestEventId: (connectionId) => ledger.latestEventId(connectionId),
  };
}
