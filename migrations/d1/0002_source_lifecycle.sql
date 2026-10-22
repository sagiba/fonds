ALTER TABLE transaction_reconciliation
  ADD COLUMN posting_overlap_json TEXT CHECK (posting_overlap_json IS NULL OR json_valid(posting_overlap_json));
ALTER TABLE transactions ADD COLUMN source_absence_json TEXT;
ALTER TABLE transaction_reconciliation
  ADD COLUMN source_evidence_json TEXT CHECK (source_evidence_json IS NULL OR json_valid(source_evidence_json));
