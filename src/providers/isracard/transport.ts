import { isLosslessNumber, parse } from "lossless-json";

import type { CollectionFailure } from "../../domain/records.js";

/** The legacy host: login, the legacy statement and transaction details. */
export const ISRACARD_LEGACY_HOST = "digital.isracard.co.il";

/** The only hosts a request may name; redirects are never followed. */
export const ISRACARD_WEB_HOSTS: ReadonlySet<string> = new Set([
  ISRACARD_LEGACY_HOST,
  "web.isracard.co.il",
]);

/** The parent domain whose session cookies the DigitalV3 routes require. */
const ISRACARD_COOKIE_DOMAIN = "isracard.co.il";

export const ISRACARD_ENDPOINTS = {
  login:
    "https://digital.isracard.co.il/services/ProxyRequestHandler.ashx?reqName=performLogonI",
  cards:
    "https://web.isracard.co.il/ocp/transactions/DigitalV3.Transactions/GetCardList",
  transactions:
    "https://web.isracard.co.il/ocp/transactions/DigitalV3.Transactions/GetTransactionsList",
  legacy:
    "https://digital.isracard.co.il/services/ProxyRequestHandler.ashx?reqName=CardsTransactionsList",
  details:
    "https://digital.isracard.co.il/services/ProxyRequestHandler.ashx?reqName=PirteyIska_204",
} as const;

const MAX_REQUEST_BODY_BYTES = 32_768;
const MAX_SET_COOKIE_LENGTH = 8192;
const MAX_COOKIES = 100;
const MAX_AUTH_VALUES = 500;

const ENDPOINT_URLS: ReadonlySet<string> = new Set(
  Object.values(ISRACARD_ENDPOINTS),
);

const ENDPOINT_QUERY_KEYS: Partial<Record<string, readonly string[]>> = {
  [ISRACARD_ENDPOINTS.legacy]: ["month", "year", "requiredDate"],
  [ISRACARD_ENDPOINTS.details]: ["CardIndex", "shovarRatz", "moedChiuv"],
};

export type IsracardFailureCode = CollectionFailure["code"];

/** Errors never include provider bodies, URLs, credentials or cookies. */
export class IsracardTransportError extends Error {
  constructor(
    readonly code: IsracardFailureCode,
    readonly fatal = true,
  ) {
    super(`Isracard collection failed: ${code}`);
    this.name = "IsracardTransportError";
  }
}

export interface IsracardHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}

/** Node I/O belongs to runtime; implementations must honor cancellation and close. */
export interface IsracardHttpClient {
  request(options: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  }): Promise<IsracardHttpResponse>;
}

export interface IsracardTransportOptions {
  httpClient: IsracardHttpClient;
  signal?: AbortSignal;
  limits?: { timeoutMs?: number; maxResponseBytes?: number };
}

export interface IsracardResponse {
  responseText: string;
  payload: Record<string, unknown>;
  httpStatus: number;
}

export interface IsracardTransport {
  /** `signal` cancels this request; without it, the transport's own signal does. */
  request(
    endpoint: string,
    body?: object,
    query?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<IsracardResponse>;
  /** Tests and archival guards can inspect secret reflection without exposing cookies. */
  containsAuthMaterial(text: string): boolean;
  close(): void;
}

interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expires: number;
}

export function isIsracardObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDigits(text: string): boolean {
  return /^\d+$/.test(text);
}

/** Whether `text[start, start + length)` is not flanked by another digit. */
function isWholeDigitRun(text: string, start: number, length: number): boolean {
  return (
    !/\d/.test(text[start - 1] ?? "") && !/\d/.test(text[start + length] ?? "")
  );
}

/** Numeric credentials must be whole digit runs, not substrings of unrelated vouchers. */
export function isracardContainsSecret(text: string, secret: string): boolean {
  if (!isDigits(secret)) {
    return text.includes(secret);
  }
  let index = text.indexOf(secret);
  while (index !== -1) {
    if (isWholeDigitRun(text, index, secret.length)) {
      return true;
    }
    index = text.indexOf(secret, index + 1);
  }
  return false;
}

/** Archived in place of the login identity number when a statement repeats it. */
export const ISRACARD_REDACTED_IDENTITY = "[redacted-identity-number]";

/** Replaces exactly the occurrences that `isracardContainsSecret` detects. */
export function redactIsracardSecret(
  text: string,
  secret: string,
  marker: string,
): string {
  if (!secret) {
    return text;
  }
  if (!isDigits(secret)) {
    return text.split(secret).join(marker);
  }
  let result = "";
  let copied = 0;
  let index = text.indexOf(secret);
  while (index !== -1) {
    if (isWholeDigitRun(text, index, secret.length)) {
      result += text.slice(copied, index) + marker;
      copied = index + secret.length;
      index = text.indexOf(secret, copied);
    } else {
      index = text.indexOf(secret, index + 1);
    }
  }
  return result + text.slice(copied);
}

function limit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new IsracardTransportError("invalid_response");
  }
  return selected;
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new IsracardTransportError("network_error"));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The index of the quote that closes the string opened at `start`. */
function closingQuoteIndex(text: string, start: number): number {
  let index = start + 1;
  for (; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
    } else if (text[index] === '"') {
      break;
    }
  }
  return index;
}

function nextNonSpaceIndex(text: string, from: number): number {
  let index = from;
  while (/\s/.test(text[index] ?? "")) {
    index++;
  }
  return index;
}

/** Reject equal duplicate keys too: overwritten authentication fields must not hide. */
function parseObject(text: string): Record<string, unknown> {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{") {
      stack.push(new Set());
    } else if (character === "[") {
      stack.push(null);
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === '"') {
      const start = index;
      index = closingQuoteIndex(text, start);
      const next = nextNonSpaceIndex(text, index + 1);
      const keys = stack.at(-1);
      if (text[next] === ":" && keys) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (keys.has(key)) {
          throw new IsracardTransportError("invalid_response");
        }
        keys.add(key);
      }
    }
  }
  const payload: unknown = parse(text, undefined, { parseNumber: Number });
  if (!isIsracardObject(payload)) {
    throw new IsracardTransportError("invalid_response");
  }
  return payload;
}

/** Applies the transport's duplicate-key and object checks to an altered body. */
export function parseIsracardObject(text: string): Record<string, unknown> {
  try {
    return parseObject(text);
  } catch {
    throw new IsracardTransportError("invalid_response");
  }
}

const CHALLENGE_FLAG_KEY =
  /^(?:isCaptcha|requiresCaptcha|requiresOtp|requiresMfa|isGoogleRecaptchaV3)$/i;
const SESSION_FAILURE_FLAG_KEY =
  /^(?:sessionExpired|isSessionExpired|requiresLogin|loginRequired|authenticationRequired)$/i;
const AUTHENTICATED_FLAG_KEY = /^(?:isAuthenticated|authenticated)$/i;
const SESSION_FAILURE_DESCRIPTION =
  /^(?:session (?:has )?expired|unauthori[sz]ed|not authenticated|authentication required|login required)[.!]?$/i;

/** An HTML page or a known interstitial instead of JSON. */
const CHALLENGE_PAGE =
  /^\s*(?:<|just a moment|block automation|captcha challenge)/i;

function isTrueFlag(value: unknown): boolean {
  return [true, "true", 1, "1"].includes(value as string | number | boolean);
}

function isFalseFlag(value: unknown): boolean {
  return [false, "false", 0, "0"].includes(value as string | number | boolean);
}

/** Whether any entry, at any depth, satisfies `matches`. */
function hasEntry(
  value: unknown,
  matches: (key: string, item: unknown) => boolean,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasEntry(item, matches));
  }
  return (
    isIsracardObject(value) &&
    Object.entries(value).some(
      ([key, item]) => matches(key, item) || hasEntry(item, matches),
    )
  );
}

function hasChallenge(value: unknown): boolean {
  return hasEntry(
    value,
    (key, item) => CHALLENGE_FLAG_KEY.test(key) && isTrueFlag(item),
  );
}

function hasAuthenticationFailure(value: unknown): boolean {
  return hasEntry(
    value,
    (key, item) =>
      (SESSION_FAILURE_FLAG_KEY.test(key) && isTrueFlag(item)) ||
      (AUTHENTICATED_FLAG_KEY.test(key) && isFalseFlag(item)) ||
      (key === "errorDescription" &&
        typeof item === "string" &&
        SESSION_FAILURE_DESCRIPTION.test(item.trim())),
  );
}

/** A redirect back to the login page means the session was not accepted. */
function isLoginRedirect(location: unknown, base: URL): boolean {
  if (typeof location !== "string") {
    return false;
  }
  let destination: URL;
  try {
    destination = new URL(location, base);
  } catch {
    // Any other redirect is rejected as an unexpected status.
    return false;
  }
  return (
    destination.protocol === "https:" &&
    ISRACARD_WEB_HOSTS.has(destination.hostname) &&
    /^\/personalarea\/login\/?$/i.test(destination.pathname)
  );
}

function isSuccessErrorCode(code: unknown): boolean {
  // Extraction retains numeric lexemes; transport parses status numbers as Number.
  const value = isLosslessNumber(code) ? Number(code.value) : code;
  return (
    value === undefined ||
    value === null ||
    [0, "0", ""].includes(value as string | number)
  );
}

export function isIsracardDigitalSuccess(
  payload: Record<string, unknown>,
): boolean {
  return payload.isSuccess === true && isSuccessErrorCode(payload.errorCode);
}

/** Each endpoint family reports application-level success differently. */
function assertEndpointSuccess(
  endpoint: string,
  payload: Record<string, unknown>,
): void {
  if (endpoint === ISRACARD_ENDPOINTS.login) {
    if (String(payload.status) !== "1") {
      throw new IsracardTransportError("authentication_failed");
    }
    return;
  }
  if (
    endpoint === ISRACARD_ENDPOINTS.cards ||
    endpoint === ISRACARD_ENDPOINTS.transactions
  ) {
    if (!isIsracardDigitalSuccess(payload)) {
      throw new IsracardTransportError("invalid_response", false);
    }
    return;
  }
  if (
    !isIsracardObject(payload.Header) ||
    String(payload.Header.Status) !== "1"
  ) {
    throw new IsracardTransportError("invalid_response", false);
  }
}

function isAllowedQueryParameter(
  endpoint: string,
  key: string,
  value: string,
): boolean {
  const allowedKeys = ENDPOINT_QUERY_KEYS[endpoint] ?? [];
  return (
    allowedKeys.includes(key) &&
    (key === "requiredDate" ? value === "N" : /^[\d]+$/.test(value)) &&
    value.length <= 32
  );
}

function domainMatches(cookie: SessionCookie, hostname: string): boolean {
  return cookie.hostOnly
    ? cookie.domain === hostname
    : hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
}

function pathMatches(cookie: SessionCookie, pathname: string): boolean {
  const directory = cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`;
  return pathname === cookie.path || pathname.startsWith(directory);
}

/** The `__Secure-` and `__Host-` name prefixes promise these attributes. */
function violatesNamePrefix(cookie: SessionCookie): boolean {
  return (
    (cookie.name.startsWith("__Secure-") && !cookie.secure) ||
    (cookie.name.startsWith("__Host-") &&
      (!cookie.secure || !cookie.hostOnly || cookie.path !== "/"))
  );
}

// Routing/language flags are not authentication secrets. Known session cookies
// remain protected even if a provider unexpectedly issues a short value.
const SESSION_COOKIE_NAME =
  /^(?:authentication_shared|JSESSIONID|ASP\.NET_SessionId|__RequestVerificationToken|bckey|__cf_bm|__cfwaitingroom|TS[0-9a-f]+)$/i;
const TOKEN_LIKE_VALUE = /^[A-Za-z0-9+/_=.%~-]{16,}$/;

function isAuthCookie(name: string, value: string): boolean {
  return SESSION_COOKIE_NAME.test(name) || TOKEN_LIKE_VALUE.test(value);
}

async function readResponseText(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let responseText = "";
  let bytes = 0;
  const iterator = body[Symbol.asyncIterator]();
  for (;;) {
    const next = await withAbort(iterator.next(), signal);
    if (next.done) {
      break;
    }
    const chunk = next.value;
    if (signal.aborted) {
      throw new IsracardTransportError("network_error");
    }
    bytes += chunk.byteLength;
    if (bytes > maxResponseBytes) {
      throw new IsracardTransportError("invalid_response");
    }
    try {
      responseText += decoder.decode(chunk, { stream: true });
    } catch {
      throw new IsracardTransportError("invalid_response");
    }
  }
  try {
    return responseText + decoder.decode();
  } catch {
    throw new IsracardTransportError("invalid_response");
  }
}

/** Browser-compatible headers; their acceptance is empirical, not guaranteed. */
const browserHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "identity",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "sec-ch-ua":
    '"Chromium";v="149", "Google Chrome";v="149", "Not_A Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

export function createIsracardTransport(
  options: IsracardTransportOptions,
): IsracardTransport {
  const timeoutMs = limit(options.limits?.timeoutMs, 30_000, 120_000);
  const maxResponseBytes = limit(
    options.limits?.maxResponseBytes,
    4 * 1024 * 1024,
    16 * 1024 * 1024,
  );
  const cookies = new Map<string, SessionCookie>();
  const authValues = new Set<string>();
  let closed = false;

  function storeCookies(
    url: URL,
    headers: IsracardHttpResponse["headers"],
  ): void {
    const setCookie = headers["set-cookie"];
    const setCookies =
      typeof setCookie === "string" ? [setCookie] : (setCookie ?? []);
    for (const raw of setCookies) {
      if (raw.length > MAX_SET_COOKIE_LENGTH || /[\r\n]/.test(raw)) {
        throw new IsracardTransportError("invalid_response");
      }
      const [pair = "", ...attributes] = raw.split(";");
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      if (
        equals < 1 ||
        !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) ||
        /[\x00-\x20\x7f;,]/.test(value)
      ) {
        continue;
      }
      const cookie: SessionCookie = {
        name,
        value,
        domain: url.hostname,
        hostOnly: true,
        path: url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/",
        secure: false,
        expires: Infinity,
      };
      let maxAge: number | undefined;
      for (const attribute of attributes) {
        const [attributeName = "", ...rest] = attribute.trim().split("=");
        const attributeValue = rest.join("=").trim();
        switch (attributeName.toLowerCase()) {
          case "domain":
            cookie.domain = attributeValue.toLowerCase().replace(/^\./, "");
            cookie.hostOnly = false;
            break;
          case "path":
            if (attributeValue.startsWith("/")) {
              cookie.path = attributeValue;
            }
            break;
          case "secure":
            cookie.secure = true;
            break;
          case "max-age":
            if (/^-?\d+$/.test(attributeValue)) {
              maxAge = Number(attributeValue);
            }
            break;
          case "expires":
            if (Number.isFinite(Date.parse(attributeValue))) {
              cookie.expires = Date.parse(attributeValue);
            }
            break;
        }
      }
      if (
        cookie.domain !== ISRACARD_COOKIE_DOMAIN &&
        cookie.domain !== url.hostname
      ) {
        continue;
      }
      if (violatesNamePrefix(cookie)) {
        continue;
      }
      if (maxAge !== undefined) {
        cookie.expires = Date.now() + maxAge * 1000;
      }
      const key = JSON.stringify([name, cookie.domain, cookie.path]);
      if (cookie.expires <= Date.now()) {
        cookies.delete(key);
      } else {
        cookies.set(key, cookie);
      }
      if (value && cookie.expires > Date.now() && isAuthCookie(name, value)) {
        authValues.add(value);
      }
      if (cookies.size > MAX_COOKIES || authValues.size > MAX_AUTH_VALUES) {
        throw new IsracardTransportError("invalid_response");
      }
    }
  }

  return {
    containsAuthMaterial(text) {
      return [...authValues].some((value) =>
        isracardContainsSecret(text, value),
      );
    },
    close() {
      closed = true;
      cookies.clear();
      authValues.clear();
    },
    async request(endpoint, body, query, requestSignal = options.signal) {
      if (closed || !ENDPOINT_URLS.has(endpoint)) {
        throw new IsracardTransportError("invalid_response");
      }
      const url = new URL(endpoint);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (!isAllowedQueryParameter(endpoint, key, value)) {
          throw new IsracardTransportError("invalid_response");
        }
        url.searchParams.set(key, value);
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      requestSignal?.addEventListener("abort", onAbort, { once: true });
      if (requestSignal?.aborted) {
        controller.abort();
      }
      const timer = setTimeout(onAbort, timeoutMs);
      let response: IsracardHttpResponse | undefined;
      try {
        if (controller.signal.aborted) {
          throw new IsracardTransportError("network_error");
        }
        const cookieHeader = [...cookies.values()]
          .filter(
            (cookie) =>
              cookie.expires > Date.now() &&
              domainMatches(cookie, url.hostname) &&
              pathMatches(cookie, url.pathname) &&
              (!cookie.secure || url.protocol === "https:"),
          )
          .sort((a, b) => b.path.length - a.path.length)
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");
        const bodyText = body === undefined ? undefined : JSON.stringify(body);
        if (
          bodyText !== undefined &&
          new TextEncoder().encode(bodyText).length > MAX_REQUEST_BODY_BYTES
        ) {
          throw new IsracardTransportError("invalid_response");
        }
        const refererPath = url.hostname.startsWith("digital.")
          ? "/personalarea/Login/"
          : "/transactions";
        const contentType =
          endpoint === ISRACARD_ENDPOINTS.login
            ? "application/x-www-form-urlencoded; charset=UTF-8"
            : "application/json";
        const request = options.httpClient.request({
          url: url.toString(),
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...browserHeaders,
            origin: url.origin,
            referer: `${url.origin}${refererPath}`,
            ...(body ? { "content-type": contentType } : {}),
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
          },
          ...(bodyText === undefined ? {} : { body: bodyText }),
          signal: controller.signal,
        });
        // A misbehaving injected client must not outlive the request deadline.
        void request.then(
          (late) => {
            if (controller.signal.aborted) {
              late.close();
            }
          },
          () => undefined,
        );
        response = await withAbort(request, controller.signal);
        if (
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599
        ) {
          throw new IsracardTransportError("invalid_response");
        }
        if (response.status === 429) {
          throw new IsracardTransportError("rate_limited");
        }
        if (response.status === 403 || response.headers["cf-mitigated"]) {
          throw new IsracardTransportError("authentication_challenge");
        }
        if (response.status === 401) {
          throw new IsracardTransportError("authentication_failed");
        }
        if (
          response.status >= 300 &&
          response.status < 400 &&
          isLoginRedirect(response.headers.location, url)
        ) {
          throw new IsracardTransportError("authentication_failed");
        }
        if (response.status < 200 || response.status >= 300) {
          throw new IsracardTransportError(
            response.status >= 500 ? "network_error" : "invalid_response",
            false,
          );
        }
        const declaredLength = response.headers["content-length"];
        if (declaredLength && Number(declaredLength) > maxResponseBytes) {
          throw new IsracardTransportError("invalid_response");
        }
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding !== "identity") {
          throw new IsracardTransportError("invalid_response");
        }
        const responseText = await readResponseText(
          response.body,
          controller.signal,
          maxResponseBytes,
        );
        if (CHALLENGE_PAGE.test(responseText)) {
          throw new IsracardTransportError("authentication_challenge");
        }
        const payload = parseIsracardObject(responseText);
        if (hasChallenge(payload)) {
          throw new IsracardTransportError("authentication_challenge");
        }
        if (hasAuthenticationFailure(payload)) {
          throw new IsracardTransportError("authentication_failed");
        }
        assertEndpointSuccess(endpoint, payload);
        storeCookies(url, response.headers);
        return { responseText, payload, httpStatus: response.status };
      } catch (error) {
        throw error instanceof IsracardTransportError
          ? error
          : new IsracardTransportError(
              "network_error",
              controller.signal.aborted,
            );
      } finally {
        clearTimeout(timer);
        requestSignal?.removeEventListener("abort", onAbort);
        response?.close();
      }
    },
  };
}
