/** The vocabularies of a refresh and its month windows, as stored and published. */
export const REFRESH_TRIGGERS = ["manual", "scheduled"] as const;
export const REFRESH_STATUSES = [
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "skipped",
] as const;
export const SKIP_REASONS = [
  "busy",
  "cooldown",
  "requires_attention",
  "missed",
] as const;
/** Why a refresh failed without a provider outcome: still unfinished a day after its start. */
export const FAILURE_REASONS = ["expired"] as const;
/** Provider outcomes that end an entire refresh, independently of owner attention. */
export const PROVIDER_STOP_REASONS = [
  "authentication_failed",
  "authentication_challenge",
  "rate_limited",
  "budget_exhausted",
] as const;

export type ProviderStopReason = (typeof PROVIDER_STOP_REASONS)[number];

export const WINDOW_STATUSES = [
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
] as const;

export type RefreshTrigger = (typeof REFRESH_TRIGGERS)[number];

export type RefreshStatus = (typeof REFRESH_STATUSES)[number];

export type SkipReason = (typeof SKIP_REASONS)[number];

export type WindowStatus = (typeof WINDOW_STATUSES)[number];

export type FailureReason = (typeof FAILURE_REASONS)[number];
