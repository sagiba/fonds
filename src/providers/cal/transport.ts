import { parse } from "lossless-json";

/** Fixed CAL web endpoints. */
export const CAL_ENDPOINTS = {
  login:
    "https://connect.cal-online.co.il/col-rest/calconnect/authentication/login",
  init: "https://api.cal-online.co.il/Authentication/api/account/init",
  recent:
    "https://api.cal-online.co.il/Transactions/api/LastTransactionsForBankAccount/LastTransactionsForBankAccount",
  monthly:
    "https://api.cal-online.co.il/Transactions/api/transactionsDetails/getCardTransactionsDetails",
  search:
    "https://api.cal-online.co.il/Transactions/api/filteredTransactions/getFilteredTransactions",
} as const;

export const CAL_WEB_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://digital-web.cal-online.co.il",
  Referer: "https://digital-web.cal-online.co.il/",
  "X-Site-Id": "09031987-273E-2311-906C-8AF85B17C8D9",
  // CAL's edge rejects the generic Node agent and accepts an explicit
  // application agent. This is transport compatibility, not a substitute for
  // CAL credentials or session validation.
  "User-Agent": "CALNativeApp/1.9 CFNetwork/3860.700.1 Darwin/25.6.0",
} as const;

export type CalFailureCode =
  | "network_error"
  | "authentication_failed"
  | "authentication_challenge"
  | "rate_limited"
  | "invalid_response";

/** The only exception allowed out of transport; carries no provider or request text. */
export class CalTransportError extends Error {
  constructor(
    readonly code: CalFailureCode,
    readonly fatal = false,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(`CAL collection failed: ${code}`);
    this.name = "CalTransportError";
  }
}

export interface CalTransportLimits {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxRetryAfterMs?: number;
}

export interface CalTransportOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  limits?: CalTransportLimits;
  onDiagnostic?: (diagnostic: CalTransportDiagnostic) => void | Promise<void>;
}

export interface CalTransportDiagnostic {
  endpoint: keyof typeof CAL_ENDPOINTS | "unknown";
  httpStatus: number | null;
  contentType: "json" | "html" | "other";
  outcome: CalFailureCode | "success";
  stage:
    | "request"
    | "redirect"
    | "http_status"
    | "response_size"
    | "response_body"
    | "utf8_decode"
    | "json_keys"
    | "json_parse"
    | "json_shape"
    | "authentication"
    | "complete"
    | "endpoint_policy"
    | "timeout"
    | "cancelled";
}

function integerLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) {
    throw new CalTransportError("invalid_response", true);
  }
  return selected;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new CalTransportError("network_error", false, true));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** lossless-json rejects conflicting duplicates but accepts equal ones. Reject both. */
function assertUniqueJsonKeys(text: string): void {
  const containers: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{") {
      containers.push(new Set());
    } else if (character === "[") {
      containers.push(null);
    } else if (character === "}" || character === "]") {
      containers.pop();
    } else if (character === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === "\\") {
          index++;
        } else if (text[index] === '"') {
          break;
        }
      }
      let next = index + 1;
      while (/\s/.test(text[next] ?? "")) {
        next++;
      }
      const keys = containers.at(-1);
      if (text[next] === ":" && keys) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (keys.has(key)) {
          throw new CalTransportError("invalid_response", true);
        }
        keys.add(key);
      }
    }
  }
}

const CHALLENGE_FLAGS = [
  "otpRequired",
  "requiresOtp",
  "requiresOTP",
  "requiresCaptcha",
  "captchaRequired",
  "changePasswordRequired",
  "requiresPasswordChange",
  "challengeRequired",
];

const CHALLENGE_TOKEN_FIELDS = [
  "challenge",
  "captcha",
  "recaptcha",
  "temporaryGuid",
];

const CHALLENGE_STATUS_TEXT =
  /(?:\b(?:otp|captcha|challenge)\b|change.?password|להחליף סיסמה|סיסמה חדשה)/i;

const AUTHENTICATION_FAILURE_FLAGS = [
  "authenticationRequired",
  "loginRequired",
  "sessionExpired",
  "tokenExpired",
  "invalidCredentials",
];

const AUTHENTICATION_FAILURE_STATUS_TEXT =
  /(?:unauthori[sz]ed|(?:invalid|expired)\s+(?:token|credentials|session)|(?:token|session)\s+(?:invalid|expired)|(?:login|authentication)\s+required|שם המשתמש או הסיסמה שהוזנו שגויים)/i;

function statusTextMatches(
  value: Record<string, unknown>,
  pattern: RegExp,
): boolean {
  return [value.statusDescription, value.statusTitle, value.title].some(
    (text) => typeof text === "string" && pattern.test(text),
  );
}

/** No speculative status-code map: explicit challenge markers stop the session. */
export function hasAuthenticationChallenge(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  if (CHALLENGE_FLAGS.some((key) => value[key] === true)) {
    return true;
  }
  if (
    CHALLENGE_TOKEN_FIELDS.some(
      (key) => typeof value[key] === "string" && value[key].trim().length > 0,
    )
  ) {
    return true;
  }
  if (statusTextMatches(value, CHALLENGE_STATUS_TEXT)) {
    return true;
  }
  return isObject(value.result) && hasAuthenticationChallenge(value.result);
}

function hasAuthenticationFailure(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  if (AUTHENTICATION_FAILURE_FLAGS.some((key) => value[key] === true)) {
    return true;
  }
  if (statusTextMatches(value, AUTHENTICATION_FAILURE_STATUS_TEXT)) {
    return true;
  }
  return isObject(value.result) && hasAuthenticationFailure(value.result);
}

function contentTypeClass(
  contentType: string,
): CalTransportDiagnostic["contentType"] {
  if (/^(?:application|text)\/(?:[\w.-]+\+)?json$/.test(contentType)) {
    return "json";
  }
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    return "html";
  }
  return "other";
}

/** Retry-After as delta seconds or an HTTP date; NaN when the date is unparseable. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  if (/^\d+$/.test(header)) {
    return Number(header) * 1_000;
  }
  return Math.max(0, Date.parse(header) - Date.now());
}

const RETRYABLE_SERVER_STATUSES = [500, 502, 503, 504];

/** Codes that stand on their own even when the attempt was rate limited. */
const RATE_LIMIT_OVERRIDING_CODES: readonly CalFailureCode[] = [
  "authentication_challenge",
  "authentication_failed",
  "rate_limited",
];

function waitBeforeRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new CalTransportError("network_error", true));
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function createCalTransport(options: CalTransportOptions = {}) {
  const timeoutMs = integerLimit(options.limits?.timeoutMs, 30_000, 120_000);
  const maxResponseBytes = integerLimit(
    options.limits?.maxResponseBytes,
    16 * 1024 * 1024,
    64 * 1024 * 1024,
  );
  const maxAttempts = integerLimit(options.limits?.maxAttempts, 3, 3);
  const retryDelayMs = integerLimit(options.limits?.retryDelayMs, 250, 5_000);
  const maxRetryAfterMs = integerLimit(
    options.limits?.maxRetryAfterMs,
    5_000,
    30_000,
  );
  const fetcher = options.fetch ?? globalThis.fetch;

  function diagnose(
    endpoint: string,
    response: Response | undefined,
    outcome: CalTransportDiagnostic["outcome"],
    stage: CalTransportDiagnostic["stage"],
  ) {
    const label = (Object.entries(CAL_ENDPOINTS).find(
      ([, value]) => value === endpoint,
    )?.[0] ?? "unknown") as CalTransportDiagnostic["endpoint"];
    const contentType =
      response?.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ?? "";
    try {
      void Promise.resolve(
        options.onDiagnostic?.({
          endpoint: label,
          httpStatus: response?.status ?? null,
          contentType: contentTypeClass(contentType),
          outcome,
          stage,
        }),
      ).catch(() => undefined);
    } catch {
      // Diagnostic callbacks cannot change collection or reflect upstream content.
    }
  }

  async function attempt(
    endpoint: string,
    body: object,
    token?: string,
    finalAttempt = false,
  ): Promise<{
    responseText: string;
    payload: Record<string, unknown>;
    httpStatus: number;
    rateLimited: boolean;
  }> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout.signal])
      : timeout.signal;
    let response: Response | undefined;
    let rateLimited = false;
    let stage: CalTransportDiagnostic["stage"] = "request";
    try {
      if (signal.aborted) {
        throw new CalTransportError("network_error", true);
      }
      response = await withAbort(
        fetcher(endpoint, {
          method: "POST",
          redirect: "manual",
          signal,
          headers: {
            ...CAL_WEB_HEADERS,
            ...(token ? { Authorization: `CALAuthScheme ${token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
        signal,
      );
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        stage = "redirect";
        throw new CalTransportError("invalid_response", true);
      }
      stage = "http_status";
      if (response.status === 401) {
        throw new CalTransportError("authentication_failed", true);
      }
      if (response.status === 403) {
        throw new CalTransportError("authentication_challenge", true);
      }
      const financial =
        endpoint !== CAL_ENDPOINTS.login && endpoint !== CAL_ENDPOINTS.init;
      rateLimited = response.status === 429;
      if (rateLimited) {
        const requestedDelay = parseRetryAfterMs(
          response.headers.get("retry-after"),
        );
        const usableDelay =
          requestedDelay !== undefined && Number.isFinite(requestedDelay)
            ? requestedDelay
            : undefined;
        if (usableDelay !== undefined && usableDelay > maxRetryAfterMs) {
          throw new CalTransportError("rate_limited", true);
        }
        if (!finalAttempt) {
          throw new CalTransportError("rate_limited", false, true, usableDelay);
        }
        if (!financial) {
          throw new CalTransportError("rate_limited", true);
        }
      }
      if (RETRYABLE_SERVER_STATUSES.includes(response.status)) {
        throw new CalTransportError("network_error", false, true);
      }
      if (
        !response.ok &&
        !(financial && response.status >= 400 && response.status < 500)
      ) {
        throw new CalTransportError("invalid_response");
      }
      const declaredLength = response.headers.get("content-length");
      stage = "response_size";
      if (
        declaredLength !== null &&
        Number(declaredLength) > maxResponseBytes
      ) {
        throw new CalTransportError("invalid_response");
      }
      stage = "response_body";
      if (!response.body) {
        throw new CalTransportError("invalid_response");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      let responseText = "";
      try {
        for (;;) {
          const chunk = await withAbort(reader.read(), signal);
          if (chunk.done) {
            break;
          }
          size += chunk.value.byteLength;
          if (size > maxResponseBytes) {
            stage = "response_size";
            throw new CalTransportError("invalid_response");
          }
          try {
            stage = "utf8_decode";
            responseText += decoder.decode(chunk.value, { stream: true });
          } catch {
            throw new CalTransportError("invalid_response");
          }
          stage = "response_body";
        }
        try {
          stage = "utf8_decode";
          responseText += decoder.decode();
        } catch {
          throw new CalTransportError("invalid_response");
        }
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      let payload: unknown;
      try {
        // Reject duplicates before archival; JSON.parse hides overwritten secrets.
        // Numbers are used only for transport/envelope inspection; raw text is unchanged.
        stage = "json_keys";
        assertUniqueJsonKeys(responseText);
        stage = "json_parse";
        payload = parse(responseText, undefined, {
          parseNumber: Number,
          onDuplicateKey: () => {
            throw new CalTransportError("invalid_response", true);
          },
        });
      } catch {
        throw new CalTransportError("invalid_response", true);
      }
      stage = "json_shape";
      if (!isObject(payload)) {
        throw new CalTransportError("invalid_response");
      }
      stage = "authentication";
      if (hasAuthenticationChallenge(payload)) {
        throw new CalTransportError("authentication_challenge", true);
      }
      if (hasAuthenticationFailure(payload)) {
        throw new CalTransportError("authentication_failed", true);
      }
      diagnose(
        endpoint,
        response,
        rateLimited
          ? "rate_limited"
          : response.ok
            ? "success"
            : "invalid_response",
        response.ok ? "complete" : "http_status",
      );
      return {
        responseText,
        payload,
        httpStatus: response.status,
        rateLimited,
      };
    } catch (error) {
      let safe: CalTransportError;
      if (options.signal?.aborted) {
        stage = "cancelled";
        safe = new CalTransportError("network_error", true);
      } else if (
        rateLimited &&
        !(
          error instanceof CalTransportError &&
          RATE_LIMIT_OVERRIDING_CODES.includes(error.code)
        )
      ) {
        safe = new CalTransportError("rate_limited", true);
      } else if (error instanceof CalTransportError) {
        safe = error;
      } else {
        // Never propagate fetch errors: URLs, headers and credentials may be reflected.
        safe = new CalTransportError("network_error", false, true);
      }
      if (timeout.signal.aborted && !options.signal?.aborted) {
        stage = "timeout";
      }
      diagnose(endpoint, response, safe.code, stage);
      throw safe;
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  }

  return {
    async post(endpoint: string, body: object, token?: string) {
      if (
        !Object.values(CAL_ENDPOINTS).some((allowed) => allowed === endpoint)
      ) {
        diagnose(endpoint, undefined, "invalid_response", "endpoint_policy");
        throw new CalTransportError("invalid_response", true);
      }
      const attempts = endpoint === CAL_ENDPOINTS.login ? 1 : maxAttempts;
      for (let index = 0; index < attempts; index++) {
        try {
          return await attempt(endpoint, body, token, index + 1 === attempts);
        } catch (error) {
          const safe =
            error instanceof CalTransportError
              ? error
              : new CalTransportError("network_error");
          if (!safe.retryable || safe.fatal || index + 1 === attempts) {
            throw safe.code === "rate_limited"
              ? new CalTransportError("rate_limited", true)
              : safe;
          }
          await waitBeforeRetry(
            safe.retryAfterMs ?? retryDelayMs * (index + 1),
            options.signal,
          );
        }
      }
      throw new CalTransportError("network_error");
    },
  };
}
