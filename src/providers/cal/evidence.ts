import type { JsonObject, JsonValue } from "../../domain/model.js";
import { canonicalJson } from "../../domain/observations.js";
import {
  evidenceObject,
  type EvidenceShape,
  mergeDeclaredEvidence,
  scalarFields,
  sortedEvidence,
} from "../../domain/provider-evidence.js";

const comment = scalarFields("key value");
const linkedComment = scalarFields("text linkDisplayName linkType link");
const immediateComment = scalarFields("comment");
const paymentHistory = scalarFields("date num amount currency");

/** Retained roles: identity, stated money/dates, merchant, payment context and source explanations. */
export const calRowShape: EvidenceShape = {
  ...scalarFields(`cardUniqueID cardUniqueId transactionID trnIntId
    trnPurchaseDate debCrdDate merchantName merchantId internationalBranchID
    internationalBranchDesc branchCodeDesc superBranchDesc merchantAddress merchantPhoneNo
    amountForDisplay amtBeforeConvAndIndex trnAmt debCrdCurrencyCode
    debCrdCurrencySymbol debCrdCurrencyDesc currencyForDisplay trnCurrencyIsoCode
    transOriginalCurrencyCode trnCurrencySymbol transOriginalSumCurrency srcCurrencyCode crmIccCurrencyDesc
    transactionTypeCode trnTypeCode trnType refundInd numOfPayments numberOfPayments curPaymentNum
    transCardPresentInd walletTranInd tokenInd isAbroadApproval isAbroadTransaction
    trnExacWay walletProviderCode walletProviderDesc walletTokenInd foreignCurrencyWalletType posEntryMod
    forcedDebRate cashAccountAmt cashAccountCurrency cashAccountTrnAmt
    cashAccountCardAmt cashAccountCardCurr discountAmount discountReason roundingAmount roundingReason
    onGoingTransactionsComment paymentsMadeComment chargeExternalToCardComment
    transIndication transSafeIndication transSource transMahut crdExtIdNumTypeCode
    earlyPaymentInd isImmediate isImmediateHHKInd isInterestTransaction isCashBackTransaction isSpreadPaymenstAbroadInd
    firstPaymentAmount tpaApprovalAmount transactionsOrigin j5Indicator`),
  comments: [comment, "set"],
  linkedComments: [linkedComment, "set"],
  immediateComments: [immediateComment, "set"],
  transTypeCommentDetails: ["scalar", "set"],
  paymentsMade: [paymentHistory, "set"],
};

export function calRowEvidence(row: unknown): JsonObject {
  return evidenceObject(row, calRowShape);
}

export const calStateShape: EvidenceShape = {
  identity: {
    ...scalarFields("baseKey occurrenceCount"),
    currentRows: ["scalar"],
  },
  currencyMapping: "scalar",
};

export function projectCalState(value: JsonObject): JsonObject {
  return evidenceObject(value, calStateShape);
}

export const calEvidenceShape: EvidenceShape = {
  rows: [calRowShape],
  retained: {
    comments: [{ ...comment, ...linkedComment, ...immediateComment }],
    paymentHistory: [paymentHistory],
  },
};

/** Project both legacy persisted evidence and fresh extraction through one declaration. */
export function retainCalEvidence(value: JsonObject): JsonObject {
  const result = evidenceObject(value, calEvidenceShape);
  if (Array.isArray(result.rows)) {
    result.rows = sortedEvidence(result.rows);
  }
  const retained = result.retained;
  if (retained && typeof retained === "object" && !Array.isArray(retained)) {
    for (const key of ["comments", "paymentHistory"]) {
      if (Array.isArray(retained[key])) {
        retained[key] = sortedEvidence(retained[key]);
      }
    }
  }
  return result;
}

function componentKey(row: JsonValue): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const posted = row.trnIntId !== undefined;
  const id = posted ? row.trnIntId : row.transactionID;
  const card = posted ? row.cardUniqueId : row.cardUniqueID;
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    id === "" ||
    (typeof card !== "string" && typeof card !== "number") ||
    card === ""
  ) {
    return null;
  }
  const ordinal = row.curPaymentNum;
  const component = Number(ordinal);
  const payment =
    (typeof ordinal === "string" || typeof ordinal === "number") &&
    /^\d+(?:\.0+)?$/.test(String(ordinal)) &&
    Number.isSafeInteger(component) &&
    (component > 0 || (component === 0 && row.refundInd === true))
      ? component
      : null;
  return canonicalJson([posted ? "posted" : "pending", card, id, payment]);
}

export function mergeCalEvidence(
  previous: JsonObject,
  incoming: JsonObject,
): JsonObject {
  return mergeDeclaredEvidence(previous, incoming, {
    project: retainCalEvidence,
    componentKey,
    retainedLists: { retained: ["comments", "paymentHistory"] },
  });
}
