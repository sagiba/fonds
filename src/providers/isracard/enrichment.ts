import type {
  JsonObject,
  TransactionFacts,
  TransactionInput,
} from "../../domain/model.js";
import { currentSourceRows } from "../../domain/provider-evidence.js";
import {
  isracardEvidenceGeneration,
  latestIsracardDigitalRows,
} from "./evidence.js";

type SourceRow = Record<string, unknown>;

type Payment = Pick<
  TransactionInput,
  "cardPresent" | "authorizationMethod" | "wallet" | "threeDSecureUsed"
>;

type Wallet = NonNullable<TransactionInput["wallet"]>;

type Channel = "online" | "telephone";

const label = (value: unknown) =>
  typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toLowerCase()
    : undefined;

/** Only a named wallet establishes the brand; numeric flags have endpoint-specific encodings. */
function walletName(value: unknown): Wallet | undefined {
  switch (label(value)) {
    case "apple pay":
    case "apple mc":
      return "apple_pay";
    case "google pay":
      return "google_pay";
    case "samsung pay":
      return "samsung_pay";
    default:
      return undefined;
  }
}

function channelLabel(value: unknown): Channel | undefined {
  switch (label(value)) {
    case "אינטרנט":
    case "עסקת אינטרנט":
    case "עסקת אנטרנט":
    case "עסקה מאובטחת באנטרנט":
    case "עסקה מאובטחת באינטרנט":
      return "online";
    case "טלפוני":
      return "telephone";
    default:
      return undefined;
  }
}

function postedChannel(value: unknown): Channel | undefined {
  return value === "U" || value === "V"
    ? "online"
    : value === "T"
      ? "telephone"
      : undefined;
}

function consistent<Value extends string | boolean>(
  candidates: (Value | undefined)[],
  issues: string[],
): Value | null | undefined {
  const values = [
    ...new Set(
      candidates.filter((value): value is Value => value !== undefined),
    ),
  ];
  if (values.length > 1) {
    issues.push("conflicting_payment_context");
    return null;
  }
  return values[0];
}

function context(
  channels: (Channel | undefined)[],
  presence: (boolean | undefined)[],
  wallets: (Wallet | undefined)[],
  secureOnline: boolean,
  issues: string[],
): Payment {
  const channel = consistent(channels, issues);
  const cardPresent = consistent(
    [
      ...presence,
      ...channels.map((value) => (value === undefined ? undefined : false)),
    ],
    issues,
  );
  const wallet = consistent(wallets, issues);
  return {
    cardPresent,
    wallet,
    authorizationMethod:
      channel === null || cardPresent === null
        ? null
        : channel === "online" ||
            (channel === undefined && cardPresent === false && wallet != null)
          ? "online"
          : undefined,
    threeDSecureUsed: secureOnline
      ? channels.includes("telephone") || cardPresent === null
        ? null
        : true
      : undefined,
  };
}

/** A missing optional detail cannot resolve a conflict with the detail already bound to this identity. */
export function retainedPaymentContext(
  input: Readonly<
    Pick<TransactionFacts, "status" | "identityStrength" | "details">
  >,
): { payment: Payment; issues: string[] } | undefined {
  if (input.status !== "posted" || input.identityStrength !== "native") {
    return undefined;
  }
  const namespace = input.details.provider.isracard;
  const detail = namespace?.detail;
  if (
    !namespace ||
    !detail ||
    typeof detail !== "object" ||
    Array.isArray(detail) ||
    typeof detail.voucherNumberRatz !== "string"
  ) {
    return undefined;
  }
  const values = currentSourceRows(namespace);
  const rows = values.filter(
    (row): row is JsonObject =>
      row !== null && typeof row === "object" && !Array.isArray(row),
  );
  if (
    rows.length === 0 ||
    rows.length !== values.length ||
    !rows.every(
      (row) =>
        (row.seqVoucherNumber ??
          row.voucherNumberRatz ??
          row.voucherNumberRatzOutbound) === detail.voucherNumberRatz,
    )
  ) {
    return undefined;
  }
  const issues: string[] = [];
  const digital = rows.filter(
    (row) => isracardEvidenceGeneration(row) === "digital",
  );
  // An omitted feed does not retract its latest statement for this voucher.
  const retainedDigital = latestIsracardDigitalRows(namespace).filter(
    (row): row is JsonObject =>
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      row.seqVoucherNumber === detail.voucherNumberRatz &&
      isracardEvidenceGeneration(row) === "digital",
  );
  const interpreted = postedPaymentContext(
    digital.length > 0 ? digital : retainedDigital,
    detail,
    issues,
  );
  // Stored evidence may contradict a current read, but its mere retention is
  // not a fresh statement that can resolve an earlier conflict.
  const payment: Payment = {};
  for (const key of [
    "cardPresent",
    "authorizationMethod",
    "wallet",
    "threeDSecureUsed",
  ] as const) {
    if (interpreted[key] === null) {
      payment[key] = null;
    }
  }
  return { payment, issues };
}

/** Pending codebooks differ from posted ones; explicit descriptions carry the reviewed meaning. */
export function approvalPaymentContext(
  row: SourceRow,
  issues: string[],
): Payment {
  return context(
    [
      channelLabel(row.tranzacCodeDescription),
      channelLabel(row.securityIndicatorDescription),
    ],
    [],
    [walletName(row.walletTypeDescription)],
    false,
    issues,
  );
}

/** Caller has established that the optional detail uniquely belongs to these observations. */
export function postedPaymentContext(
  rows: SourceRow[],
  detail: SourceRow | null,
  issues: string[],
): Payment {
  const codes = [
    ...rows.map((row) => row.tranzacCodeType),
    detail?.dealCode,
  ].map((value) => (typeof value === "string" ? value.trim() : undefined));
  const presented = label(detail?.clearingData);
  return context(
    [
      ...codes.map(postedChannel),
      ...rows.map((row) => channelLabel(row.tranzacCodeDescription)),
      channelLabel(detail?.transactionType),
    ],
    [
      ...rows.map((row) =>
        row.presentCard === true || label(row.presentCard) === "true"
          ? true
          : undefined,
      ),
      presented === "הוצג" ? true : presented === "לא הוצג" ? false : undefined,
    ],
    [walletName(detail?.transactionType), walletName(detail?.walletPayName)],
    codes.includes("V"),
    issues,
  );
}
