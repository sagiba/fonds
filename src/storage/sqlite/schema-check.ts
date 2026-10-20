import { schemaManifest } from "./schema-manifest.js";

export const schemaInspectionSql =
  "SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name";

interface SchemaRows {
  rows: ArrayLike<Record<string, unknown>>;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function schemaMatchesManifest(rows: SchemaRows["rows"]): boolean {
  return (
    rows.length === schemaManifest.length &&
    Array.from(rows).every((row, index) => {
      const expected = schemaManifest[index];
      return (
        expected !== undefined &&
        row.type === expected.type &&
        row.name === expected.name &&
        typeof row.sql === "string" &&
        normalize(row.sql) === normalize(expected.sql)
      );
    })
  );
}
