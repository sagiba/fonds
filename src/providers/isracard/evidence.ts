import type { JsonObject, JsonValue } from "../../domain/model.js";
import { canonicalJson } from "../../domain/observations.js";
import {
  currentSourceRowIndices,
  currentSourceRows,
  evidenceList,
  evidenceObject,
  type EvidenceShape,
  mergeDeclaredEvidence,
  projectEvidence,
  scalarFields,
  sortedEvidence,
} from "../../domain/provider-evidence.js";

export const isracardDigitalRowShape =
  scalarFields(`seqVoucherNumber voucherNumber purchaseDate purchaseTime
  billingAmount billingAmountCurrency billingAmountCurrencySymbol originalAmount originalCurrency originalCurrencyIso
  discountAmount discountIndication discountClubName ilsAmount usdAmount
  businessName businessNumber cityDescription countryCode countryDescription
  transactionCode transactionDescription tranzacCodeType tranzacCodeDescription clearedCode clearedDescription
  isIsraelDeal currentInstallmentNum numberOfInstallment isLastInstallment moreInfo
  presentCard isTransactionSecure isWalletTransaction isdirectDebit isNewDirectDebit`);
export const isracardApprovalRowShape =
  scalarFields(`confirmationLocation seqConfirmationNumber confirmationTimeStamp confirmationNumber
  businessName cityDescription country countryCode countryDesc clearedCode clearedDescription
  purchaseDate originalAmount originalCurrency currencyIso currencyName currencySimbol ilsBillingAmount israelTransactionTime
  transactionCode transactionDescription tranzacCodeType tranzacCodeDescription
  securityIndicatorCode securityIndicatorDescription isTransactionSecure isWalletTransaction walletType walletTypeDescription
  branchCodeType branchCodeDescription creditFromBusiness creditOrCharge directDebit`);
export const isracardLegacyRowShape =
  scalarFields(`voucherNumber voucherNumberRatz voucherNumberRatzOutbound
  fullPurchaseDate fullPurchaseDateOutbound fullPaymentDate purchaseDate purchaseDateOutbound paymentDate
  paymentSum paymentSumOutbound paymentSumSign dealSum dealSumOutbound dealSumType
  currencyId currentPaymentCurrency kodMatbeaMekori
  fullSupplierNameHeb fullSupplierNameOutbound supplierId supplierName supplierNameOutbound city
  moreInfo isHoraatKeva horaatKeva solek`);

export const isracardDetailShape: EvidenceShape = {
  ...scalarFields(`voucherNumber voucherNumberRatz purchaseDateOutboundIsracard purchaseTime
    address phoneNumber city supplierId supplierName supplierNameIsracard motavName
    transactionType walletPayName dealCode dealType wayOfDeal horaatKevaDesc reasonOfTransaction websiteName
    numberOfPayments paymentNumber
    dealSum chargeSum chargeSumToDisplay dealSumOutbound dealSumOutboundInshekels
    currencyId currencyIdForCharge currencyIdOutbound linking
    discount sumBeforeDiscount saleName secondSaleName moreInfo sector clearingData solek
    moedChiuvFull valueDate conversionCurrency conversionDateZMD dateConversion dateConversionOutBound
    dollarConversion dollarTransferRate exchangeRateZMD
    commissionDiscountPercentage commissionDiscountSum commissionNetValue commissionNetValueCurrency
    interestPercentage interestSum moneyWithdrawalCommission dollarTransferCommissionPercentage
    amlaDolarCa amlaDolarCaMatbea scumAmla sumDollar sumOfFund sumOfValueAddedTax`),
  Table1: [scalarFields("paymentNumber paymentDate paymentSum currencyId")],
};

export function isracardEvidenceGeneration(
  row: unknown,
): "approval" | "digital" | "legacy" {
  if (row && typeof row === "object") {
    if (
      ["voucherNumberRatz", "voucherNumberRatzOutbound"].some((key) =>
        Object.hasOwn(row, key),
      )
    ) {
      return "legacy";
    }
    if (Object.hasOwn(row, "seqVoucherNumber")) {
      return "digital";
    }
    if (Object.hasOwn(row, "billingAmount")) {
      return "digital";
    }
    if (
      [
        "confirmationLocation",
        "seqConfirmationNumber",
        "confirmationTimeStamp",
        "confirmationNumber",
        "currencyIso",
        "currencySimbol",
        "israelTransactionTime",
      ].some((key) => Object.hasOwn(row, key))
    ) {
      return "approval";
    }
    if (
      [
        "seqVoucherNumber",
        "billingAmount",
        "businessName",
        "transactionCode",
      ].some((key) => Object.hasOwn(row, key))
    ) {
      return "digital";
    }
  }
  return "legacy";
}

export function isracardRowEvidence(
  row: unknown,
  generation = isracardEvidenceGeneration(row),
): JsonObject {
  return evidenceObject(
    row,
    generation === "approval"
      ? isracardApprovalRowShape
      : generation === "digital"
        ? isracardDigitalRowShape
        : isracardLegacyRowShape,
  );
}

export function isracardDetailEvidence(value: unknown): JsonObject {
  return evidenceObject(value, isracardDetailShape);
}

export const isracardStateShape: EvidenceShape = {
  identity: {
    ...scalarFields("baseKey occurrenceCount"),
    currentRows: ["scalar"],
    latestDigitalRows: ["scalar"],
  },
  observations: [scalarFields("generation path")],
  monetaryEvidence: {
    ...scalarFields(
      "billingMinor billingCurrency originalMinor originalCurrency convention",
    ),
    statedTotals: [["scalar"]],
  },
  billingMonth: "scalar",
};

export function projectIsracardState(value: JsonObject): JsonObject {
  return evidenceObject(value, isracardStateShape);
}

export function retainIsracardEvidence(value: JsonObject): JsonObject {
  const result: JsonObject = {};
  // Older records copied each raw row into an observation with its extraction origin.
  // Match those complete copies before dropping them; source keys alone cannot prove origin.
  const origins = new Map<
    string,
    { generations: ("digital" | "legacy")[]; used: number }
  >();
  for (const observation of evidenceList(value.observations)) {
    if (
      !observation ||
      typeof observation !== "object" ||
      Array.isArray(observation) ||
      (observation.generation !== "digital" &&
        observation.generation !== "legacy") ||
      !observation.row ||
      typeof observation.row !== "object" ||
      Array.isArray(observation.row)
    ) {
      continue;
    }
    const key = canonicalJson(observation.row);
    const entry = origins.get(key) ?? { generations: [], used: 0 };
    entry.generations.push(observation.generation);
    origins.set(key, entry);
  }
  for (const entry of origins.values()) {
    entry.generations.sort();
  }
  if (Object.hasOwn(value, "rows")) {
    result.rows = Array.isArray(value.rows)
      ? sortedEvidence(
          value.rows.map((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) {
              return projectEvidence(row, {});
            }
            const entry = origins.get(canonicalJson(row));
            const generation = entry?.generations[entry.used++];
            return isracardRowEvidence(row, generation);
          }),
        )
      : projectEvidence(value.rows, [{}]);
  }
  if (Object.hasOwn(value, "detail")) {
    result.detail = projectEvidence(value.detail, isracardDetailShape);
  }
  return result;
}

function componentKey(row: JsonValue): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  if (isracardEvidenceGeneration(row) === "approval") {
    return typeof row.confirmationLocation === "string" &&
      /^\d+$/.test(row.confirmationLocation) &&
      Number.isSafeInteger(Number(row.confirmationLocation)) &&
      typeof row.seqConfirmationNumber === "string" &&
      row.seqConfirmationNumber.trim() !== "" &&
      typeof row.confirmationTimeStamp === "string" &&
      row.confirmationTimeStamp.trim() !== ""
      ? canonicalJson([
          "approval",
          Number(row.confirmationLocation),
          row.seqConfirmationNumber,
          row.confirmationTimeStamp,
        ])
      : null;
  }
  if (Object.hasOwn(row, "seqVoucherNumber")) {
    return typeof row.seqVoucherNumber === "string" ||
      typeof row.seqVoucherNumber === "number"
      ? canonicalJson(["digital", row.seqVoucherNumber, row.purchaseDate])
      : null;
  }
  const voucher = row.voucherNumberRatz ?? row.voucherNumberRatzOutbound;
  return typeof voucher === "string" || typeof voucher === "number"
    ? canonicalJson([
        "legacy",
        voucher,
        row.fullPurchaseDate ?? row.fullPurchaseDateOutbound,
      ])
    : null;
}

export function mergeIsracardEvidence(
  previous: JsonObject,
  incoming: JsonObject,
): JsonObject {
  const merged = mergeDeclaredEvidence(previous, incoming, {
    project: retainIsracardEvidence,
    componentKey,
  });
  const digital = evidenceList(retainIsracardEvidence(incoming).rows).filter(
    (row) => isracardEvidenceGeneration(row) === "digital",
  );
  const identity = projectIsracardState(incoming).identity;
  return {
    ...merged,
    identity: {
      ...(identity && typeof identity === "object" && !Array.isArray(identity)
        ? identity
        : {}),
      latestDigitalRows: currentSourceRowIndices(
        evidenceList(merged.rows),
        digital.length > 0 ? digital : latestIsracardDigitalRows(previous),
      ),
    },
  };
}

/** Row shape is an evidence boundary, not chronology; only the last observation supplies fallback facts. */
export function latestIsracardDigitalRows(namespace: JsonObject): JsonValue[] {
  const identity = namespace.identity;
  if (
    identity !== undefined &&
    (!identity || typeof identity !== "object" || Array.isArray(identity))
  ) {
    return [];
  }
  if (identity && Object.hasOwn(identity, "latestDigitalRows")) {
    return currentSourceRows({
      rows: namespace.rows ?? [],
      identity: { currentRows: identity.latestDigitalRows! },
    }).filter((row) => isracardEvidenceGeneration(row) === "digital");
  }
  if (identity && Object.hasOwn(identity, "currentRows")) {
    const current = currentSourceRows(namespace);
    if (
      current.length === 0 &&
      (!Array.isArray(identity.currentRows) || identity.currentRows.length > 0)
    ) {
      return [];
    }
    const digital = current.filter(
      (row) => isracardEvidenceGeneration(row) === "digital",
    );
    if (digital.length > 0) {
      return digital;
    }
  }
  // Without chronology, one retained statement per component is unambiguous;
  // competing shape variants cannot be ordered by their values or array position.
  const digital = evidenceList(retainIsracardEvidence(namespace).rows).filter(
    (row) => isracardEvidenceGeneration(row) === "digital",
  );
  const keys = digital.map(componentKey);
  return keys.includes(null) || new Set(keys).size !== keys.length
    ? []
    : digital;
}
