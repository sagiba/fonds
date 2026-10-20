/** Inspect actual declarations, not just a self-asserted migration marker. */
export const schemaInspectionSql = `
SELECT kind,name,definition FROM (
 SELECT 'column' AS kind, c.relname||'.'||a.attnum::text AS name,
   a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull::text||'|'||
   coalesce(pg_get_expr(d.adbin,d.adrelid),'')||'|'||coalesce(coll.collname,'') AS definition
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 LEFT JOIN pg_collation coll ON coll.oid=a.attcollation
 WHERE n.nspname=current_schema() AND c.relkind='r'
 UNION ALL
 SELECT 'constraint', c.relname||'.'||con.conname, pg_get_constraintdef(con.oid)
 FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema()
 UNION ALL
 SELECT 'index', indexname, replace(indexdef,format(' ON %I.',current_schema()),' ON ')
 FROM pg_indexes WHERE schemaname=current_schema()
 UNION ALL
 SELECT 'sequence',sequencename,concat_ws('|',data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size)
 FROM pg_sequences WHERE schemaname=current_schema()
 UNION ALL
 SELECT 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND NOT t.tgisinternal
 UNION ALL
 SELECT 'rule',tablename||'.'||rulename,definition
 FROM pg_rules WHERE schemaname=current_schema()
 UNION ALL
 SELECT 'row security',c.relname,concat_ws('|',c.relrowsecurity,c.relforcerowsecurity)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=current_schema() AND (c.relrowsecurity OR c.relforcerowsecurity)
 UNION ALL
 SELECT 'policy',tablename||'.'||policyname,concat_ws('|',permissive,roles,cmd,qual,with_check)
 FROM pg_policies WHERE schemaname=current_schema()
) declarations ORDER BY kind COLLATE "C",name COLLATE "C"`;

/** The same inspection of the shared `operations` schema. */
export const operationsInspectionSql = schemaInspectionSql.replaceAll(
  "current_schema()",
  "'operations'",
);
