ALTER TABLE transaction_reconciliation
  ADD COLUMN posting_overlap_json TEXT COLLATE "C";
ALTER TABLE transactions ADD COLUMN source_absence_json TEXT COLLATE "C";
ALTER TABLE transaction_reconciliation ADD COLUMN source_evidence_json TEXT COLLATE "C";
