import { expect, it, vi } from "vitest";

import type { LockedCollectionStore } from "../../src/application/collection-lock.js";
import {
  type LeaseDatabase,
  withCollectionLease,
} from "../../src/storage/collection-lease.js";

function lease(renew: LeaseDatabase["renew"]) {
  return {
    acquire: vi.fn(async (_holder: string, _leaseMs: number) => true),
    renew: vi.fn(renew),
    release: vi.fn(async () => {}),
    lockedStore: () => ({}) as LockedCollectionStore,
  };
}

function waitForAbort(signal: AbortSignal) {
  return new Promise<number>((resolve) => {
    const started = performance.now();
    signal.addEventListener(
      "abort",
      () => resolve(performance.now() - started),
      { once: true },
    );
  });
}

it("aborts work before its lease lapses while a renewal stalls, and does not wait on it", async () => {
  // A renewal stuck in a busy or unreachable database never settles.
  const store = lease(() => new Promise<boolean>(() => {}));
  const started = performance.now();
  const result = await withCollectionLease(
    store,
    async (_store, signal) => {
      const abortedAfter = await waitForAbort(signal);
      // Three renewal intervals: before the 200 ms lease could lapse.
      expect(abortedAfter).toBeLessThan(200);
      return "stopped";
    },
    { leaseMs: 200 },
  );
  expect(result).toEqual({ acquired: true, result: "stopped" });
  // The stalled renewal bounds cleanup by one lease, not forever.
  expect(performance.now() - started).toBeLessThan(800);
  expect(store.renew).toHaveBeenCalledTimes(1);
});

it("keeps renewing while confirmed and aborts as soon as a renewal finds the lease lost", async () => {
  let renewals = 0;
  const store = lease(async () => ++renewals < 4);
  const result = await withCollectionLease(
    store,
    async (_store, signal) => {
      await waitForAbort(signal);
      return renewals;
    },
    { leaseMs: 400 },
  );
  expect(result).toEqual({ acquired: true, result: 4 });
  expect(store.release).toHaveBeenCalledWith(store.acquire.mock.calls[0]?.[0]);
});

it("keeps working through a transient renewal failure", async () => {
  let renewals = 0;
  const store = lease(async () => {
    renewals++;
    if (renewals === 1) {
      throw new Error("synthetic busy database");
    }
    return true;
  });
  const result = await withCollectionLease(
    store,
    async (_store, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return signal.aborted;
    },
    { leaseMs: 400 },
  );
  expect(result).toEqual({ acquired: true, result: false });
  expect(renewals).toBeGreaterThan(2);
});
