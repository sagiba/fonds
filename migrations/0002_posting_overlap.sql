ALTER TABLE transaction_reconciliation
  ADD COLUMN posting_overlap_json TEXT CHECK (posting_overlap_json IS NULL OR json_valid(posting_overlap_json));
