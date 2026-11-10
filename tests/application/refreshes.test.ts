import { describe, expect, it } from "vitest";

import {
  admissionHold,
  finalAttention,
  type ProviderStopReason,
} from "../../src/application/refreshes.js";

const finished = "2040-06-01T08:00:00.000Z";
const minute = 60_000;
const hour = 60 * minute;
const finishedAt = Date.parse(finished);

const executed = (
  overrides: {
    trigger?: "manual" | "scheduled";
    requiresAttention?: boolean;
    providerStopReason?: ProviderStopReason | null;
  } = {},
) => ({
  trigger: "scheduled" as const,
  finishedAt: finished,
  requiresAttention: false,
  providerStopReason: null,
  ...overrides,
});

const stopped = (providerStopReason: ProviderStopReason | null) => ({
  providerStopReason,
});

describe("refresh admission", () => {
  it.each([
    ["authentication_failed", 6 * hour - 1, "cooldown"],
    ["authentication_failed", 6 * hour, null],
    ["authentication_challenge", 6 * hour - 1, "cooldown"],
    ["authentication_challenge", 6 * hour, null],
    ["rate_limited", 6 * hour - 1, "cooldown"],
    ["budget_exhausted", minute - 1, "cooldown"],
    ["budget_exhausted", minute, null],
  ] as const)(
    "holds a scheduled start after a %s stop for %i ms: %s",
    (code, elapsed, reason) => {
      expect(
        admissionHold(
          executed({ providerStopReason: code }),
          { trigger: "scheduled" },
          finishedAt + elapsed,
        ),
      ).toBe(reason);
    },
  );

  it("lets a manual start past a refused login after the ordinary minute", () => {
    const last = executed({ providerStopReason: "authentication_failed" });
    expect(
      admissionHold(last, { trigger: "manual" }, finishedAt + 59_999),
    ).toBe("cooldown");
    expect(
      admissionHold(last, { trigger: "manual" }, finishedAt + minute),
    ).toBeNull();
  });

  it.each([
    ["scheduled", "scheduled", 24 * hour - 1, "requires_attention"],
    ["scheduled", "scheduled", 24 * hour, null],
    ["manual", "scheduled", 24 * hour - 1, "requires_attention"],
    ["manual", "scheduled", 24 * hour, null],
    ["scheduled", "manual", 0, null],
    ["manual", "manual", hour - 1, "requires_attention"],
    ["manual", "manual", hour, null],
  ] as const)(
    "while attention is required after a %s refresh, holds a %s start %i ms later: %s",
    (lastTrigger, trigger, elapsed, reason) => {
      expect(
        admissionHold(
          executed({ trigger: lastTrigger, requiresAttention: true }),
          { trigger },
          finishedAt + elapsed,
        ),
      ).toBe(reason);
    },
  );
});

describe("final attention", () => {
  const refused = {
    status: "failed" as const,
    requiresAttention: false,
    providerStopReason: "authentication_failed" as const,
    failureCodes: ["authentication_failed" as const],
  };
  const policy = (loginFailuresBeforeAttention: number) => ({
    loginFailuresBeforeAttention,
  });

  it("needs attention at the first expired password", () => {
    const expired = {
      ...refused,
      failureCodes: ["credentials_expired" as const],
    };
    expect(finalAttention(expired, undefined, [], policy(5))).toBe(true);
    expect(finalAttention(refused, undefined, [], policy(5))).toBe(false);
  });

  it("needs attention when refused logins in a row reach the threshold", () => {
    const login = stopped("authentication_challenge");
    // The previous executed refresh is the newest of `earlier` here.
    const previous = executed({
      providerStopReason: "authentication_challenge",
    });
    expect(finalAttention(refused, undefined, [], policy(1))).toBe(true);
    expect(finalAttention(refused, undefined, [], policy(2))).toBe(false);
    expect(finalAttention(refused, previous, [login], policy(2))).toBe(true);
    expect(
      finalAttention(refused, previous, [login, login, login], policy(5)),
    ).toBe(false);
    expect(
      finalAttention(
        refused,
        previous,
        [login, login, login, login],
        policy(5),
      ),
    ).toBe(true);
  });

  it("ends a run of refused logins at any other executed refresh", () => {
    const login = stopped("authentication_failed");
    const previous = executed({ providerStopReason: "authentication_failed" });
    for (const other of [null, "budget_exhausted"] as const) {
      expect(
        finalAttention(
          refused,
          previous,
          [login, stopped(other), login, login],
          policy(5),
        ),
      ).toBe(false);
      expect(
        finalAttention(refused, previous, [login, stopped(other)], policy(3)),
      ).toBe(false);
    }
  });

  it("keeps the rate-limit rule apart from refused logins", () => {
    const limited = { ...refused, providerStopReason: "rate_limited" as const };
    expect(
      finalAttention(
        limited,
        executed({ providerStopReason: "rate_limited" }),
        [],
        policy(5),
      ),
    ).toBe(true);
    expect(
      finalAttention(
        limited,
        executed({ providerStopReason: "authentication_failed" }),
        [stopped("authentication_failed")],
        policy(1),
      ),
    ).toBe(false);
  });

  it("keeps a block through anything short of completion, whatever the threshold", () => {
    const blocked = executed({ requiresAttention: true });
    for (const providerStopReason of [
      null,
      "rate_limited",
      "authentication_failed",
    ] as const) {
      expect(
        finalAttention(
          {
            status: "failed",
            requiresAttention: false,
            providerStopReason,
            failureCodes: [],
          },
          blocked,
          [],
          policy(5),
        ),
      ).toBe(true);
    }
    expect(
      finalAttention(
        {
          status: "completed",
          requiresAttention: false,
          providerStopReason: null,
          failureCodes: [],
        },
        blocked,
        [],
        policy(1),
      ),
    ).toBe(false);
    // A refresh that recorded its own need, as manual recovery does, keeps it.
    expect(
      finalAttention(
        {
          status: "failed",
          requiresAttention: true,
          providerStopReason: null,
          failureCodes: [],
        },
        undefined,
        [],
        policy(5),
      ),
    ).toBe(true);
  });
});
