ALTER TABLE transactions ADD COLUMN transaction_date_time TEXT;
ALTER TABLE transactions ADD COLUMN merchant_address_line TEXT;
ALTER TABLE transactions ADD COLUMN merchant_phone TEXT;
ALTER TABLE transactions ADD COLUMN merchant_city TEXT;
ALTER TABLE transactions ADD COLUMN merchant_country_code TEXT;
ALTER TABLE transactions ADD COLUMN additional_information_json TEXT CHECK (additional_information_json IS NULL OR json_valid(additional_information_json));
ALTER TABLE transactions ADD COLUMN currency_exchange_json TEXT CHECK (currency_exchange_json IS NULL OR json_valid(currency_exchange_json));
ALTER TABLE transactions ADD COLUMN source_issues_json TEXT NOT NULL CHECK (source_issues_json IS NULL OR json_valid(source_issues_json)) DEFAULT '[]';
ALTER TABLE transactions ADD COLUMN provider_json TEXT NOT NULL CHECK (provider_json IS NULL OR json_valid(provider_json)) DEFAULT '{}';
UPDATE transactions SET
  transaction_date_time = json_extract(details_json, '$.transactionDateTime'),
  merchant_address_line = CASE WHEN instr((details_json -> '$.merchant.address'), char(92)) > 0 THEN char(92)||'j'||(details_json -> '$.merchant.address') ELSE json_extract(details_json, '$.merchant.address') END,
  merchant_phone = CASE WHEN instr((details_json -> '$.merchant.phone'), char(92)) > 0 THEN char(92)||'j'||(details_json -> '$.merchant.phone') ELSE json_extract(details_json, '$.merchant.phone') END,
  merchant_city = CASE WHEN instr((details_json -> '$.merchant.city'), char(92)) > 0 THEN char(92)||'j'||(details_json -> '$.merchant.city') ELSE json_extract(details_json, '$.merchant.city') END,
  merchant_country_code = json_extract(details_json, '$.merchant.countryCode'),
  additional_information_json = json_extract(details_json, '$.additionalInformation'),
  currency_exchange_json = json_extract(details_json, '$.currencyExchange'),
  source_issues_json = json_extract(details_json, '$.issues'),
  provider_json = json_extract(details_json, '$.provider');
CREATE TABLE transaction_observations (
  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),
  last_seen_at TEXT NOT NULL,
  last_seen_run_id TEXT NOT NULL REFERENCES sync_runs(id),
  source_refs_json TEXT NOT NULL CHECK (source_refs_json IS NULL OR json_valid(source_refs_json))
) STRICT;
INSERT INTO transaction_observations SELECT id,last_seen_at,last_seen_run_id,json_extract(details_json, '$.sourceRefs') FROM transactions;
CREATE TABLE transaction_reconciliation (
  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),
  payment_context_conflicts_json TEXT CHECK (payment_context_conflicts_json IS NULL OR json_valid(payment_context_conflicts_json)),
  pending_posting_candidates_json TEXT CHECK (pending_posting_candidates_json IS NULL OR json_valid(pending_posting_candidates_json)),
  rejected_posting_keys_json TEXT CHECK (rejected_posting_keys_json IS NULL OR json_valid(rejected_posting_keys_json)),
  provider_identity_json TEXT CHECK (provider_identity_json IS NULL OR json_valid(provider_identity_json)),
  provider_observations_json TEXT CHECK (provider_observations_json IS NULL OR json_valid(provider_observations_json)),
  provider_monetary_evidence_json TEXT CHECK (provider_monetary_evidence_json IS NULL OR json_valid(provider_monetary_evidence_json)),
  provider_billing_month_json TEXT CHECK (provider_billing_month_json IS NULL OR json_valid(provider_billing_month_json)),
  provider_currency_mapping_json TEXT CHECK (provider_currency_mapping_json IS NULL OR json_valid(provider_currency_mapping_json))
) STRICT;
INSERT INTO transaction_reconciliation SELECT id,json_extract(details_json, '$.paymentContextConflicts'),json_extract(details_json, '$.pendingPostingCandidates'),json_extract(details_json, '$.rejectedPostingKeys'),(SELECT json_group_object(key,json_extract(value,'$.identity')) FROM json_each(details_json,'$.provider') WHERE json_type(value,'$.identity') IS NOT NULL),(SELECT json_group_object(key,json_extract(value,'$.observations')) FROM json_each(details_json,'$.provider') WHERE json_type(value,'$.observations') IS NOT NULL),(SELECT json_group_object(key,json_extract(value,'$.monetaryEvidence')) FROM json_each(details_json,'$.provider') WHERE json_type(value,'$.monetaryEvidence') IS NOT NULL),(SELECT json_group_object(key,json_extract(value,'$.billingMonth')) FROM json_each(details_json,'$.provider') WHERE json_type(value,'$.billingMonth') IS NOT NULL),(SELECT json_group_object(key,json_extract(value,'$.currencyMapping')) FROM json_each(details_json,'$.provider') WHERE json_type(value,'$.currencyMapping') IS NOT NULL) FROM transactions;
CREATE TABLE transaction_posting_links (
  transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id),
  posting_link_json TEXT CHECK (posting_link_json IS NULL OR json_valid(posting_link_json))
) STRICT;
INSERT INTO transaction_posting_links SELECT id,json_extract(details_json, '$.postingLink') FROM transactions;
UPDATE transactions SET provider_json = (SELECT json_group_object(p.key,json(json_remove(p.value,'$.identity','$.observations','$.monetaryEvidence','$.billingMonth','$.currencyMapping'))) FROM json_each(provider_json) p);
-- Frozen provider declarations at migration 3; later adapters do not rewrite history.
-- D1 rejects TEMP tables; these work tables are removed before commit.
CREATE TABLE _fonds_evidence_shapes (name TEXT PRIMARY KEY, shape TEXT NOT NULL);
INSERT INTO _fonds_evidence_shapes VALUES
  ('source','{"cal":{"rows":[{"cardUniqueID":"scalar","cardUniqueId":"scalar","transactionID":"scalar","trnIntId":"scalar","trnPurchaseDate":"scalar","debCrdDate":"scalar","merchantName":"scalar","merchantId":"scalar","internationalBranchID":"scalar","internationalBranchDesc":"scalar","merchantAddress":"scalar","merchantPhoneNo":"scalar","amountForDisplay":"scalar","amtBeforeConvAndIndex":"scalar","trnAmt":"scalar","debCrdCurrencyCode":"scalar","debCrdCurrencySymbol":"scalar","debCrdCurrencyDesc":"scalar","currencyForDisplay":"scalar","trnCurrencyIsoCode":"scalar","transOriginalCurrencyCode":"scalar","trnCurrencySymbol":"scalar","transOriginalSumCurrency":"scalar","srcCurrencyCode":"scalar","crmIccCurrencyDesc":"scalar","transactionTypeCode":"scalar","trnTypeCode":"scalar","trnType":"scalar","refundInd":"scalar","numOfPayments":"scalar","numberOfPayments":"scalar","curPaymentNum":"scalar","transCardPresentInd":"scalar","walletTranInd":"scalar","tokenInd":"scalar","isAbroadApproval":"scalar","isAbroadTransaction":"scalar","trnExacWay":"scalar","walletProviderCode":"scalar","walletProviderDesc":"scalar","posEntryMod":"scalar","forcedDebRate":"scalar","cashAccountAmt":"scalar","cashAccountCurrency":"scalar","cashAccountTrnAmt":"scalar","cashAccountCardAmt":"scalar","cashAccountCardCurr":"scalar","discountAmount":"scalar","discountReason":"scalar","roundingAmount":"scalar","roundingReason":"scalar","onGoingTransactionsComment":"scalar","paymentsMadeComment":"scalar","chargeExternalToCardComment":"scalar","transIndication":"scalar","transSafeIndication":"scalar","earlyPaymentInd":"scalar","isImmediate":"scalar","isInterestTransaction":"scalar","comments":[{"key":"scalar","value":"scalar"},"set"],"linkedComments":[{"text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar"},"set"],"immediateComments":[{"comment":"scalar"},"set"],"transTypeCommentDetails":["scalar","set"],"paymentsMade":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]},"set"],"retained":{"comments":[{"key":"scalar","value":"scalar","text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar","comment":"scalar"},"set"],"paymentHistory":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]}},"isracard":{"rows":["@isracard_row","set"],"detail":{"voucherNumber":"scalar","voucherNumberRatz":"scalar","purchaseDateOutboundIsracard":"scalar","purchaseTime":"scalar","address":"scalar","phoneNumber":"scalar","city":"scalar","supplierId":"scalar","supplierName":"scalar","supplierNameIsracard":"scalar","motavName":"scalar","transactionType":"scalar","walletPayName":"scalar","dealCode":"scalar","dealType":"scalar","numberOfPayments":"scalar","paymentNumber":"scalar","dealSum":"scalar","chargeSum":"scalar","chargeSumToDisplay":"scalar","dealSumOutbound":"scalar","dealSumOutboundInshekels":"scalar","currencyId":"scalar","currencyIdForCharge":"scalar","currencyIdOutbound":"scalar","linking":"scalar","discount":"scalar","sumBeforeDiscount":"scalar","saleName":"scalar","secondSaleName":"scalar","moreInfo":"scalar","sector":"scalar","moedChiuvFull":"scalar","valueDate":"scalar","conversionCurrency":"scalar","conversionDateZMD":"scalar","dateConversion":"scalar","dateConversionOutBound":"scalar","dollarConversion":"scalar","dollarTransferRate":"scalar","exchangeRateZMD":"scalar","commissionDiscountPercentage":"scalar","commissionDiscountSum":"scalar","commissionNetValue":"scalar","commissionNetValueCurrency":"scalar","interestPercentage":"scalar","interestSum":"scalar","moneyWithdrawalCommission":"scalar","dollarTransferCommissionPercentage":"scalar","amlaDolarCa":"scalar","amlaDolarCaMatbea":"scalar","scumAmla":"scalar","sumDollar":"scalar","sumOfCompensation":"scalar","sumOfFund":"scalar","sumOfValueAddedTax":"scalar","Table1":[{"paymentNumber":"scalar","paymentDate":"scalar","paymentSum":"scalar","currencyId":"scalar"}]}}}'),
  ('combined','{"cal":{"identity":{"baseKey":"scalar","occurrenceCount":"scalar"},"currencyMapping":"scalar","rows":[{"cardUniqueID":"scalar","cardUniqueId":"scalar","transactionID":"scalar","trnIntId":"scalar","trnPurchaseDate":"scalar","debCrdDate":"scalar","merchantName":"scalar","merchantId":"scalar","internationalBranchID":"scalar","internationalBranchDesc":"scalar","merchantAddress":"scalar","merchantPhoneNo":"scalar","amountForDisplay":"scalar","amtBeforeConvAndIndex":"scalar","trnAmt":"scalar","debCrdCurrencyCode":"scalar","debCrdCurrencySymbol":"scalar","debCrdCurrencyDesc":"scalar","currencyForDisplay":"scalar","trnCurrencyIsoCode":"scalar","transOriginalCurrencyCode":"scalar","trnCurrencySymbol":"scalar","transOriginalSumCurrency":"scalar","srcCurrencyCode":"scalar","crmIccCurrencyDesc":"scalar","transactionTypeCode":"scalar","trnTypeCode":"scalar","trnType":"scalar","refundInd":"scalar","numOfPayments":"scalar","numberOfPayments":"scalar","curPaymentNum":"scalar","transCardPresentInd":"scalar","walletTranInd":"scalar","tokenInd":"scalar","isAbroadApproval":"scalar","isAbroadTransaction":"scalar","trnExacWay":"scalar","walletProviderCode":"scalar","walletProviderDesc":"scalar","posEntryMod":"scalar","forcedDebRate":"scalar","cashAccountAmt":"scalar","cashAccountCurrency":"scalar","cashAccountTrnAmt":"scalar","cashAccountCardAmt":"scalar","cashAccountCardCurr":"scalar","discountAmount":"scalar","discountReason":"scalar","roundingAmount":"scalar","roundingReason":"scalar","onGoingTransactionsComment":"scalar","paymentsMadeComment":"scalar","chargeExternalToCardComment":"scalar","transIndication":"scalar","transSafeIndication":"scalar","earlyPaymentInd":"scalar","isImmediate":"scalar","isInterestTransaction":"scalar","comments":[{"key":"scalar","value":"scalar"},"set"],"linkedComments":[{"text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar"},"set"],"immediateComments":[{"comment":"scalar"},"set"],"transTypeCommentDetails":["scalar","set"],"paymentsMade":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]},"set"],"retained":{"comments":[{"key":"scalar","value":"scalar","text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar","comment":"scalar"},"set"],"paymentHistory":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]}},"isracard":{"identity":{"baseKey":"scalar","occurrenceCount":"scalar"},"observations":[{"generation":"scalar","path":"scalar"}],"monetaryEvidence":{"billingMinor":"scalar","billingCurrency":"scalar","originalMinor":"scalar","originalCurrency":"scalar","convention":"scalar","statedTotals":[["scalar"]]},"billingMonth":"scalar","rows":["@isracard_row","set"],"detail":{"voucherNumber":"scalar","voucherNumberRatz":"scalar","purchaseDateOutboundIsracard":"scalar","purchaseTime":"scalar","address":"scalar","phoneNumber":"scalar","city":"scalar","supplierId":"scalar","supplierName":"scalar","supplierNameIsracard":"scalar","motavName":"scalar","transactionType":"scalar","walletPayName":"scalar","dealCode":"scalar","dealType":"scalar","numberOfPayments":"scalar","paymentNumber":"scalar","dealSum":"scalar","chargeSum":"scalar","chargeSumToDisplay":"scalar","dealSumOutbound":"scalar","dealSumOutboundInshekels":"scalar","currencyId":"scalar","currencyIdForCharge":"scalar","currencyIdOutbound":"scalar","linking":"scalar","discount":"scalar","sumBeforeDiscount":"scalar","saleName":"scalar","secondSaleName":"scalar","moreInfo":"scalar","sector":"scalar","moedChiuvFull":"scalar","valueDate":"scalar","conversionCurrency":"scalar","conversionDateZMD":"scalar","dateConversion":"scalar","dateConversionOutBound":"scalar","dollarConversion":"scalar","dollarTransferRate":"scalar","exchangeRateZMD":"scalar","commissionDiscountPercentage":"scalar","commissionDiscountSum":"scalar","commissionNetValue":"scalar","commissionNetValueCurrency":"scalar","interestPercentage":"scalar","interestSum":"scalar","moneyWithdrawalCommission":"scalar","dollarTransferCommissionPercentage":"scalar","amlaDolarCa":"scalar","amlaDolarCaMatbea":"scalar","scumAmla":"scalar","sumDollar":"scalar","sumOfCompensation":"scalar","sumOfFund":"scalar","sumOfValueAddedTax":"scalar","Table1":[{"paymentNumber":"scalar","paymentDate":"scalar","paymentSum":"scalar","currencyId":"scalar"}]}}}'),
  ('digital','{"seqVoucherNumber":"scalar","voucherNumber":"scalar","purchaseDate":"scalar","purchaseTime":"scalar","billingAmount":"scalar","billingAmountCurrency":"scalar","billingAmountCurrencySymbol":"scalar","originalAmount":"scalar","originalCurrency":"scalar","originalCurrencyIso":"scalar","discountAmount":"scalar","discountIndication":"scalar","discountClubName":"scalar","ilsAmount":"scalar","usdAmount":"scalar","businessName":"scalar","businessNumber":"scalar","cityDescription":"scalar","countryCode":"scalar","countryDescription":"scalar","transactionCode":"scalar","transactionDescription":"scalar","tranzacCodeType":"scalar","tranzacCodeDescription":"scalar","clearedCode":"scalar","clearedDescription":"scalar","isIsraelDeal":"scalar","currentInstallmentNum":"scalar","numberOfInstallment":"scalar","isLastInstallment":"scalar","moreInfo":"scalar","presentCard":"scalar","isTransactionSecure":"scalar","isWalletTransaction":"scalar","isdirectDebit":"scalar","isNewDirectDebit":"scalar"}'),
  ('legacy','{"voucherNumber":"scalar","voucherNumberRatz":"scalar","voucherNumberRatzOutbound":"scalar","fullPurchaseDate":"scalar","fullPurchaseDateOutbound":"scalar","fullPaymentDate":"scalar","purchaseDate":"scalar","purchaseDateOutbound":"scalar","paymentDate":"scalar","paymentSum":"scalar","paymentSumOutbound":"scalar","paymentSumSign":"scalar","dealSum":"scalar","dealSumOutbound":"scalar","dealSumType":"scalar","currencyId":"scalar","currentPaymentCurrency":"scalar","kodMatbeaMekori":"scalar","fullSupplierNameHeb":"scalar","fullSupplierNameOutbound":"scalar","supplierId":"scalar","supplierName":"scalar","supplierNameOutbound":"scalar","city":"scalar","moreInfo":"scalar","isHoraatKeva":"scalar","horaatKeva":"scalar"}'),
  ('approval','{"confirmationLocation":"scalar","seqConfirmationNumber":"scalar","confirmationTimeStamp":"scalar","confirmationNumber":"scalar","businessName":"scalar","purchaseDate":"scalar","originalAmount":"scalar","originalCurrency":"scalar","currencyIso":"scalar","currencySimbol":"scalar","ilsBillingAmount":"scalar","israelTransactionTime":"scalar","transactionCode":"scalar","transactionDescription":"scalar","tranzacCodeType":"scalar","isTransactionSecure":"scalar","isWalletTransaction":"scalar","branchCodeDescription":"scalar"}'),
  ('identity','{"cal":{"baseKey":"scalar","occurrenceCount":"scalar"},"isracard":{"baseKey":"scalar","occurrenceCount":"scalar"}}'),
  ('observations','{"isracard":[{"generation":"scalar","path":"scalar"}]}'),
  ('monetaryEvidence','{"isracard":{"billingMinor":"scalar","billingCurrency":"scalar","originalMinor":"scalar","originalCurrency":"scalar","convention":"scalar","statedTotals":[["scalar"]]}}'),
  ('billingMonth','{"isracard":"scalar"}'),
  ('currencyMapping','{"cal":"scalar"}');
CREATE TABLE _fonds_evidence_inputs (
  id INTEGER PRIMARY KEY, target TEXT NOT NULL, row_id TEXT NOT NULL,
  document TEXT NOT NULL, shape TEXT NOT NULL
);
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'source',id,provider_json,(SELECT shape FROM _fonds_evidence_shapes WHERE name='source') FROM transactions;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'posting',transaction_id,json_extract(posting_link_json,'$.pending.details.provider'),
    (SELECT shape FROM _fonds_evidence_shapes WHERE name='combined')
  FROM transaction_posting_links WHERE posting_link_json IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'provider_identity_json',transaction_id,provider_identity_json,(SELECT shape FROM _fonds_evidence_shapes WHERE name='identity')
  FROM transaction_reconciliation WHERE provider_identity_json IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'provider_observations_json',transaction_id,provider_observations_json,(SELECT shape FROM _fonds_evidence_shapes WHERE name='observations')
  FROM transaction_reconciliation WHERE provider_observations_json IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'provider_monetary_evidence_json',transaction_id,provider_monetary_evidence_json,(SELECT shape FROM _fonds_evidence_shapes WHERE name='monetaryEvidence')
  FROM transaction_reconciliation WHERE provider_monetary_evidence_json IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'provider_billing_month_json',transaction_id,provider_billing_month_json,(SELECT shape FROM _fonds_evidence_shapes WHERE name='billingMonth')
  FROM transaction_reconciliation WHERE provider_billing_month_json IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'provider_currency_mapping_json',transaction_id,provider_currency_mapping_json,(SELECT shape FROM _fonds_evidence_shapes WHERE name='currencyMapping')
  FROM transaction_reconciliation WHERE provider_currency_mapping_json IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'additional_information',id,additional_information_json,'["scalar","set"]'
  FROM transactions WHERE additional_information_json IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'posting_additional_information',transaction_id,
    json_extract(posting_link_json,'$.pending.details.additionalInformation'),'["scalar","set"]'
  FROM transaction_posting_links
  WHERE json_type(posting_link_json,'$.pending.details.additionalInformation') IS NOT NULL;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'source_issues',id,source_issues_json,'["scalar","set"]' FROM transactions;
INSERT INTO _fonds_evidence_inputs(target,row_id,document,shape)
  SELECT 'posting_source_issues',transaction_id,
    json_extract(posting_link_json,'$.pending.details.issues'),'["scalar","set"]'
  FROM transaction_posting_links WHERE posting_link_json IS NOT NULL;
-- Pair saved row copies to source rows before dropping the copies. Upstream row
-- properties never supply an origin; only Fonds-created observation wrappers do.
CREATE TABLE _fonds_isracard_rows AS
  SELECT i.id AS input_id,c.key AS row_index,c.json -> c.fullkey AS document
  FROM _fonds_evidence_inputs i JOIN json_each(i.document,'$.isracard.rows') c
  WHERE i.target IN ('source','posting') AND json_type(i.document,'$.isracard.rows')='array';
CREATE TABLE _fonds_isracard_origins AS
  SELECT i.id AS input_id,o.key AS wrapper_index,json_extract(o.json -> o.fullkey,'$.generation') AS generation,
    (o.json -> o.fullkey) -> '$.row' AS document
  FROM _fonds_evidence_inputs i JOIN transactions t ON i.target='source' AND i.row_id=t.id
    JOIN json_each(t.details_json,'$.provider.isracard.observations') o
  WHERE json_type(t.details_json,'$.provider.isracard.observations')='array' AND
    json_extract(o.json -> o.fullkey,'$.generation') IN ('digital','legacy') AND json_type(o.json -> o.fullkey,'$.row')='object'
  UNION ALL
  SELECT i.id,o.key,json_extract(o.json -> o.fullkey,'$.generation'),(o.json -> o.fullkey) -> '$.row'
  FROM _fonds_evidence_inputs i JOIN transaction_posting_links t ON i.target='posting' AND i.row_id=t.transaction_id
    JOIN json_each(t.posting_link_json,'$.pending.details.provider.isracard.observations') o
  WHERE json_type(t.posting_link_json,'$.pending.details.provider.isracard.observations')='array' AND
    json_extract(o.json -> o.fullkey,'$.generation') IN ('digital','legacy') AND json_type(o.json -> o.fullkey,'$.row')='object';
CREATE TABLE _fonds_isracard_row_nodes AS
  SELECT r.input_id,r.row_index,n.fullkey,n.type,
    CASE WHEN n.type IN ('object','array') THEN NULL ELSE n.json -> n.fullkey END AS atom
  FROM _fonds_isracard_rows r JOIN json_tree(r.document) n;
CREATE TABLE _fonds_isracard_origin_nodes AS
  SELECT r.input_id,r.wrapper_index,n.fullkey,n.type,
    CASE WHEN n.type IN ('object','array') THEN NULL ELSE n.json -> n.fullkey END AS atom
  FROM _fonds_isracard_origins r JOIN json_tree(r.document) n;
CREATE INDEX _fonds_isracard_row_node_keys ON _fonds_isracard_row_nodes(input_id,row_index);
CREATE INDEX _fonds_isracard_origin_node_keys ON _fonds_isracard_origin_nodes(input_id,wrapper_index);
CREATE TABLE _fonds_isracard_pairs AS
SELECT r.input_id,r.row_index,(SELECT generation FROM (
  SELECT o.generation,row_number() OVER (ORDER BY o.generation COLLATE BINARY,o.wrapper_index) AS occurrence
  FROM _fonds_isracard_origins o WHERE o.input_id=r.input_id AND
      NOT EXISTS (SELECT fullkey,type,atom FROM _fonds_isracard_origin_nodes WHERE input_id=o.input_id AND wrapper_index=o.wrapper_index EXCEPT SELECT fullkey,type,atom FROM _fonds_isracard_row_nodes WHERE input_id=r.input_id AND row_index=r.row_index)
      AND NOT EXISTS (SELECT fullkey,type,atom FROM _fonds_isracard_row_nodes WHERE input_id=r.input_id AND row_index=r.row_index EXCEPT SELECT fullkey,type,atom FROM _fonds_isracard_origin_nodes WHERE input_id=o.input_id AND wrapper_index=o.wrapper_index)
) WHERE occurrence=(SELECT count(*) FROM _fonds_isracard_rows e
  WHERE e.input_id=r.input_id AND e.row_index<=r.row_index AND
      NOT EXISTS (SELECT fullkey,type,atom FROM _fonds_isracard_row_nodes WHERE input_id=e.input_id AND row_index=e.row_index EXCEPT SELECT fullkey,type,atom FROM _fonds_isracard_row_nodes WHERE input_id=r.input_id AND row_index=r.row_index)
      AND NOT EXISTS (SELECT fullkey,type,atom FROM _fonds_isracard_row_nodes WHERE input_id=r.input_id AND row_index=r.row_index EXCEPT SELECT fullkey,type,atom FROM _fonds_isracard_row_nodes WHERE input_id=e.input_id AND row_index=e.row_index))) AS generation
FROM _fonds_isracard_rows r;
UPDATE _fonds_evidence_inputs SET document=json_set(document,'$.isracard.rows',json((
  SELECT json_group_array(json(value)) FROM (
    SELECT json_object('row',json(r.document),'generation',p.generation) AS value
    FROM _fonds_isracard_rows r JOIN _fonds_isracard_pairs p
      ON p.input_id=r.input_id AND p.row_index=r.row_index
    WHERE r.input_id=_fonds_evidence_inputs.id ORDER BY r.row_index))))
  WHERE target IN ('source','posting') AND json_type(document,'$.isracard.rows')='array';
CREATE TABLE _fonds_evidence_nodes AS
WITH RECURSIVE nodes(input_id,path,parent,key,depth,document,shape) AS (
  SELECT id,'$',NULL,NULL,0,document,shape FROM _fonds_evidence_inputs
  UNION ALL
  SELECT n.input_id,n.path||substr(c.fullkey,2),n.path,c.key,n.depth+1,
    CASE WHEN s.type='text' AND s.value='@isracard_row' THEN
      (c.json -> c.fullkey) -> '$.row' ELSE c.json -> c.fullkey END,
    CASE WHEN s.type='text' AND s.value='@isracard_row' THEN
      (SELECT shape FROM _fonds_evidence_shapes WHERE name=CASE
        WHEN json_extract(c.json -> c.fullkey,'$.generation') IN ('digital','legacy')
          THEN json_extract(c.json -> c.fullkey,'$.generation') WHEN
        json_type((c.json -> c.fullkey) -> '$.row','$.voucherNumberRatz') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.voucherNumberRatzOutbound') IS NOT NULL THEN 'legacy' WHEN
        json_type((c.json -> c.fullkey) -> '$.row','$.seqVoucherNumber') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.billingAmount') IS NOT NULL THEN 'digital' WHEN
        json_type((c.json -> c.fullkey) -> '$.row','$.confirmationLocation') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.seqConfirmationNumber') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.confirmationTimeStamp') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.confirmationNumber') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.currencyIso') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.currencySimbol') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.israelTransactionTime') IS NOT NULL
        THEN 'approval' WHEN
        json_type((c.json -> c.fullkey) -> '$.row','$.seqVoucherNumber') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.billingAmount') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.businessName') IS NOT NULL OR
        json_type((c.json -> c.fullkey) -> '$.row','$.transactionCode') IS NOT NULL
        THEN 'digital' ELSE 'legacy' END)
      ELSE s.json -> s.fullkey END
  FROM nodes n JOIN json_each(n.document) c JOIN json_each(n.shape) s ON
    (json_type(n.document)='object' AND json_type(n.shape)='object' AND s.key=c.key) OR
    (json_type(n.document)='array' AND json_type(n.shape)='array' AND s.key=0)
)
SELECT *,row_number() OVER (PARTITION BY input_id ORDER BY depth DESC,path DESC) AS step
FROM nodes;
CREATE INDEX _fonds_evidence_node_steps ON _fonds_evidence_nodes(input_id,step);
CREATE INDEX _fonds_evidence_node_parents ON _fonds_evidence_nodes(input_id,parent);
-- Children are projected before their parent is rebuilt, retaining only declared keys.
CREATE TABLE _fonds_evidence_results AS
WITH RECURSIVE projected(input_id,step,document) AS (
  SELECT id,0,document FROM _fonds_evidence_inputs
  UNION ALL
  SELECT r.input_id,r.step+1,json_set(r.document,n.path,json(CASE json_type(n.document)
    WHEN 'object' THEN (SELECT json_group_object(key,json(value)) FROM (
      SELECT c.key,r.document -> c.path AS value
      FROM _fonds_evidence_nodes c WHERE c.input_id=n.input_id AND c.parent=n.path
      ORDER BY c.key COLLATE BINARY))
    WHEN 'array' THEN (SELECT json_group_array(json(projected)) FROM (SELECT * FROM (
      SELECT c.key,r.document -> c.path AS projected,json_extract(n.shape,'$[1]') AS ordering
      FROM _fonds_evidence_nodes c WHERE c.input_id=n.input_id AND c.parent=n.path
      ) ORDER BY CASE WHEN ordering='set' THEN
-- Match JavaScript UTF-16 ordering, including astral characters and BMP text.
(WITH RECURSIVE units(position, encoded) AS (
  VALUES (1, '')
  UNION ALL
  SELECT position + 1, encoded || CASE
    WHEN unicode(substr(projected,position,1)) > 65535 THEN
      printf('%04x%04x',55296+(unicode(substr(projected,position,1))-65536)/1024,
        56320+(unicode(substr(projected,position,1))-65536)%1024)
    ELSE printf('%04x',unicode(substr(projected,position,1))) END
  FROM units WHERE position <= length(projected)
) SELECT encoded FROM units ORDER BY position DESC LIMIT 1)
        ELSE '' END,cast(key AS INTEGER)))
    ELSE n.document END))
  FROM projected r JOIN _fonds_evidence_nodes n ON n.input_id=r.input_id AND n.step=r.step+1
)
SELECT r.input_id,r.document FROM projected r
WHERE NOT EXISTS (SELECT 1 FROM _fonds_evidence_nodes n WHERE n.input_id=r.input_id AND n.step=r.step+1);
-- Issue codes are a set; keep their canonical order while removing repeated strings.
UPDATE _fonds_evidence_results SET document=(SELECT json_group_array(json(raw)) FROM (
  SELECT j.json -> j.fullkey AS raw,min(cast(j.key AS INTEGER)) AS position
  FROM json_each(document) j GROUP BY j.json -> j.fullkey ORDER BY position))
  WHERE input_id IN (SELECT id FROM _fonds_evidence_inputs WHERE target IN ('source_issues','posting_source_issues'));
UPDATE transactions SET provider_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id WHERE i.target='source' AND i.row_id=transactions.id);
UPDATE transaction_posting_links SET posting_link_json=json_set(posting_link_json,'$.pending.details.provider',json((
  SELECT r.document FROM _fonds_evidence_results r JOIN _fonds_evidence_inputs i ON i.id=r.input_id
  WHERE i.target='posting' AND i.row_id=transaction_posting_links.transaction_id))) WHERE posting_link_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_identity_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id WHERE i.target='provider_identity_json' AND i.row_id=transaction_reconciliation.transaction_id) WHERE provider_identity_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_observations_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id WHERE i.target='provider_observations_json' AND i.row_id=transaction_reconciliation.transaction_id) WHERE provider_observations_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_monetary_evidence_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id WHERE i.target='provider_monetary_evidence_json' AND i.row_id=transaction_reconciliation.transaction_id) WHERE provider_monetary_evidence_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_billing_month_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id WHERE i.target='provider_billing_month_json' AND i.row_id=transaction_reconciliation.transaction_id) WHERE provider_billing_month_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_currency_mapping_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id WHERE i.target='provider_currency_mapping_json' AND i.row_id=transaction_reconciliation.transaction_id) WHERE provider_currency_mapping_json IS NOT NULL;
UPDATE transactions SET additional_information_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id
  WHERE i.target='additional_information' AND i.row_id=transactions.id) WHERE additional_information_json IS NOT NULL;
UPDATE transaction_posting_links SET posting_link_json=json_set(posting_link_json,'$.pending.details.additionalInformation',json((
  SELECT r.document FROM _fonds_evidence_results r JOIN _fonds_evidence_inputs i ON i.id=r.input_id
  WHERE i.target='posting_additional_information' AND i.row_id=transaction_posting_links.transaction_id)))
  WHERE json_type(posting_link_json,'$.pending.details.additionalInformation') IS NOT NULL;
UPDATE transactions SET source_issues_json=(SELECT r.document FROM _fonds_evidence_results r
  JOIN _fonds_evidence_inputs i ON i.id=r.input_id WHERE i.target='source_issues' AND i.row_id=transactions.id);
UPDATE transaction_posting_links SET posting_link_json=json_set(posting_link_json,'$.pending.details.issues',json((
  SELECT r.document FROM _fonds_evidence_results r JOIN _fonds_evidence_inputs i ON i.id=r.input_id
  WHERE i.target='posting_source_issues' AND i.row_id=transaction_posting_links.transaction_id)))
  WHERE posting_link_json IS NOT NULL;
-- No explanatory strings and an absent explanation both mean no additional information.
UPDATE transactions SET additional_information_json=NULL
  WHERE json_type(additional_information_json)='array' AND json_array_length(additional_information_json)=0;
UPDATE transaction_posting_links SET posting_link_json=json_remove(posting_link_json,'$.pending.details.additionalInformation')
  WHERE json_type(posting_link_json,'$.pending.details.additionalInformation')='array'
    AND json_array_length(posting_link_json,'$.pending.details.additionalInformation')=0;
DROP TABLE _fonds_isracard_pairs;
DROP TABLE _fonds_isracard_origin_nodes;
DROP TABLE _fonds_isracard_row_nodes;
DROP TABLE _fonds_isracard_origins;
DROP TABLE _fonds_isracard_rows;
DROP TABLE _fonds_evidence_results;
DROP TABLE _fonds_evidence_nodes;
DROP TABLE _fonds_evidence_inputs;
DROP TABLE _fonds_evidence_shapes;
ALTER TABLE transactions DROP COLUMN details_json;
ALTER TABLE transactions DROP COLUMN last_seen_at;
ALTER TABLE transactions DROP COLUMN last_seen_run_id;
ALTER TABLE refreshes ADD COLUMN observed INTEGER NOT NULL DEFAULT 0 CHECK (observed BETWEEN 0 AND 9007199254740991);
ALTER TABLE refreshes ADD COLUMN unchanged_transactions INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_transactions BETWEEN 0 AND 9007199254740991);
ALTER TABLE refreshes ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0 CHECK (unlisted BETWEEN 0 AND 9007199254740991);
ALTER TABLE sync_runs ADD COLUMN evidence_digest TEXT;
CREATE TABLE sync_run_bodies (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES sync_runs(id),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  retention TEXT NOT NULL CHECK (retention IN ('legacy','staged','debug')),
  expires_at TEXT,
  CHECK ((retention = 'debug' AND expires_at IS NOT NULL) OR retention = 'staged' OR (retention = 'legacy' AND expires_at IS NULL))
) STRICT;
INSERT INTO sync_run_bodies SELECT id,snapshot_json,'legacy',NULL FROM sync_runs;
ALTER TABLE sync_runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));
UPDATE sync_runs SET metadata_json = json_object('schemaVersion',1,'responses',json(coalesce((SELECT json_group_array(json_remove(value,'$.responseText')) FROM json_each(snapshot_json,'$.responses')),'[]')),'failures',json(coalesce(json_extract(snapshot_json,'$.failures'),'[]')));
ALTER TABLE sync_runs DROP COLUMN snapshot_json;
CREATE TABLE deferred_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  source_scope TEXT NOT NULL,
  source_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  first_seen_run_id TEXT NOT NULL REFERENCES sync_runs(id),
  last_seen_run_id TEXT NOT NULL REFERENCES sync_runs(id)
) STRICT;
ALTER TABLE refreshes ADD COLUMN provider_stop_reason TEXT CHECK (provider_stop_reason IN ('authentication_failed','authentication_challenge','rate_limited','budget_exhausted'));
ALTER TABLE refresh_windows ADD COLUMN has_accepted_evidence INTEGER NOT NULL DEFAULT 0 CHECK (has_accepted_evidence IN (0,1));
ALTER TABLE refreshes ADD COLUMN has_accepted_evidence INTEGER NOT NULL DEFAULT 0 CHECK (has_accepted_evidence IN (0,1));
