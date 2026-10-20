/** One scheduled run: a stable key and the instant it is due. */
export interface ScheduledOccurrence {
  key: string;
  at: number;
}

/** Scheduled occurrences no process ran, from the first to the last. */
export interface MissedOccurrences {
  first: ScheduledOccurrence;
  last: ScheduledOccurrence;
  count: number;
}

/**
 * Which scheduled occurrences have run, keyed by occurrence and shared by
 * every process on the database, and the settings a schedule is generated
 * from. Outcomes are the occurrence's refreshes.
 */
export interface ScheduledCollectionStore {
  /**
   * Claims an occurrence when no later one has been claimed, or retakes it
   * when its holder's lease lapsed or was released. Returns the claim's
   * token, or undefined when the occurrence is already handled. The check
   * for a later claim precedes the claim itself, so it protects against clock
   * changes, not against replicas with skewed clocks racing each other.
   */
  claimOccurrence(
    occurrence: ScheduledOccurrence,
    now: number,
  ): Promise<string | undefined>;
  /** When the latest claimed occurrence was due, or undefined before any. */
  latestClaimedOccurrence(): Promise<number | undefined>;
  /** Marks an occurrence as run, if `claim` still holds it. */
  finishOccurrence(
    occurrence: ScheduledOccurrence,
    claim: string,
  ): Promise<void>;
  /** Lets another process retake an interrupted claim at once, if it still holds. */
  releaseOccurrence(
    occurrence: ScheduledOccurrence,
    claim: string,
  ): Promise<void>;
  /** A stored setting, created once from `generate` when absent. */
  ensureSetting(name: string, generate: () => string): Promise<string>;
  /** A stored setting, or undefined; never writes. */
  getSetting(name: string): Promise<string | undefined>;
}

/** A run's ten-minute deadline and its Events delivery fit inside one lease. */
export const OCCURRENCE_LEASE_MS = 15 * 60_000;
/** Older records would only answer history questions that no operation asks. */
export const OCCURRENCE_RETENTION_MS = 90 * 24 * 60 * 60_000;
