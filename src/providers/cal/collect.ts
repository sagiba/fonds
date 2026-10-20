import {
  cardAttributesSchema,
  type CardDiscovery,
  cardDisplayNameSchema,
} from "../../domain/cards.js";
import { RESOURCE_ID_MAX_LENGTH } from "../../domain/model.js";
import type { CollectionScope } from "../../domain/records.js";
import type { CollectionEvent } from "../../domain/source-adapter.js";
import { calHasUnsupportedPagination } from "./pagination.js";
import {
  CAL_EMPTY_SEARCH_DESCRIPTION,
  type CalSearchFilters,
  normalizeCalSearchFilters,
} from "./search.js";
import {
  CAL_ENDPOINTS,
  CalTransportError,
  type CalTransportOptions,
  createCalTransport,
  isObject,
} from "./transport.js";

export type { CalSearchFilters } from "./search.js";

export const CAL_COLLECTOR_VERSION = "cal-web-v1";

export interface CalCredentials {
  username: string;
  password: string;
}

export interface CalDateRange {
  from: string;
  to: string;
}

/**
 * One authenticated session shared by consecutive collections. A collection
 * reuses its token and logs in again only when CAL rejects it; `logins`
 * allows one initial login and one more across all of them.
 */
export interface CalSession {
  token?: string;
  logins?: number;
  /** Every token issued across the collections, which no response may echo. */
  issued?: string[];
}

const SESSION_LOGINS = 2;

const SEARCH_WINDOW_MONTHS: readonly number[] = [1, 3, 6, 12];

/** The most bank accounts, and the most cards, accepted from init. */
const MAX_DISCOVERED = 1_000;

/** Consecutive network or invalid-response failures that stop a collection. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

export interface CollectCalOptions extends CalTransportOptions {
  credentials: CalCredentials;
  session?: CalSession;
  /** Inclusive requested history dates; effective windows depend on history mode, without proven completeness. */
  range?: CalDateRange;
  /** Public frontend request contracts; fresh-token history coverage needs validation. */
  historyMode?: "monthly" | "search";
  searchFilters?: CalSearchFilters;
  /** Explicit provider request tuning; no automatic recursive/adaptive retries. */
  searchWindowMonths?: 1 | 3 | 6 | 12;
}

function lastDayOfMonth(date: string): string {
  const end = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return end.toISOString().slice(0, 10);
}

/** One UTC calendar day of overlap per edge; clamp to supported four-digit dates. */
export function calPaddedSearchWindow(window: CalDateRange): CalDateRange {
  // Throws on an invalid range.
  calHistoryMonths(window).next();
  const shift = (date: string, days: -1 | 1): string => {
    const atSupportedEdge =
      (days === -1 && date === "0001-01-01") ||
      (days === 1 && date === "9999-12-31");
    if (atSupportedEdge) {
      return date;
    }
    const shifted = new Date(`${date}T00:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  };
  return { from: shift(window.from, -1), to: shift(window.to, 1) };
}

/** A window fits within one calendar year (at most 366 days, below the UI's 540). */
export function* calHistoryWindows(
  range: CalDateRange,
  maxMonths: 1 | 3 | 6 | 12 = 1,
): Generator<CalDateRange> {
  calHistoryMonths(range).next();
  if (!SEARCH_WINDOW_MONTHS.includes(maxMonths)) {
    throw new CalTransportError("invalid_response", true);
  }
  const to = range.to;
  let start = range.from;
  for (;;) {
    const lastMonth = Math.min(12, Number(start.slice(5, 7)) + maxMonths - 1);
    const windowEnd = lastDayOfMonth(
      `${start.slice(0, 4)}-${String(lastMonth).padStart(2, "0")}-01`,
    );
    const end = windowEnd < to ? windowEnd : to;
    yield { from: start, to: end };
    if (end === to) {
      break;
    }
    const next = new Date(`${end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    start = next.toISOString().slice(0, 10);
  }
}

function validDate(date: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number(date.slice(0, 4)) > 0 &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  );
}

/** Calendar month arithmetic avoids day overflow, timezone and leap-year drift. */
export function* calHistoryMonths(
  range: CalDateRange,
): Generator<{ month: string; year: string; key: string }> {
  if (!validDate(range.from) || !validDate(range.to) || range.from > range.to) {
    throw new CalTransportError("invalid_response", true);
  }
  const first =
    Number(range.from.slice(0, 4)) * 12 + Number(range.from.slice(5, 7)) - 1;
  const last =
    Number(range.to.slice(0, 4)) * 12 + Number(range.to.slice(5, 7)) - 1;
  for (let index = first; index <= last; index++) {
    const year = String(Math.floor(index / 12)).padStart(4, "0");
    const month = String((index % 12) + 1);
    yield { month, year, key: `${year}-${month.padStart(2, "0")}` };
  }
}

/**
 * CAL init card facts kept privately for later card state. The init response
 * is never archived; every other field, including the cardholder's `cardOwner*`
 * name, contact and national ID fields, is discarded here.
 */
const CAL_CARD_ATTRIBUTE_FIELDS = [
  "cardStatus",
  "statusForDisplay",
  "isDebitCard",
  "isVirtualCard",
  "isDigitalCard",
  "isTemporaryCard",
  "cardType",
  "cardTypeCode",
  "companyDescription",
  "issuerName",
  "currentDebitDay",
  "isCreditLimited",
] as const;

function isSafeAttributeValue(
  value: unknown,
  secrets: string[],
): value is string | number | boolean {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.length <= 256 &&
      !value.includes("\0") &&
      !reflectsSecrets(value, secrets))
  );
}

function calCardAttributes(
  card: Record<string, unknown>,
  secrets: string[],
): CardDiscovery["cards"][number]["attributes"] {
  const attributes: Record<string, string | number | boolean> = {};
  for (const field of CAL_CARD_ATTRIBUTE_FIELDS) {
    const value = card[field];
    if (isSafeAttributeValue(value, secrets)) {
      attributes[field] = value;
    }
  }
  const parsed = cardAttributesSchema.safeParse(attributes);
  return parsed.success && Object.keys(parsed.data).length > 0
    ? parsed.data
    : undefined;
}

const CREDENTIAL_KEY =
  /^(?:password|username|authorization|token|calConnectToken|accessToken|refreshToken)$/i;

function reflectsSecrets(value: unknown, secrets: string[]): boolean {
  if (typeof value === "string") {
    return secrets.some((secret) => value.includes(secret));
  }
  if (Array.isArray(value)) {
    return value.some((item) => reflectsSecrets(item, secrets));
  }
  if (isObject(value)) {
    return Object.entries(value).some(
      ([key, item]) =>
        secrets.some((secret) => key.includes(secret)) ||
        CREDENTIAL_KEY.test(key) ||
        reflectsSecrets(item, secrets),
    );
  }
  return false;
}

function isDebitDay(date: unknown): boolean {
  return isObject(date) && Array.isArray(date.transactions);
}

function knownMonthlyShape(result: Record<string, unknown>): boolean {
  return (
    Array.isArray(result.bankAccounts) &&
    result.bankAccounts.every(
      (account) =>
        isObject(account) &&
        Array.isArray(account.debitDates) &&
        account.debitDates.every(isDebitDay) &&
        isObject(account.immidiateDebits) &&
        Array.isArray(account.immidiateDebits.debitDays) &&
        account.immidiateDebits.debitDays.every(isDebitDay),
    )
  );
}

function isSuccessStatus(httpStatus: number): boolean {
  return httpStatus >= 200 && httpStatus < 300;
}

/** The search endpoint's observed no-data answer. */
function isEmptySearch(
  endpoint: string,
  payload: Record<string, unknown>,
): boolean {
  return (
    endpoint === CAL_ENDPOINTS.search &&
    payload.statusCode === 93 &&
    payload.result === null &&
    payload.statusDescription === CAL_EMPTY_SEARCH_DESCRIPTION
  );
}

function hasKnownResultShape(
  endpoint: string,
  scope: CollectionScope,
  result: Record<string, unknown>,
): boolean {
  if (scope.kind === "recent") {
    return (
      Array.isArray(result.transactions) &&
      Array.isArray(result.clearanceRequests)
    );
  }
  if (endpoint === CAL_ENDPOINTS.search) {
    return Array.isArray(result.transArr);
  }
  return knownMonthlyShape(result);
}

/** A successful response in a shape extraction understands. */
function isRecognizedResponse(
  endpoint: string,
  scope: CollectionScope,
  response: { httpStatus: number; payload: Record<string, unknown> },
): boolean {
  const { payload } = response;
  return (
    isSuccessStatus(response.httpStatus) &&
    (isEmptySearch(endpoint, payload) ||
      (payload.statusCode === 1 &&
        isObject(payload.result) &&
        hasKnownResultShape(endpoint, scope, payload.result)))
  );
}

function isUsableCardKey(value: unknown, secrets: string[]): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= RESOURCE_ID_MAX_LENGTH &&
    !value.includes("\0") &&
    !reflectsSecrets(value, secrets)
  );
}

function isUsableLast4(value: unknown, secrets: string[]): value is string {
  return (
    typeof value === "string" &&
    value.length === 4 &&
    /^[0-9]{4}$/.test(value) &&
    !reflectsSecrets(value, secrets)
  );
}

function hasKnownAccount(
  card: unknown,
  accountIds: string[],
): card is Record<string, unknown> & { bankAccountUniqueId: string } {
  return (
    isObject(card) &&
    typeof card.bankAccountUniqueId === "string" &&
    accountIds.includes(card.bankAccountUniqueId)
  );
}

/**
 * Direct web login and the recent contract. Monthly requests follow public
 * scraper precedent, not a proven fresh-token/history completeness contract.
 * Each yielded response is bounded; the consumer archives before asking for another.
 */
export async function* collectCal(
  options: CollectCalOptions,
): AsyncGenerator<CollectionEvent> {
  let endpoint: string = CAL_ENDPOINTS.login;
  let accountKey: string | null = null;
  let scope: CollectionScope | undefined;
  const session = options.session ?? {};
  try {
    const historyMode = options.historyMode ?? "search";
    if (!["monthly", "search"].includes(historyMode)) {
      throw new CalTransportError("invalid_response", true);
    }
    const searchWindowMonths = options.searchWindowMonths ?? 1;
    if (
      !SEARCH_WINDOW_MONTHS.includes(searchWindowMonths) ||
      (options.searchWindowMonths !== undefined &&
        (historyMode !== "search" || !options.range))
    ) {
      throw new CalTransportError("invalid_response", true);
    }
    if (
      options.searchFilters !== undefined &&
      (historyMode !== "search" || !options.range)
    ) {
      throw new CalTransportError("invalid_response", true);
    }
    const searchFilters =
      historyMode === "search" && options.range
        ? normalizeCalSearchFilters(options.searchFilters)
        : undefined;
    if (
      typeof options.credentials.username !== "string" ||
      typeof options.credentials.password !== "string" ||
      !options.credentials.username ||
      !options.credentials.password
    ) {
      throw new CalTransportError("authentication_failed", true);
    }
    const credentials = [
      options.credentials.username,
      options.credentials.password,
    ];
    if (
      searchFilters &&
      (reflectsSecrets(searchFilters, credentials) ||
        credentials.some((secret) =>
          JSON.stringify(searchFilters).includes(secret),
        ))
    ) {
      throw new CalTransportError("invalid_response", true);
    }
    // Validate calendar bounds before sending credentials.
    if (options.range) {
      calPaddedSearchWindow(options.range);
    }
    const transport = createCalTransport(options);
    const initialize = async (candidate: string) => {
      endpoint = CAL_ENDPOINTS.init;
      const response = await transport.post(
        endpoint,
        { tokenGuid: "" },
        candidate,
      );
      if (
        response.payload.statusCode !== 1 ||
        !isObject(response.payload.result)
      ) {
        throw new CalTransportError("authentication_failed", true);
      }
      return response.payload.result;
    };
    let token = session.token ?? "";
    // Every token this session used, fresh or reused, is a secret no response may echo.
    const secrets = [
      options.credentials.username,
      options.credentials.password,
      ...(session.issued ?? []),
      ...(token && !session.issued?.includes(token) ? [token] : []),
    ];
    if (token && searchFilters && reflectsSecrets(searchFilters, [token])) {
      throw new CalTransportError("invalid_response", true);
    }
    // A session from an earlier collection may have expired since: its
    // rejection logs in again, within the session's login allowance.
    let reusable = token !== "";
    /** Logs in and initializes, as the web app does, then keeps the session. */
    const establish = async () => {
      delete session.token;
      reusable = false;
      if ((session.logins ?? 0) >= SESSION_LOGINS) {
        throw new CalTransportError("authentication_failed", true);
      }
      session.logins = (session.logins ?? 0) + 1;
      endpoint = CAL_ENDPOINTS.login;
      const login = await transport.post(endpoint, {
        username: options.credentials.username,
        password: options.credentials.password,
        recaptcha: "",
      });
      const issued = login.payload.token;
      if (
        typeof issued !== "string" ||
        !issued.trim() ||
        /[\r\n]/.test(issued)
      ) {
        throw new CalTransportError("authentication_failed", true);
      }
      secrets.push(issued);
      session.issued = [...(session.issued ?? []), issued];
      if (searchFilters && reflectsSecrets(searchFilters, [issued])) {
        throw new CalTransportError("invalid_response", true);
      }
      token = issued;
      const result = await initialize(token);
      session.token = token;
      return result;
    };
    /** Runs `work` on the session; CAL rejecting a reused one establishes a new one once. */
    const authorized = async <T>(
      work: (current: string) => Promise<T>,
      retry: (result: Record<string, unknown>) => Promise<T> = () =>
        work(token),
    ) => {
      try {
        return await work(token);
      } catch (error) {
        if (
          !reusable ||
          !(error instanceof CalTransportError) ||
          error.code !== "authentication_failed"
        ) {
          throw error;
        }
        return retry(await establish());
      }
    };
    const initialized = reusable
      ? await authorized(initialize, async (result) => result)
      : await establish();
    const { bankAccounts, cards } = initialized;
    if (
      !Array.isArray(bankAccounts) ||
      bankAccounts.length === 0 ||
      bankAccounts.length > MAX_DISCOVERED
    ) {
      throw new CalTransportError("invalid_response", true);
    }
    const accountIds: string[] = [];
    for (const account of bankAccounts) {
      if (
        !isObject(account) ||
        typeof account.bankAccountUniqueId !== "string" ||
        !account.bankAccountUniqueId.trim() ||
        account.bankAccountUniqueId.length > RESOURCE_ID_MAX_LENGTH ||
        reflectsSecrets(account.bankAccountUniqueId, secrets)
      ) {
        throw new CalTransportError("invalid_response", true);
      }
      if (!accountIds.includes(account.bankAccountUniqueId)) {
        accountIds.push(account.bankAccountUniqueId);
      }
    }
    const cardMappings: (CardDiscovery["cards"][number] & {
      accountKey: string;
    })[] = [];
    const discoveryFailures = new Set<string>();
    const cardListUsable =
      Array.isArray(cards) && cards.length <= MAX_DISCOVERED;
    let unmappedDiscoveryFailure = !cardListUsable;
    const conflictedCards = new Set<string>();
    for (const card of cardListUsable ? cards : []) {
      if (
        !hasKnownAccount(card, accountIds) ||
        !isUsableCardKey(card.cardUniqueId, secrets)
      ) {
        if (hasKnownAccount(card, accountIds)) {
          discoveryFailures.add(card.bankAccountUniqueId);
        } else {
          unmappedDiscoveryFailure = true;
        }
        continue;
      }
      if (conflictedCards.has(card.cardUniqueId)) {
        discoveryFailures.add(card.bankAccountUniqueId);
        continue;
      }
      const previous = cardMappings.find(
        (mapping) => mapping.cardKey === card.cardUniqueId,
      );
      if (previous && previous.accountKey !== card.bankAccountUniqueId) {
        discoveryFailures.add(previous.accountKey);
        discoveryFailures.add(card.bankAccountUniqueId);
        conflictedCards.add(card.cardUniqueId);
        cardMappings.splice(cardMappings.indexOf(previous), 1);
        continue;
      }
      if (!previous) {
        const displayName = cardDisplayNameSchema.safeParse(
          card.cardDescription,
        );
        const attributes = calCardAttributes(card, secrets);
        cardMappings.push({
          cardKey: card.cardUniqueId,
          accountKey: card.bankAccountUniqueId,
          last4: isUsableLast4(card.last4Digits, secrets)
            ? card.last4Digits
            : null,
          ...(displayName.success && !reflectsSecrets(displayName.data, secrets)
            ? { displayName: displayName.data }
            : {}),
          ...(attributes ? { attributes } : {}),
        });
      } else {
        if (previous.last4 !== card.last4Digits) {
          // Conflicting duplicate metadata cannot establish a display suffix.
          previous.last4 = null;
        }
        if (previous.displayName !== card.cardDescription) {
          previous.displayName = null;
        }
        if (
          JSON.stringify(previous.attributes ?? null) !==
          JSON.stringify(calCardAttributes(card, secrets) ?? null)
        ) {
          // Conflicting duplicate facts establish none of them.
          delete previous.attributes;
        }
      }
    }
    if (searchFilters?.cardKeys) {
      if (
        searchFilters.cardKeys.some(
          (key) => !cardMappings.some((card) => card.cardKey === key),
        )
      ) {
        throw new CalTransportError("invalid_response", true);
      }
      // Every explicitly selected card has an unambiguous discovered owner.
      discoveryFailures.clear();
      unmappedDiscoveryFailure = false;
    }
    yield {
      type: "card_discovery",
      discovery: {
        observedAt: new Date().toISOString(),
        // CAL's opaque bankAccountUniqueId names the account paying each card's bills.
        cards: cardMappings.map(({ accountKey, ...card }) => ({
          ...card,
          billingAccount: { providerKey: accountKey },
        })),
      },
    };
    let consecutiveNetworkFailures = 0;
    let consecutiveInvalidResponseFailures = 0;

    async function* financial(
      requestEndpoint: string,
      body: object,
      key: string,
      requestScope: CollectionScope,
    ): AsyncGenerator<CollectionEvent> {
      try {
        const response = await authorized((current) =>
          transport.post(requestEndpoint, body, current),
        );
        if (
          secrets.some((secret) => response.responseText.includes(secret)) ||
          reflectsSecrets(response.payload, secrets)
        ) {
          throw new CalTransportError(
            response.rateLimited ? "rate_limited" : "invalid_response",
            true,
          );
        }
        yield {
          type: "capture",
          capture: {
            accountKey: key,
            endpoint: requestEndpoint,
            capturedAt: new Date().toISOString(),
            responseText: response.responseText,
            scope: requestScope,
            ...(response.httpStatus < 200 || response.httpStatus >= 300
              ? { httpStatus: response.httpStatus }
              : {}),
          },
        };
        const recognized = isRecognizedResponse(
          requestEndpoint,
          requestScope,
          response,
        );
        const unsupportedPagination = calHasUnsupportedPagination(
          response.payload,
        );
        if (recognized && !unsupportedPagination && !response.rateLimited) {
          consecutiveNetworkFailures = 0;
          consecutiveInvalidResponseFailures = 0;
        }
        if (response.rateLimited || !recognized || unsupportedPagination) {
          if (!response.rateLimited) {
            consecutiveInvalidResponseFailures++;
          }
          yield {
            type: "failure",
            failure: {
              accountKey: key,
              endpoint: requestEndpoint,
              scope: requestScope,
              code: response.rateLimited ? "rate_limited" : "invalid_response",
            },
            fatal:
              response.rateLimited ||
              consecutiveInvalidResponseFailures >= CONSECUTIVE_FAILURE_LIMIT,
          };
        }
      } catch (error) {
        const safe =
          error instanceof CalTransportError
            ? error
            : new CalTransportError("network_error", true);
        if (safe.code === "authentication_failed") {
          delete session.token;
        }
        if (safe.code === "network_error") {
          consecutiveNetworkFailures++;
        }
        if (safe.code === "invalid_response") {
          consecutiveInvalidResponseFailures++;
        }
        yield {
          type: "failure",
          failure: {
            accountKey: key,
            endpoint: requestEndpoint,
            scope: requestScope,
            code: safe.code,
          },
          fatal:
            safe.fatal ||
            consecutiveNetworkFailures >= CONSECUTIVE_FAILURE_LIMIT ||
            consecutiveInvalidResponseFailures >= CONSECUTIVE_FAILURE_LIMIT,
        };
      }
    }

    for (const id of accountIds) {
      accountKey = id;
      endpoint = CAL_ENDPOINTS.recent;
      scope = { kind: "recent" };
      for await (const event of financial(
        endpoint,
        { bankAccountUniqueID: id },
        id,
        scope,
      )) {
        yield event;
        if (event.type === "failure" && event.fatal) {
          return;
        }
      }
    }
    if (options.range) {
      for (const id of accountIds.filter(
        (id) =>
          !searchFilters?.cardKeys &&
          !cardMappings.some((card) => card.accountKey === id),
      )) {
        discoveryFailures.add(id);
      }
      for (const id of [
        ...discoveryFailures,
        ...(unmappedDiscoveryFailure ? [null] : []),
      ]) {
        yield {
          type: "failure",
          failure: {
            accountKey: id,
            endpoint: CAL_ENDPOINTS.init,
            scope: {
              kind: "history",
              from: options.range.from,
              to: options.range.to,
              ...(searchFilters
                ? { filters: { cal: searchFilters.recorded } }
                : {}),
            },
            code: "invalid_response",
          },
          fatal: false,
        };
      }
      if (historyMode === "search") {
        for (const id of accountIds) {
          const cardKeys = cardMappings
            .filter(
              (card) =>
                card.accountKey === id &&
                (!searchFilters?.cardKeys ||
                  searchFilters.cardKeys.includes(card.cardKey)),
            )
            .map((card) => card.cardKey);
          if (cardKeys.length === 0) {
            continue;
          }
          const cards = cardKeys.map((cardUniqueID) => ({ cardUniqueID }));
          for (const window of calHistoryWindows(
            options.range,
            searchWindowMonths,
          )) {
            const requested = calPaddedSearchWindow(window);
            accountKey = id;
            endpoint = CAL_ENDPOINTS.search;
            scope = {
              kind: "history",
              ...requested,
              windowFrom: window.from,
              windowTo: window.to,
              cardKeys,
              ...(searchFilters
                ? { filters: { cal: searchFilters.recorded } }
                : {}),
            };
            const body = {
              bankAccountUniqueID: id,
              cards,
              fromTransDate: `${requested.from}T00:00:00.000Z`,
              toTransDate: `${requested.to}T23:59:59.999Z`,
              ...searchFilters!.request,
              caller: "module_search",
            };
            for await (const event of financial(endpoint, body, id, scope)) {
              yield event;
              if (event.type === "failure" && event.fatal) {
                return;
              }
            }
          }
        }
        return;
      }
      for (const card of cardMappings) {
        for (const month of calHistoryMonths(options.range)) {
          accountKey = card.accountKey;
          endpoint = CAL_ENDPOINTS.monthly;
          scope = {
            kind: "history",
            cardKey: card.cardKey,
            month: month.key,
            from: options.range.from,
            to: options.range.to,
          };
          for await (const event of financial(
            endpoint,
            {
              cardUniqueId: card.cardKey,
              month: month.month,
              year: month.year,
            },
            card.accountKey,
            scope,
          )) {
            yield event;
            if (event.type === "failure" && event.fatal) {
              return;
            }
          }
        }
      }
    }
  } catch (error) {
    const safe =
      error instanceof CalTransportError
        ? error
        : new CalTransportError("network_error", true);
    if (safe.code === "authentication_failed") {
      delete session.token;
    }
    yield {
      type: "failure",
      failure: {
        accountKey,
        endpoint,
        code: safe.code,
        ...(scope ? { scope } : {}),
      },
      fatal: true,
    };
  }
}
