import { cardDisplayNameSchema } from "../../domain/cards.js";
import type { CollectionScope } from "../../domain/records.js";
import type {
  CollectionEvent,
  CollectionRange,
} from "../../domain/source-adapter.js";
import {
  hasLegacyStatement,
  ISRACARD_CAPTURE_ENDPOINT,
  ISRACARD_COMPANY_CODES,
  isracardBillingAccount,
  type IsracardCapture,
  type IsracardCard,
  isracardCardKey,
  isracardCardSchema,
  projectIsracardCardList,
  serializeIsracardCapture,
} from "./capture.js";
import {
  type IsracardCredentials,
  isracardCredentialsSchema,
} from "./credentials.js";
import {
  createIsracardTransport,
  isIsracardObject,
  ISRACARD_ENDPOINTS,
  ISRACARD_REDACTED_IDENTITY,
  isracardContainsSecret,
  type IsracardResponse,
  type IsracardTransport,
  IsracardTransportError,
  type IsracardTransportOptions,
  parseIsracardObject,
  redactIsracardSecret,
} from "./transport.js";

export type { IsracardCredentials } from "./credentials.js";

export const ISRACARD_COLLECTOR_VERSION = "isracard-web-v1";

/**
 * One logged-in session shared by consecutive collections: its transport keeps
 * the session cookies, and request starts stay paced across collections.
 * `logins` allows one initial login and one more across all of them.
 */
export interface IsracardSession {
  transport?: IsracardTransport;
  lastStart?: number;
  logins?: number;
}

const SESSION_LOGINS = 2;

/** Aggregate stop threshold for the source text one card-month retains. */
const MAX_MONTH_SOURCE_BYTES = 16 * 1024 * 1024;

/** A financial response resets the consecutive-failure count. */
const FINANCIAL_ENDPOINTS: readonly string[] = [
  ISRACARD_ENDPOINTS.transactions,
  ISRACARD_ENDPOINTS.legacy,
  ISRACARD_ENDPOINTS.details,
];

/** Legacy statement partitions with vouchers, and each one's voucher field. */
const LEGACY_VOUCHER_FIELDS = [
  ["txnIsrael", "voucherNumberRatz"],
  ["txnAbroad", "voucherNumberRatzOutbound"],
] as const;

export interface CollectIsracardOptions extends IsracardTransportOptions {
  credentials: IsracardCredentials;
  range?: CollectionRange;
  transport?: IsracardTransport;
  session?: IsracardSession;
  /** Includes login, discovery, each monthly source and optional details. No retries. */
  callBudget?: number;
  maxHistoryMonths?: number;
  /** Minimum time between the starts of consecutive requests. */
  minIntervalMs?: number;
  /** Optional enrichment, disabled by default and limited across the entire run. */
  maxDetails?: number;
  /** Test clock/pacing injection. Production callers should use the default abortable wait. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface DiscoveredCard {
  card: IsracardCard;
  raw: Record<string, unknown>;
  months: string[];
}

/** A card-list entry with every field collection addresses the card by. */
type CardListEntry = Record<string, unknown> & {
  cardGuid: string;
  cardSuffix: string;
  isActive: boolean;
  isPartner: boolean;
};

function isCardListEntry(raw: unknown): raw is CardListEntry {
  return (
    isIsracardObject(raw) &&
    (ISRACARD_COMPANY_CODES as readonly string[]).includes(
      String(raw.companyCode),
    ) &&
    typeof raw.cardGuid === "string" &&
    raw.cardGuid.trim() !== "" &&
    typeof raw.cardSuffix === "string" &&
    /^\d{4}$/.test(raw.cardSuffix) &&
    typeof raw.isActive === "boolean" &&
    typeof raw.isPartner === "boolean"
  );
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new IsracardTransportError("invalid_response");
  }
  return selected;
}

function validDate(value: string): boolean {
  return (
    /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/** Months since year zero of a `YYYY-MM…` date. */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function monthLabel(index: number): string {
  const year = String(Math.floor(index / 12)).padStart(4, "0");
  const month = String((index % 12) + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** Inclusive billing months; the range does not assert a purchase-date completeness boundary. */
export function isracardHistoryMonths(
  range: CollectionRange,
  maxMonths = 12,
): string[] {
  bounded(maxMonths, 12, 120);
  if (!validDate(range.from) || !validDate(range.to) || range.from > range.to) {
    throw new IsracardTransportError("invalid_response");
  }
  const first = monthIndex(range.from);
  const last = monthIndex(range.to);
  if (last - first + 1 > maxMonths) {
    throw new IsracardTransportError("invalid_response");
  }
  return Array.from({ length: last - first + 1 }, (_, offset) =>
    monthLabel(first + offset),
  );
}

function billingMonth(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = /^\d{2}\/\d{2}\/\d{4}$/.test(value)
    ? value.split("/").reverse().join("-")
    : value.slice(0, 10);
  return validDate(date) ? date.slice(0, 7) : null;
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new IsracardTransportError("network_error"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function safeError(error: unknown): IsracardTransportError {
  return error instanceof IsracardTransportError
    ? error
    : new IsracardTransportError("network_error");
}

function containsSensitiveFields(
  value: unknown,
  secretText: (value: string) => boolean,
): boolean {
  if (typeof value === "string") {
    return secretText(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveFields(item, secretText));
  }
  return (
    isIsracardObject(value) &&
    Object.entries(value).some(
      ([key, item]) =>
        secretText(key) ||
        /^(?:password|sisma|authorization|accessToken|refreshToken|authentication_shared|JSESSIONID|sessionId|cookie|set-cookie)$/i.test(
          key,
        ) ||
        containsSensitiveFields(item, secretText),
    )
  );
}

const identityHolderFields = new Set(["userId", "holderId", "currentId"]);

/**
 * Legacy statements carry the login identity number only as the
 * exact value of these holder fields and as an `id<number>` key. Anywhere else,
 * such as a coincidental voucher, redaction would corrupt evidence.
 */
function identityOnlyInHolderFields(value: unknown, identity: string): boolean {
  if (Array.isArray(value)) {
    return value.every((item) => identityOnlyInHolderFields(item, identity));
  }
  if (!isIsracardObject(value)) {
    return (
      (typeof value !== "string" && typeof value !== "number") ||
      !isracardContainsSecret(String(value), identity)
    );
  }
  return Object.entries(value).every(
    ([key, item]) =>
      (key === `id${identity}` || !isracardContainsSecret(key, identity)) &&
      ((identityHolderFields.has(key) && item === identity) ||
        identityOnlyInHolderFields(item, identity)),
  );
}

function lastFour(entry: string): string | undefined {
  return entry.trim().match(/(\d{4})$/)?.[1];
}

/** A last-four suffix is usable only when unique across the entire discovered wallet. */
function legacyBindings(
  payload: Record<string, unknown>,
  cards: DiscoveredCard[],
): Map<string, string> {
  const result = new Map<string, string>();
  const bean = payload.CardsTransactionsListBean;
  if (!isIsracardObject(bean) || !Array.isArray(bean.cardNumberList)) {
    return result;
  }
  for (let index = 0; index < bean.cardNumberList.length; index++) {
    const entry: unknown = bean.cardNumberList[index];
    if (typeof entry !== "string" || !isIsracardObject(bean[`Index${index}`])) {
      continue;
    }
    const suffix = lastFour(entry);
    const listed = bean.cardNumberList.filter(
      (candidate: unknown) =>
        typeof candidate === "string" && lastFour(candidate) === suffix,
    );
    if (listed.length !== 1) {
      continue;
    }
    const matches = cards.filter(({ card }) => card.cardSuffix === suffix);
    if (matches.length !== 1 || !hasLegacyStatement(matches[0]!.card)) {
      continue;
    }
    const key = isracardCardKey(matches[0]!.card);
    if (result.has(key)) {
      result.delete(key);
      continue;
    }
    result.set(key, String(index));
  }
  return result;
}

/** Optional details are requested only for numeric, non-zero vouchers. */
function isDetailVoucher(voucher: unknown): voucher is string {
  return (
    typeof voucher === "string" &&
    /^\d{1,32}$/.test(voucher) &&
    !/^0+$/.test(voucher)
  );
}

/** The detail-addressable vouchers of one legacy card group, in statement order. */
function legacyDetailVouchers(group: unknown): Set<string> {
  const vouchers = new Set<string>();
  if (
    !isIsracardObject(group) ||
    !Array.isArray(group.CurrentCardTransactions)
  ) {
    return vouchers;
  }
  for (const transactions of group.CurrentCardTransactions) {
    if (!isIsracardObject(transactions)) {
      continue;
    }
    for (const [field, voucherField] of LEGACY_VOUCHER_FIELDS) {
      const rows: unknown = transactions[field];
      if (!Array.isArray(rows)) {
        continue;
      }
      for (const row of rows) {
        const voucher: unknown = isIsracardObject(row)
          ? row[voucherField]
          : null;
        if (isDetailVoucher(voucher)) {
          vouchers.add(voucher);
        }
      }
    }
  }
  return vouchers;
}

/** The DigitalV3 request addresses cards by suffix rather than GUID. */
function hasSuffixCollision(cards: DiscoveredCard[]): boolean {
  return cards.some(
    ({ card }) =>
      cards.filter(
        (candidate) =>
          candidate.card.companyCode === card.companyCode &&
          candidate.card.cardSuffix === card.cardSuffix,
      ).length !== 1,
  );
}

/**
 * One password attempt per session: a collection reuses its session's login
 * and logs in again only when Isracard rejects it. Each completed month is
 * yielded before any next-month request.
 */
export async function* collectIsracard(
  options: CollectIsracardOptions,
): AsyncGenerator<CollectionEvent> {
  let endpoint: string = ISRACARD_ENDPOINTS.login;
  let accountKey: string | null = null;
  let scope: CollectionScope | undefined;
  let transport: IsracardTransport | undefined;
  const session = options.session;
  const campaignScope: CollectionScope = options.range
    ? { kind: "history", ...options.range }
    : { kind: "recent" };
  try {
    const budget = bounded(options.callBudget, 24, 100);
    const maximumMonths = bounded(options.maxHistoryMonths, 12, 120);
    const interval = bounded(options.minIntervalMs, 1_000, 60_000, 1_000);
    const maximumDetails = bounded(options.maxDetails, 0, 20, 0);
    const historyMonths = options.range
      ? isracardHistoryMonths(options.range, maximumMonths)
      : undefined;
    if (!isracardCredentialsSchema.safeParse(options.credentials).success) {
      throw new IsracardTransportError("authentication_failed");
    }
    const secrets = [
      options.credentials.username,
      options.credentials.password,
      options.credentials.cardSuffix,
    ];
    // Each request takes this collection's signal, so a session outlives it.
    const freshTransport = () =>
      options.transport ??
      createIsracardTransport({
        httpClient: options.httpClient,
        ...(options.limits ? { limits: options.limits } : {}),
      });
    transport = session?.transport ?? freshTransport();
    // A session from an earlier collection may have expired since: one
    // rejection of it logs in again, at most once per collection.
    let reusable = session?.transport !== undefined;
    let calls = 0;
    let lastStart = session?.lastStart;
    let detailsFetched = 0;
    let consecutiveFailures = 0;

    async function logIn() {
      reusable = false;
      if (session) {
        if ((session.logins ?? 0) >= SESSION_LOGINS) {
          throw new IsracardTransportError("authentication_failed");
        }
        session.logins = (session.logins ?? 0) + 1;
      }
      await send(ISRACARD_ENDPOINTS.login, {
        KodMishtamesh: "",
        MisparZihuy: options.credentials.username,
        Sisma: options.credentials.password,
        cardSuffix: options.credentials.cardSuffix,
        countryCode: "212",
        idType: "1",
      });
      if (session && transport) {
        session.transport = transport;
      }
    }

    const cardListBody = { companyCode: "99", cardSuffixLength: 4 };

    /** Sends on the session; Isracard rejecting a reused one starts a new one once. */
    async function call(
      target: string,
      body?: object,
      query?: Record<string, string>,
    ): Promise<IsracardResponse> {
      try {
        return await send(target, body, query);
      } catch (error) {
        if (!reusable || safeError(error).code !== "authentication_failed") {
          throw error;
        }
        forgetRejectedSession(safeError(error));
        transport?.close();
        transport = freshTransport();
        await logIn();
        // A new session lists its cards first, as every session does.
        if (target !== ISRACARD_ENDPOINTS.cards) {
          await send(ISRACARD_ENDPOINTS.cards, cardListBody);
        }
        return send(target, body, query);
      }
    }

    async function send(
      target: string,
      body?: object,
      query?: Record<string, string>,
    ): Promise<IsracardResponse> {
      endpoint = target;
      if (calls >= budget) {
        throw new IsracardTransportError("budget_exhausted");
      }
      if (options.signal?.aborted) {
        throw new IsracardTransportError("network_error");
      }
      // Monotonic, so a wall-clock adjustment cannot shorten the spacing.
      const now = options.now ?? (() => performance.now());
      const wait = lastStart === undefined ? 0 : interval - (now() - lastStart);
      if (wait > 0) {
        await (options.sleep ?? defaultSleep)(wait, options.signal);
      }
      if (options.signal?.aborted) {
        throw new IsracardTransportError("network_error");
      }
      calls++;
      lastStart = now();
      if (session) {
        session.lastStart = lastStart;
      }
      let response = await transport!.request(
        target,
        body,
        query,
        options.signal,
      );
      const identity = options.credentials.username;
      const otherSecretText = (text: string) =>
        secrets.some(
          (secret) =>
            secret !== identity && isracardContainsSecret(text, secret),
        ) || transport!.containsAuthMaterial(text);
      const secretText = (text: string) =>
        isracardContainsSecret(text, identity) || otherSecretText(text);
      const reflects = (
        candidate: IsracardResponse,
        test: (text: string) => boolean,
      ) =>
        test(candidate.responseText) ||
        containsSensitiveFields(candidate.payload, test);
      if (target !== ISRACARD_ENDPOINTS.login) {
        // Check other secrets before redaction, which could otherwise split one.
        if (reflects(response, otherSecretText)) {
          throw new IsracardTransportError("invalid_response");
        }
        // Legacy statements repeat the identity number in holder fields; archive
        // a fixed marker there. Any other occurrence still fails the response.
        if (reflects(response, secretText)) {
          if (!identityOnlyInHolderFields(response.payload, identity)) {
            throw new IsracardTransportError("invalid_response");
          }
          const responseText = redactIsracardSecret(
            response.responseText,
            identity,
            ISRACARD_REDACTED_IDENTITY,
          );
          response = {
            ...response,
            responseText,
            payload: parseIsracardObject(responseText),
          };
        }
        if (reflects(response, secretText)) {
          throw new IsracardTransportError("invalid_response");
        }
      }
      if (FINANCIAL_ENDPOINTS.includes(target)) {
        consecutiveFailures = 0;
      }
      return response;
    }

    function financialError(error: unknown): IsracardTransportError {
      const safe = safeError(error);
      forgetRejectedSession(safe);
      consecutiveFailures++;
      return consecutiveFailures >= 3
        ? new IsracardTransportError(safe.code)
        : safe;
    }

    if (!reusable) {
      await logIn();
    }
    const cardList = await call(ISRACARD_ENDPOINTS.cards, cardListBody);
    const capturedAt = new Date().toISOString();
    const data = cardList.payload.data;
    if (
      !isIsracardObject(data) ||
      !Array.isArray(data.cardsList) ||
      !data.cardsList.length ||
      data.cardsList.length > 32
    ) {
      throw new IsracardTransportError("invalid_response");
    }
    const cards: DiscoveredCard[] = [];
    const keys = new Set<string>();
    for (const raw of data.cardsList) {
      if (!isCardListEntry(raw)) {
        throw new IsracardTransportError("invalid_response");
      }
      const parsedCard = isracardCardSchema.safeParse({
        companyCode: String(raw.companyCode) as "11" | "77",
        cardGuid: raw.cardGuid,
        cardSuffix: raw.cardSuffix,
      });
      if (!parsedCard.success) {
        throw new IsracardTransportError("invalid_response");
      }
      const card = parsedCard.data;
      if (keys.has(isracardCardKey(card))) {
        throw new IsracardTransportError("invalid_response");
      }
      keys.add(isracardCardKey(card));
      const next = isIsracardObject(raw.cardChargeNext)
        ? billingMonth(raw.cardChargeNext.billingDate)
        : null;
      const last = isIsracardObject(raw.cardChargeLast)
        ? billingMonth(raw.cardChargeLast.billingDate)
        : null;
      if (!historyMonths && (!next || !last)) {
        yield {
          type: "failure",
          failure: {
            accountKey: isracardCardKey(card),
            endpoint: ISRACARD_ENDPOINTS.cards,
            code: "invalid_response",
            scope: { kind: "recent", cardKey: isracardCardKey(card) },
          },
          fatal: false,
        };
        cards.push({ card, raw, months: [] });
      } else {
        cards.push({
          card,
          raw,
          months: historyMonths ?? [...new Set([next!, last!])],
        });
      }
    }
    if (hasSuffixCollision(cards)) {
      throw new IsracardTransportError("invalid_response");
    }
    // Captures archive only the allowlisted card list, never holder names.
    const cardListText = projectIsracardCardList(cardList.responseText);
    yield {
      type: "card_discovery",
      discovery: {
        observedAt: new Date().toISOString(),
        cards: cards.map(({ card, raw }) => {
          const displayName = cardDisplayNameSchema.safeParse(raw.cardName);
          const account = isracardBillingAccount(raw);
          return {
            cardKey: isracardCardKey(card),
            last4: card.cardSuffix,
            ...(displayName.success ? { displayName: displayName.data } : {}),
            ...(account ? { billingAccount: account } : {}),
          };
        }),
      },
    };
    const months = [...new Set(cards.flatMap((card) => card.months))];
    let remainingFinancialCalls = months.reduce((total, month) => {
      const planned = cards.filter((card) => card.months.includes(month));
      return (
        total +
        planned.length +
        (planned.some(({ card }) => hasLegacyStatement(card)) ? 1 : 0)
      );
    }, 0);
    for (const month of months) {
      const monthlyCards = cards.filter((card) => card.months.includes(month));
      const captures = new Map<string, IsracardCapture>();
      // Counts each distinct retained source string once, not repeated envelope copies.
      // At most one bounded response may cross the 16 MiB aggregate stop threshold.
      let totalBytes = byteLength(cardListText);
      const failures: CollectionEvent[] = [];
      let fatal:
        | {
            error: IsracardTransportError;
            endpoint: string;
            accountKey: string | null;
            scope: CollectionScope | undefined;
          }
        | undefined;
      const mode = options.range ? "history" : "recent";

      function captureFor(card: IsracardCard): IsracardCapture {
        const key = isracardCardKey(card);
        let capture = captures.get(key);
        if (!capture) {
          capture = {
            schemaVersion: 1,
            provider: "isracard",
            mode,
            billingMonth: month,
            card,
            responses: { cardList: cardListText },
          };
          captures.set(key, capture);
        }
        return capture;
      }

      for (const discovered of monthlyCards) {
        accountKey = isracardCardKey(discovered.card);
        scope = { kind: mode, month, cardKey: accountKey };
        try {
          remainingFinancialCalls--;
          const digital = await call(ISRACARD_ENDPOINTS.transactions, {
            card4Number: discovered.card.cardSuffix,
            isNextBillingDate: false,
            cardStatus: discovered.raw.isActive ? 0 : 1,
            billingMonth: `01/${month.slice(5)}/${month.slice(0, 4)}`,
            companyCode: Number(discovered.card.companyCode),
            isPartner: discovered.raw.isPartner,
          });
          captureFor(discovered.card).responses.digital = digital.responseText;
          totalBytes += byteLength(digital.responseText);
          if (totalBytes > MAX_MONTH_SOURCE_BYTES) {
            throw new IsracardTransportError("invalid_response");
          }
        } catch (error) {
          const safe = financialError(error);
          if (safe.fatal) {
            fatal = { error: safe, endpoint, accountKey, scope };
            break;
          }
          failures.push({
            type: "failure",
            failure: { code: safe.code, endpoint, accountKey, scope },
            fatal: false,
          });
        }
      }
      const legacyCards = monthlyCards.filter(({ card }) =>
        hasLegacyStatement(card),
      );
      if (!fatal && legacyCards.length > 0) {
        accountKey = null;
        scope = { kind: mode, month };
        try {
          remainingFinancialCalls--;
          const legacy = await call(ISRACARD_ENDPOINTS.legacy, undefined, {
            month: month.slice(5),
            year: month.slice(0, 4),
            requiredDate: "N",
          });
          totalBytes += byteLength(legacy.responseText);
          const bindings = legacyBindings(legacy.payload, cards);
          // Attach every card's financial source before optional detail requests can fail.
          for (const { card } of legacyCards) {
            const capture = captureFor(card);
            capture.responses.legacy = legacy.responseText;
            const index = bindings.get(isracardCardKey(card));
            if (index !== undefined) {
              capture.legacyCardIndex = index;
            }
          }
          if (totalBytes > MAX_MONTH_SOURCE_BYTES) {
            throw new IsracardTransportError("invalid_response");
          }
          const bean = legacy.payload.CardsTransactionsListBean;
          for (const { card } of legacyCards) {
            const capture = captureFor(card);
            const index = bindings.get(isracardCardKey(card));
            // Optional details address only proven legacy card indices and numeric vouchers.
            if (
              index === undefined ||
              detailsFetched >= maximumDetails ||
              !isIsracardObject(bean)
            ) {
              continue;
            }
            for (const voucherNumber of legacyDetailVouchers(
              bean[`Index${index}`],
            )) {
              if (
                detailsFetched >= maximumDetails ||
                calls + remainingFinancialCalls >= budget
              ) {
                break;
              }
              accountKey = isracardCardKey(card);
              scope = { kind: mode, month, cardKey: accountKey };
              detailsFetched++;
              const detail = await call(ISRACARD_ENDPOINTS.details, undefined, {
                CardIndex: index,
                shovarRatz: voucherNumber,
                moedChiuv: `${month.slice(5)}${month.slice(0, 4)}`,
              });
              (capture.responses.details ??= []).push({
                voucherNumber,
                responseText: detail.responseText,
              });
              totalBytes += byteLength(detail.responseText);
              if (totalBytes > MAX_MONTH_SOURCE_BYTES) {
                throw new IsracardTransportError("invalid_response");
              }
            }
          }
        } catch (error) {
          const safe = financialError(error);
          if (safe.fatal) {
            fatal = { error: safe, endpoint, accountKey, scope };
          } else {
            failures.push({
              type: "failure",
              failure: { code: safe.code, endpoint, accountKey, scope },
              fatal: false,
            });
          }
        }
      }
      for (const [key, capture] of captures) {
        yield {
          type: "capture",
          capture: {
            accountKey: key,
            endpoint: ISRACARD_CAPTURE_ENDPOINT,
            capturedAt,
            responseText: serializeIsracardCapture(capture),
            scope: { kind: mode, month, cardKey: key },
          },
        };
      }
      for (const failure of failures) {
        yield failure;
      }
      if (fatal) {
        const enrichmentOnlyStop =
          fatal.endpoint === ISRACARD_ENDPOINTS.details &&
          remainingFinancialCalls === 0;
        yield {
          type: "failure",
          failure: {
            code: fatal.error.code,
            endpoint: fatal.endpoint,
            accountKey: fatal.accountKey,
            scope: fatal.scope,
          },
          // A terminal enrichment failure does not imply unfinished financial work.
          // Returning below ends collection without the application's history-gap marker.
          fatal: false,
        };
        if (enrichmentOnlyStop) {
          return;
        }
        yield {
          type: "failure",
          failure: {
            code: fatal.error.code,
            endpoint: ISRACARD_CAPTURE_ENDPOINT,
            accountKey: null,
            scope: campaignScope,
          },
          fatal: true,
        };
        return;
      }
    }
  } catch (error) {
    const safe = safeError(error);
    forgetRejectedSession(safe);
    yield {
      type: "failure",
      failure: { accountKey, endpoint, scope, code: safe.code },
      fatal: false,
    };
    yield {
      type: "failure",
      failure: {
        accountKey: null,
        endpoint: ISRACARD_CAPTURE_ENDPOINT,
        scope: campaignScope,
        code: safe.code,
      },
      fatal: true,
    };
  } finally {
    if (transport !== session?.transport) {
      transport?.close();
    }
  }

  /** A rejected session is never sent again; the next collection logs in. */
  function forgetRejectedSession(error: IsracardTransportError) {
    if (
      session &&
      error.code === "authentication_failed" &&
      session.transport === transport
    ) {
      delete session.transport;
    }
  }
}
