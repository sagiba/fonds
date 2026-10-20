import { z } from "zod";

import { ConflictError } from "../domain/errors.js";
import type { ConnectionConfig, LedgerEvent } from "../domain/records.js";
import type { InternalStore } from "./financial-store.js";

export class DeliveryConflictError extends ConflictError {
  override name = "DeliveryConflictError";
}

export const consumerSchema = z.object({
  connectionId: z.string().min(1),
  consumerId: z.string().min(1),
});

export const deliverySchema = consumerSchema
  .extend({
    limit: z.number().int().min(1).max(1000).default(100),
  })
  .strict();

const cursorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Keep every own key, including "__proto__", which Zod's record parser drops.
const cursorsSchema = z.custom<Record<string, number>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (cursor) => cursorSchema.safeParse(cursor).success,
    ),
);

export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    changeCursors: cursorsSchema.optional(),
  })
  .loose();

export function cursorFor(
  config: z.output<typeof configSchema>,
  consumerId: string,
) {
  return config.changeCursors && Object.hasOwn(config.changeCursors, consumerId)
    ? config.changeCursors[consumerId]!
    : 0;
}

/** Called only with configuration loaded under the adapter's write lock/transaction. */
export function acknowledgeConfig(
  input: ConnectionConfig,
  consumerId: string,
  expected: number,
  next: number,
): ConnectionConfig {
  consumerSchema.shape.consumerId.parse(consumerId);
  cursorSchema.parse(expected);
  cursorSchema.min(expected).parse(next);
  const config = configSchema.parse(input);
  if (cursorFor(config, consumerId) !== expected) {
    throw new DeliveryConflictError("Consumer cursor changed during delivery");
  }
  return {
    ...config,
    changeCursors: { ...config.changeCursors, [consumerId]: next },
  };
}

export type ChangeDeliveryStore = Pick<
  InternalStore,
  "identity" | "getDeliveryCursor" | "listEvents" | "acknowledgeCursor"
>;

const activeConsumers = new WeakMap<object, Set<string>>();

/** At-least-once delivery; callbacks run outside the write transaction. */
export async function deliverFromStore(
  store: ChangeDeliveryStore,
  input: z.input<typeof deliverySchema>,
  deliver: (message: {
    deliveryKey: string;
    event: LedgerEvent;
  }) => Promise<void>,
): Promise<{ delivered: number; cursor: number }> {
  const { connectionId, consumerId, limit } = deliverySchema.parse(input);

  const consumerKey = JSON.stringify([connectionId, consumerId]);
  const activeForStore =
    activeConsumers.get(store.identity) ?? new Set<string>();
  if (activeForStore.has(consumerKey)) {
    throw new DeliveryConflictError("Consumer delivery already in progress");
  }
  activeConsumers.set(store.identity, activeForStore);
  activeForStore.add(consumerKey);
  try {
    let cursor = await store.getDeliveryCursor(connectionId, consumerId);
    let delivered = 0;
    for (const event of await store.listEvents({
      connectionId,
      after: cursor,
      limit,
    })) {
      await deliver({
        deliveryKey: JSON.stringify([connectionId, event.id]),
        event,
      });
      await store.acknowledgeCursor(connectionId, consumerId, cursor, event.id);
      cursor = event.id;
      delivered++;
    }
    return { delivered, cursor };
  } finally {
    activeForStore.delete(consumerKey);
  }
}
