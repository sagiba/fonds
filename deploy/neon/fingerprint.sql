-- Read-only state fingerprint for comparing a restored Neon branch with its source.
-- Prints counts, the latest event and one content hash per table; never rows or amounts.
-- Usage: PGOPTIONS='-c default_transaction_read_only=on' psql "$URL" -X -q -f deploy/neon/fingerprint.sql
\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'
SELECT 'meta|' || current_setting('transaction_read_only') || '|' || pg_is_in_recovery();
SELECT 'txn_count|' || count(*) FROM financial.transactions;
SELECT 'txn_by_status_presence|' || coalesce(string_agg(status || '/' || presence || '=' || n, ',' ORDER BY status, presence), '') FROM (SELECT status, presence, count(*) n FROM financial.transactions GROUP BY 1,2) s;
SELECT 'annotations|' || count(*) FROM financial.annotations;
SELECT 'sync_runs|' || count(*) FROM financial.sync_runs;
SELECT 'latest_event|' || coalesce(max(id)::text, 'none') || '|' || coalesce(max(created_at), 'none') FROM financial.events;
SELECT 'latest_run|' || coalesce(max(started_at), 'none') || '|' || coalesce(max(applied_at), 'none') FROM financial.sync_runs;
SELECT 'totals_by_currency_basis_md5|' || md5(coalesce(string_agg(k, ';' ORDER BY k), '')) || '|groups=' || count(*) FROM (SELECT coalesce(currency,'-') || '/' || amount_basis || '/' || status || ':' || count(*) || ':' || coalesce(sum(amount_minor)::text,'-') AS k FROM financial.transactions GROUP BY currency, amount_basis, status) g;
SELECT format('SELECT %L || ''|'' || count(*) || ''|'' || md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM %I.%I t', 'table|' || schemaname || '.' || tablename, schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, tablename
\gexec
