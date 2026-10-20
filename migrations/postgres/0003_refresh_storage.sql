-- PostgreSQL JSON traversal rejects NUL and unpaired surrogate escapes.
-- Use a document-absent token while traversing, then restore each exact escape.
DO $$
DECLARE marker text;
BEGIN
  LOOP
    marker := 'fonds_nul_' || gen_random_uuid()::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM transactions WHERE strpos(details_json, marker) > 0)
      AND NOT EXISTS (SELECT 1 FROM sync_runs WHERE strpos(metadata_json, marker) > 0);
  END LOOP;
  PERFORM set_config('fonds.migration_nul_marker', marker, true);
END $$;
CREATE FUNCTION pg_temp.fonds_json_safe(document text) RETURNS json
LANGUAGE sql AS $function$
  SELECT regexp_replace(document, '(?<!\\)((\\\\)*)\\(u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2}))',
    chr(92)||'1' || current_setting('fonds.migration_nul_marker') || chr(92)||'3', 'g')::json
$function$;
CREATE FUNCTION pg_temp.fonds_json_restore(document text) RETURNS text
LANGUAGE sql AS $function$
  SELECT regexp_replace(document,current_setting('fonds.migration_nul_marker') ||
    '(u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2}))',repeat(chr(92),3)||'1','g')
$function$;
ALTER TABLE transactions ADD COLUMN transaction_date_time TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN merchant_address_line TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN merchant_phone TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN merchant_city TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN merchant_country_code TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN additional_information_json TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN currency_exchange_json TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN source_issues_json TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN provider_json TEXT COLLATE "C";
UPDATE transactions SET
  transaction_date_time = (pg_temp.fonds_json_safe(details_json) #> '{transactionDateTime}') #>> '{}',
  merchant_address_line = CASE WHEN strpos(pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{merchant,address}')::text), chr(92)) > 0 THEN chr(92)||'j'||pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{merchant,address}')::text) ELSE (pg_temp.fonds_json_safe(details_json) #> '{merchant,address}') #>> '{}' END,
  merchant_phone = CASE WHEN strpos(pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{merchant,phone}')::text), chr(92)) > 0 THEN chr(92)||'j'||pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{merchant,phone}')::text) ELSE (pg_temp.fonds_json_safe(details_json) #> '{merchant,phone}') #>> '{}' END,
  merchant_city = CASE WHEN strpos(pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{merchant,city}')::text), chr(92)) > 0 THEN chr(92)||'j'||pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{merchant,city}')::text) ELSE (pg_temp.fonds_json_safe(details_json) #> '{merchant,city}') #>> '{}' END,
  merchant_country_code = (pg_temp.fonds_json_safe(details_json) #> '{merchant,countryCode}') #>> '{}',
  additional_information_json = pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{additionalInformation}')::text),
  currency_exchange_json = pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{currencyExchange}')::text),
  source_issues_json = pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{issues}')::text),
  provider_json = pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{provider}')::text);
ALTER TABLE transactions ALTER COLUMN source_issues_json SET NOT NULL;
ALTER TABLE transactions ALTER COLUMN provider_json SET NOT NULL;
CREATE TABLE transaction_observations (
  transaction_id TEXT COLLATE "C" PRIMARY KEY NOT NULL REFERENCES transactions(id),
  last_seen_at TEXT COLLATE "C" NOT NULL,
  last_seen_run_id TEXT COLLATE "C" NOT NULL REFERENCES sync_runs(id),
  source_refs_json TEXT COLLATE "C" NOT NULL
);
INSERT INTO transaction_observations SELECT id,last_seen_at,last_seen_run_id,pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{sourceRefs}')::text) FROM transactions;
CREATE TABLE transaction_reconciliation (
  transaction_id TEXT COLLATE "C" PRIMARY KEY NOT NULL REFERENCES transactions(id),
  payment_context_conflicts_json TEXT COLLATE "C",
  pending_posting_candidates_json TEXT COLLATE "C",
  rejected_posting_keys_json TEXT COLLATE "C",
  provider_identity_json TEXT COLLATE "C",
  provider_observations_json TEXT COLLATE "C",
  provider_monetary_evidence_json TEXT COLLATE "C",
  provider_billing_month_json TEXT COLLATE "C",
  provider_currency_mapping_json TEXT COLLATE "C"
);
INSERT INTO transaction_reconciliation SELECT id,pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{paymentContextConflicts}')::text),pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{pendingPostingCandidates}')::text),pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{rejectedPostingKeys}')::text),pg_temp.fonds_json_restore((SELECT json_object_agg(key,value->'identity')::text FROM json_each(pg_temp.fonds_json_safe(details_json)->'provider') WHERE value->'identity' IS NOT NULL)),pg_temp.fonds_json_restore((SELECT json_object_agg(key,value->'observations')::text FROM json_each(pg_temp.fonds_json_safe(details_json)->'provider') WHERE value->'observations' IS NOT NULL)),pg_temp.fonds_json_restore((SELECT json_object_agg(key,value->'monetaryEvidence')::text FROM json_each(pg_temp.fonds_json_safe(details_json)->'provider') WHERE value->'monetaryEvidence' IS NOT NULL)),pg_temp.fonds_json_restore((SELECT json_object_agg(key,value->'billingMonth')::text FROM json_each(pg_temp.fonds_json_safe(details_json)->'provider') WHERE value->'billingMonth' IS NOT NULL)),pg_temp.fonds_json_restore((SELECT json_object_agg(key,value->'currencyMapping')::text FROM json_each(pg_temp.fonds_json_safe(details_json)->'provider') WHERE value->'currencyMapping' IS NOT NULL)) FROM transactions;
CREATE TABLE transaction_posting_links (
  transaction_id TEXT COLLATE "C" PRIMARY KEY NOT NULL REFERENCES transactions(id),
  posting_link_json TEXT COLLATE "C"
);
INSERT INTO transaction_posting_links SELECT id,pg_temp.fonds_json_restore((pg_temp.fonds_json_safe(details_json) #> '{postingLink}')::text) FROM transactions;
UPDATE transactions SET provider_json = pg_temp.fonds_json_restore((SELECT coalesce(json_object_agg(p.key,(SELECT coalesce(json_object_agg(e.key,e.value),'{}'::json) FROM json_each(p.value) e WHERE e.key NOT IN ('identity','observations','monetaryEvidence','billingMonth','currencyMapping'))),'{}'::json)::text FROM json_each(pg_temp.fonds_json_safe(provider_json)) p));
-- Frozen provider declarations at migration 3; later adapters do not rewrite history.
CREATE TEMP TABLE _fonds_evidence_shapes (name text PRIMARY KEY, shape json NOT NULL);
INSERT INTO _fonds_evidence_shapes VALUES
  ('source','{"cal":{"rows":[{"cardUniqueID":"scalar","cardUniqueId":"scalar","transactionID":"scalar","trnIntId":"scalar","trnPurchaseDate":"scalar","debCrdDate":"scalar","merchantName":"scalar","merchantId":"scalar","internationalBranchID":"scalar","internationalBranchDesc":"scalar","merchantAddress":"scalar","merchantPhoneNo":"scalar","amountForDisplay":"scalar","amtBeforeConvAndIndex":"scalar","trnAmt":"scalar","debCrdCurrencyCode":"scalar","debCrdCurrencySymbol":"scalar","debCrdCurrencyDesc":"scalar","currencyForDisplay":"scalar","trnCurrencyIsoCode":"scalar","transOriginalCurrencyCode":"scalar","trnCurrencySymbol":"scalar","transOriginalSumCurrency":"scalar","srcCurrencyCode":"scalar","crmIccCurrencyDesc":"scalar","transactionTypeCode":"scalar","trnTypeCode":"scalar","trnType":"scalar","refundInd":"scalar","numOfPayments":"scalar","numberOfPayments":"scalar","curPaymentNum":"scalar","transCardPresentInd":"scalar","walletTranInd":"scalar","tokenInd":"scalar","isAbroadApproval":"scalar","isAbroadTransaction":"scalar","trnExacWay":"scalar","walletProviderCode":"scalar","walletProviderDesc":"scalar","posEntryMod":"scalar","forcedDebRate":"scalar","cashAccountAmt":"scalar","cashAccountCurrency":"scalar","cashAccountTrnAmt":"scalar","cashAccountCardAmt":"scalar","cashAccountCardCurr":"scalar","discountAmount":"scalar","discountReason":"scalar","roundingAmount":"scalar","roundingReason":"scalar","onGoingTransactionsComment":"scalar","paymentsMadeComment":"scalar","chargeExternalToCardComment":"scalar","transIndication":"scalar","transSafeIndication":"scalar","earlyPaymentInd":"scalar","isImmediate":"scalar","isInterestTransaction":"scalar","comments":[{"key":"scalar","value":"scalar"},"set"],"linkedComments":[{"text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar"},"set"],"immediateComments":[{"comment":"scalar"},"set"],"transTypeCommentDetails":["scalar","set"],"paymentsMade":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]},"set"],"retained":{"comments":[{"key":"scalar","value":"scalar","text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar","comment":"scalar"},"set"],"paymentHistory":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]}},"isracard":{"rows":["@isracard_row","set"],"detail":{"voucherNumber":"scalar","voucherNumberRatz":"scalar","purchaseDateOutboundIsracard":"scalar","purchaseTime":"scalar","address":"scalar","phoneNumber":"scalar","city":"scalar","supplierId":"scalar","supplierName":"scalar","supplierNameIsracard":"scalar","motavName":"scalar","transactionType":"scalar","walletPayName":"scalar","dealCode":"scalar","dealType":"scalar","numberOfPayments":"scalar","paymentNumber":"scalar","dealSum":"scalar","chargeSum":"scalar","chargeSumToDisplay":"scalar","dealSumOutbound":"scalar","dealSumOutboundInshekels":"scalar","currencyId":"scalar","currencyIdForCharge":"scalar","currencyIdOutbound":"scalar","linking":"scalar","discount":"scalar","sumBeforeDiscount":"scalar","saleName":"scalar","secondSaleName":"scalar","moreInfo":"scalar","sector":"scalar","moedChiuvFull":"scalar","valueDate":"scalar","conversionCurrency":"scalar","conversionDateZMD":"scalar","dateConversion":"scalar","dateConversionOutBound":"scalar","dollarConversion":"scalar","dollarTransferRate":"scalar","exchangeRateZMD":"scalar","commissionDiscountPercentage":"scalar","commissionDiscountSum":"scalar","commissionNetValue":"scalar","commissionNetValueCurrency":"scalar","interestPercentage":"scalar","interestSum":"scalar","moneyWithdrawalCommission":"scalar","dollarTransferCommissionPercentage":"scalar","amlaDolarCa":"scalar","amlaDolarCaMatbea":"scalar","scumAmla":"scalar","sumDollar":"scalar","sumOfCompensation":"scalar","sumOfFund":"scalar","sumOfValueAddedTax":"scalar","Table1":[{"paymentNumber":"scalar","paymentDate":"scalar","paymentSum":"scalar","currencyId":"scalar"}]}}}'::json),
  ('combined','{"cal":{"identity":{"baseKey":"scalar","occurrenceCount":"scalar"},"currencyMapping":"scalar","rows":[{"cardUniqueID":"scalar","cardUniqueId":"scalar","transactionID":"scalar","trnIntId":"scalar","trnPurchaseDate":"scalar","debCrdDate":"scalar","merchantName":"scalar","merchantId":"scalar","internationalBranchID":"scalar","internationalBranchDesc":"scalar","merchantAddress":"scalar","merchantPhoneNo":"scalar","amountForDisplay":"scalar","amtBeforeConvAndIndex":"scalar","trnAmt":"scalar","debCrdCurrencyCode":"scalar","debCrdCurrencySymbol":"scalar","debCrdCurrencyDesc":"scalar","currencyForDisplay":"scalar","trnCurrencyIsoCode":"scalar","transOriginalCurrencyCode":"scalar","trnCurrencySymbol":"scalar","transOriginalSumCurrency":"scalar","srcCurrencyCode":"scalar","crmIccCurrencyDesc":"scalar","transactionTypeCode":"scalar","trnTypeCode":"scalar","trnType":"scalar","refundInd":"scalar","numOfPayments":"scalar","numberOfPayments":"scalar","curPaymentNum":"scalar","transCardPresentInd":"scalar","walletTranInd":"scalar","tokenInd":"scalar","isAbroadApproval":"scalar","isAbroadTransaction":"scalar","trnExacWay":"scalar","walletProviderCode":"scalar","walletProviderDesc":"scalar","posEntryMod":"scalar","forcedDebRate":"scalar","cashAccountAmt":"scalar","cashAccountCurrency":"scalar","cashAccountTrnAmt":"scalar","cashAccountCardAmt":"scalar","cashAccountCardCurr":"scalar","discountAmount":"scalar","discountReason":"scalar","roundingAmount":"scalar","roundingReason":"scalar","onGoingTransactionsComment":"scalar","paymentsMadeComment":"scalar","chargeExternalToCardComment":"scalar","transIndication":"scalar","transSafeIndication":"scalar","earlyPaymentInd":"scalar","isImmediate":"scalar","isInterestTransaction":"scalar","comments":[{"key":"scalar","value":"scalar"},"set"],"linkedComments":[{"text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar"},"set"],"immediateComments":[{"comment":"scalar"},"set"],"transTypeCommentDetails":["scalar","set"],"paymentsMade":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]},"set"],"retained":{"comments":[{"key":"scalar","value":"scalar","text":"scalar","linkDisplayName":"scalar","linkType":"scalar","link":"scalar","comment":"scalar"},"set"],"paymentHistory":[{"date":"scalar","num":"scalar","amount":"scalar","currency":"scalar"},"set"]}},"isracard":{"identity":{"baseKey":"scalar","occurrenceCount":"scalar"},"observations":[{"generation":"scalar","path":"scalar"}],"monetaryEvidence":{"billingMinor":"scalar","billingCurrency":"scalar","originalMinor":"scalar","originalCurrency":"scalar","convention":"scalar","statedTotals":[["scalar"]]},"billingMonth":"scalar","rows":["@isracard_row","set"],"detail":{"voucherNumber":"scalar","voucherNumberRatz":"scalar","purchaseDateOutboundIsracard":"scalar","purchaseTime":"scalar","address":"scalar","phoneNumber":"scalar","city":"scalar","supplierId":"scalar","supplierName":"scalar","supplierNameIsracard":"scalar","motavName":"scalar","transactionType":"scalar","walletPayName":"scalar","dealCode":"scalar","dealType":"scalar","numberOfPayments":"scalar","paymentNumber":"scalar","dealSum":"scalar","chargeSum":"scalar","chargeSumToDisplay":"scalar","dealSumOutbound":"scalar","dealSumOutboundInshekels":"scalar","currencyId":"scalar","currencyIdForCharge":"scalar","currencyIdOutbound":"scalar","linking":"scalar","discount":"scalar","sumBeforeDiscount":"scalar","saleName":"scalar","secondSaleName":"scalar","moreInfo":"scalar","sector":"scalar","moedChiuvFull":"scalar","valueDate":"scalar","conversionCurrency":"scalar","conversionDateZMD":"scalar","dateConversion":"scalar","dateConversionOutBound":"scalar","dollarConversion":"scalar","dollarTransferRate":"scalar","exchangeRateZMD":"scalar","commissionDiscountPercentage":"scalar","commissionDiscountSum":"scalar","commissionNetValue":"scalar","commissionNetValueCurrency":"scalar","interestPercentage":"scalar","interestSum":"scalar","moneyWithdrawalCommission":"scalar","dollarTransferCommissionPercentage":"scalar","amlaDolarCa":"scalar","amlaDolarCaMatbea":"scalar","scumAmla":"scalar","sumDollar":"scalar","sumOfCompensation":"scalar","sumOfFund":"scalar","sumOfValueAddedTax":"scalar","Table1":[{"paymentNumber":"scalar","paymentDate":"scalar","paymentSum":"scalar","currencyId":"scalar"}]}}}'::json),
  ('digital','{"seqVoucherNumber":"scalar","voucherNumber":"scalar","purchaseDate":"scalar","purchaseTime":"scalar","billingAmount":"scalar","billingAmountCurrency":"scalar","billingAmountCurrencySymbol":"scalar","originalAmount":"scalar","originalCurrency":"scalar","originalCurrencyIso":"scalar","discountAmount":"scalar","discountIndication":"scalar","discountClubName":"scalar","ilsAmount":"scalar","usdAmount":"scalar","businessName":"scalar","businessNumber":"scalar","cityDescription":"scalar","countryCode":"scalar","countryDescription":"scalar","transactionCode":"scalar","transactionDescription":"scalar","tranzacCodeType":"scalar","tranzacCodeDescription":"scalar","clearedCode":"scalar","clearedDescription":"scalar","isIsraelDeal":"scalar","currentInstallmentNum":"scalar","numberOfInstallment":"scalar","isLastInstallment":"scalar","moreInfo":"scalar","presentCard":"scalar","isTransactionSecure":"scalar","isWalletTransaction":"scalar","isdirectDebit":"scalar","isNewDirectDebit":"scalar"}'::json),
  ('legacy','{"voucherNumber":"scalar","voucherNumberRatz":"scalar","voucherNumberRatzOutbound":"scalar","fullPurchaseDate":"scalar","fullPurchaseDateOutbound":"scalar","fullPaymentDate":"scalar","purchaseDate":"scalar","purchaseDateOutbound":"scalar","paymentDate":"scalar","paymentSum":"scalar","paymentSumOutbound":"scalar","paymentSumSign":"scalar","dealSum":"scalar","dealSumOutbound":"scalar","dealSumType":"scalar","currencyId":"scalar","currentPaymentCurrency":"scalar","kodMatbeaMekori":"scalar","fullSupplierNameHeb":"scalar","fullSupplierNameOutbound":"scalar","supplierId":"scalar","supplierName":"scalar","supplierNameOutbound":"scalar","city":"scalar","moreInfo":"scalar","isHoraatKeva":"scalar","horaatKeva":"scalar"}'::json),
  ('approval','{"confirmationLocation":"scalar","seqConfirmationNumber":"scalar","confirmationTimeStamp":"scalar","confirmationNumber":"scalar","businessName":"scalar","purchaseDate":"scalar","originalAmount":"scalar","originalCurrency":"scalar","currencyIso":"scalar","currencySimbol":"scalar","ilsBillingAmount":"scalar","israelTransactionTime":"scalar","transactionCode":"scalar","transactionDescription":"scalar","tranzacCodeType":"scalar","isTransactionSecure":"scalar","isWalletTransaction":"scalar","branchCodeDescription":"scalar"}'::json),
  ('identity','{"cal":{"baseKey":"scalar","occurrenceCount":"scalar"},"isracard":{"baseKey":"scalar","occurrenceCount":"scalar"}}'::json),
  ('observations','{"isracard":[{"generation":"scalar","path":"scalar"}]}'::json),
  ('monetaryEvidence','{"isracard":{"billingMinor":"scalar","billingCurrency":"scalar","originalMinor":"scalar","originalCurrency":"scalar","convention":"scalar","statedTotals":[["scalar"]]}}'::json),
  ('billingMonth','{"isracard":"scalar"}'::json),
  ('currencyMapping','{"cal":"scalar"}'::json);
-- Match JavaScript UTF-16 ordering, including astral characters and BMP text.
CREATE FUNCTION pg_temp.fonds_utf16_sort_key(document text) RETURNS text
LANGUAGE sql AS $function$
  SELECT coalesce(string_agg(CASE WHEN codepoint > 65535 THEN
    lpad(to_hex(55296+(codepoint-65536)/1024),4,'0') ||
    lpad(to_hex(56320+(codepoint-65536)%1024),4,'0')
    ELSE lpad(to_hex(codepoint),4,'0') END,'' ORDER BY position),'')
  FROM (SELECT position,ascii(substr(document,position,1)) AS codepoint
    FROM generate_series(1,length(document)) position) units
$function$;
CREATE FUNCTION pg_temp.fonds_project_evidence(document json, declaration json) RETURNS json
LANGUAGE plpgsql AS $function$
DECLARE projected text;
BEGIN
  IF json_typeof(declaration)='string' AND declaration #>> '{}'='@isracard_row' THEN
    SELECT shape INTO declaration FROM pg_temp._fonds_evidence_shapes WHERE name=CASE WHEN
      document->'confirmationLocation' IS NOT NULL OR
      document->'seqConfirmationNumber' IS NOT NULL OR
      document->'confirmationTimeStamp' IS NOT NULL OR
      document->'confirmationNumber' IS NOT NULL OR
      document->'currencyIso' IS NOT NULL OR
      document->'currencySimbol' IS NOT NULL OR
      document->'israelTransactionTime' IS NOT NULL
      THEN 'approval' WHEN
      document->'seqVoucherNumber' IS NOT NULL OR document->'billingAmount' IS NOT NULL OR
      document->'businessName' IS NOT NULL OR document->'transactionCode' IS NOT NULL
      THEN 'digital' ELSE 'legacy' END;
  END IF;
  CASE json_typeof(document)
  WHEN 'object' THEN
    IF json_typeof(declaration)<>'object' THEN RETURN '{}'::json; END IF;
    SELECT '{'||coalesce(string_agg(to_json(s.key)::text||':'||
      pg_temp.fonds_project_evidence(document->s.key,s.value)::text,',' ORDER BY s.key COLLATE "C"),'')||'}'
      INTO projected FROM json_each(declaration) s WHERE document->s.key IS NOT NULL;
    RETURN projected::json;
  WHEN 'array' THEN
    IF json_typeof(declaration)<>'array' THEN RETURN '[]'::json; END IF;
    SELECT '['||coalesce(string_agg(value::text,',' ORDER BY
      CASE WHEN declaration->>1='set' THEN
        pg_temp.fonds_utf16_sort_key(pg_temp.fonds_json_restore(value::text)) ELSE '' END,
      ordinal),'')||']' INTO projected
    FROM (SELECT ordinal,pg_temp.fonds_project_evidence(value,declaration->0) AS value
      FROM json_array_elements(document) WITH ORDINALITY source(value,ordinal)) children;
    RETURN projected::json;
  WHEN 'string' THEN RETURN to_json(document #>> '{}');
  ELSE RETURN document;
  END CASE;
END $function$;
CREATE FUNCTION pg_temp.fonds_set_json_path(document json, path text[], replacement json) RETURNS json
LANGUAGE sql AS $function$
  SELECT json_object_agg(key,CASE WHEN key=path[1] THEN
    CASE WHEN cardinality(path)=1 THEN replacement
      ELSE pg_temp.fonds_set_json_path(value,path[2:],replacement) END ELSE value END)
  FROM json_each(document)
$function$;
-- Issue codes are a set; keep their canonical order while removing repeated strings.
CREATE FUNCTION pg_temp.fonds_unique_strings(document json) RETURNS json
LANGUAGE sql AS $function$
  SELECT ('['||coalesce(string_agg(value,',' ORDER BY ordinal),'')||']')::json
  FROM (SELECT value::text AS value,min(ordinal) AS ordinal
    FROM json_array_elements(document) WITH ORDINALITY entries(value,ordinal)
    GROUP BY value::text) distinct_codes
$function$;
UPDATE transactions SET provider_json=pg_temp.fonds_json_restore(pg_temp.fonds_project_evidence(
  pg_temp.fonds_json_safe(provider_json),(SELECT shape FROM _fonds_evidence_shapes WHERE name='source'))::text);
UPDATE transaction_posting_links SET posting_link_json=pg_temp.fonds_json_restore(pg_temp.fonds_set_json_path(
  pg_temp.fonds_json_safe(posting_link_json),ARRAY['pending','details','provider'],
  pg_temp.fonds_project_evidence(pg_temp.fonds_json_safe(posting_link_json)#>'{pending,details,provider}',
    (SELECT shape FROM _fonds_evidence_shapes WHERE name='combined')))::text) WHERE posting_link_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_identity_json=pg_temp.fonds_json_restore(pg_temp.fonds_project_evidence(
  pg_temp.fonds_json_safe(provider_identity_json),(SELECT shape FROM _fonds_evidence_shapes WHERE name='identity'))::text) WHERE provider_identity_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_observations_json=pg_temp.fonds_json_restore(pg_temp.fonds_project_evidence(
  pg_temp.fonds_json_safe(provider_observations_json),(SELECT shape FROM _fonds_evidence_shapes WHERE name='observations'))::text) WHERE provider_observations_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_monetary_evidence_json=pg_temp.fonds_json_restore(pg_temp.fonds_project_evidence(
  pg_temp.fonds_json_safe(provider_monetary_evidence_json),(SELECT shape FROM _fonds_evidence_shapes WHERE name='monetaryEvidence'))::text) WHERE provider_monetary_evidence_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_billing_month_json=pg_temp.fonds_json_restore(pg_temp.fonds_project_evidence(
  pg_temp.fonds_json_safe(provider_billing_month_json),(SELECT shape FROM _fonds_evidence_shapes WHERE name='billingMonth'))::text) WHERE provider_billing_month_json IS NOT NULL;
UPDATE transaction_reconciliation SET provider_currency_mapping_json=pg_temp.fonds_json_restore(pg_temp.fonds_project_evidence(
  pg_temp.fonds_json_safe(provider_currency_mapping_json),(SELECT shape FROM _fonds_evidence_shapes WHERE name='currencyMapping'))::text) WHERE provider_currency_mapping_json IS NOT NULL;
UPDATE transactions SET additional_information_json=pg_temp.fonds_json_restore(pg_temp.fonds_project_evidence(
  pg_temp.fonds_json_safe(additional_information_json),'["scalar","set"]'::json)::text)
  WHERE additional_information_json IS NOT NULL;
UPDATE transaction_posting_links SET posting_link_json=pg_temp.fonds_json_restore(pg_temp.fonds_set_json_path(
  pg_temp.fonds_json_safe(posting_link_json),ARRAY['pending','details','additionalInformation'],
  pg_temp.fonds_project_evidence(pg_temp.fonds_json_safe(posting_link_json)#>'{pending,details,additionalInformation}',
    '["scalar","set"]'::json))::text)
  WHERE pg_temp.fonds_json_safe(posting_link_json)#>'{pending,details,additionalInformation}' IS NOT NULL;
UPDATE transactions SET source_issues_json=pg_temp.fonds_json_restore(pg_temp.fonds_unique_strings(
  pg_temp.fonds_project_evidence(pg_temp.fonds_json_safe(source_issues_json),'["scalar","set"]'::json))::text);
UPDATE transaction_posting_links SET posting_link_json=pg_temp.fonds_json_restore(pg_temp.fonds_set_json_path(
  pg_temp.fonds_json_safe(posting_link_json),ARRAY['pending','details','issues'],
  pg_temp.fonds_unique_strings(pg_temp.fonds_project_evidence(
    pg_temp.fonds_json_safe(posting_link_json)#>'{pending,details,issues}','["scalar","set"]'::json)))::text)
  WHERE posting_link_json IS NOT NULL;
DROP TABLE _fonds_evidence_shapes;
ALTER TABLE transactions DROP COLUMN details_json;
ALTER TABLE transactions DROP COLUMN last_seen_at;
ALTER TABLE transactions DROP COLUMN last_seen_run_id;
ALTER TABLE refreshes ADD COLUMN observed BIGINT NOT NULL DEFAULT 0 CHECK (observed BETWEEN 0 AND 9007199254740991);
ALTER TABLE refreshes ADD COLUMN unchanged_transactions BIGINT NOT NULL DEFAULT 0 CHECK (unchanged_transactions BETWEEN 0 AND 9007199254740991);
ALTER TABLE refreshes ADD COLUMN unlisted BIGINT NOT NULL DEFAULT 0 CHECK (unlisted BETWEEN 0 AND 9007199254740991);
ALTER TABLE sync_runs ADD COLUMN evidence_digest TEXT COLLATE "C";
CREATE TABLE sync_run_bodies (
  run_id TEXT COLLATE "C" PRIMARY KEY NOT NULL REFERENCES sync_runs(id),
  snapshot_json TEXT COLLATE "C" NOT NULL,
  retention TEXT COLLATE "C" NOT NULL CHECK (retention IN ('legacy','staged','debug')),
  expires_at TEXT COLLATE "C",
  CHECK ((retention = 'debug' AND expires_at IS NOT NULL) OR retention = 'staged' OR (retention = 'legacy' AND expires_at IS NULL))
);
INSERT INTO sync_run_bodies SELECT id,snapshot_json,'legacy',NULL FROM sync_runs;
UPDATE sync_runs SET metadata_json = pg_temp.fonds_json_restore((SELECT json_object_agg(key,value)::text FROM (SELECT 'schemaVersion'::text key,'1'::json value UNION ALL SELECT key,value FROM json_each(pg_temp.fonds_json_safe(metadata_json))) m));
ALTER TABLE sync_runs DROP COLUMN snapshot_json;
CREATE TABLE deferred_evidence (
  id TEXT COLLATE "C" PRIMARY KEY NOT NULL,
  connection_id TEXT COLLATE "C" NOT NULL REFERENCES connections(id),
  source_scope TEXT COLLATE "C" NOT NULL,
  source_key TEXT COLLATE "C" NOT NULL,
  reason TEXT COLLATE "C" NOT NULL,
  content_json TEXT COLLATE "C" NOT NULL,
  first_seen_run_id TEXT COLLATE "C" NOT NULL REFERENCES sync_runs(id),
  last_seen_run_id TEXT COLLATE "C" NOT NULL REFERENCES sync_runs(id)
);
