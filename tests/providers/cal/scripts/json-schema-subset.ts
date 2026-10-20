/**
 * The JSON Schema 2020-12 subset that `../schemas/cal-observed.schema.json` uses:
 * `type`, `required`, `properties`, `additionalProperties: true`, `items` (one
 * schema for every element), `anyOf` and local `$ref` to `#/$defs/NAME`.
 * `$schema` (2020-12 only), `$id` and `$defs` are accepted at the root alone,
 * so every reference resolves against the one root scope, and each definition
 * is checked by the same rules whether or not anything references it.
 * Compiling rejects any other keyword or form, so a schema edit that needs
 * more fails loudly instead of being ignored.
 *
 * Instances are values parsed by lossless-json. A number is integral, and so
 * matches `integer`, when its exact decimal value is a whole number, as JSON
 * Schema defines it (`1.0` and `1e2` included).
 */
import { isLosslessNumber, type LosslessNumber } from "lossless-json";

export type InstancePath = (string | number)[];

/** One failed assertion: the keyword and where in the instance it failed. */
export interface SchemaError {
  keyword: "anyOf" | "required" | "type";
  path: InstancePath;
}

type Schema = Record<string, unknown>;

const TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const ANNOTATIONS = new Set(["description", "title"]);
const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const REFERENCE = /^#\/\$defs\/([^/~]+)$/;

class UnsupportedSchemaError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !isLosslessNumber(value)
  );
}

/** Whether a JSON number lexeme denotes a whole number, without rounding. */
function integralLexeme(lexeme: string): boolean {
  const match = lexeme.match(/^-?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) {
    return false;
  }
  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`;
  const trailingZeros = digits.length - digits.replace(/0+$/, "").length;
  if (trailingZeros === digits.length) {
    return true;
  }
  return Number(match[3] ?? "0") - fraction.length + trailingZeros >= 0;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return isLosslessNumber(value);
    case "integer":
      return (
        isLosslessNumber(value) &&
        integralLexeme((value as LosslessNumber).value)
      );
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    default:
      return record(value);
  }
}

const typeName = (type: unknown) => typeof type === "string" && TYPES.has(type);

/** The accepted form of each supported keyword's value. */
const KEYWORD_FORMS: Record<
  string,
  (value: unknown, definitions: Schema) => boolean
> = {
  type: (value) =>
    typeName(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(typeName)),
  required: (value) =>
    Array.isArray(value) && value.every((name) => typeof name === "string"),
  properties: record,
  additionalProperties: (value) => value === true,
  items: record,
  anyOf: (value) => Array.isArray(value) && value.length > 0,
  $ref: (value, definitions) =>
    typeof value === "string" &&
    Object.hasOwn(definitions, REFERENCE.exec(value)?.[1] ?? ""),
};

function checkSchema(schema: unknown, definitions: Schema): void {
  if (!record(schema)) {
    throw new UnsupportedSchemaError();
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword) || keyword.startsWith("x-")) {
      continue;
    }
    const form = Object.hasOwn(KEYWORD_FORMS, keyword)
      ? KEYWORD_FORMS[keyword]
      : undefined;
    if (!form?.(value, definitions)) {
      throw new UnsupportedSchemaError();
    }
  }
  const properties = record(schema.properties) ? schema.properties : {};
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  const items = schema.items === undefined ? [] : [schema.items];
  for (const child of [...Object.values(properties), ...anyOf, ...items]) {
    checkSchema(child, definitions);
  }
}

/**
 * Checks the schema against the supported subset and returns a validator
 * that lists every failed `type`, `required` and `anyOf` assertion.
 */
export function compileSchema(
  root: unknown,
): (instance: unknown) => SchemaError[] {
  if (!record(root)) {
    throw new UnsupportedSchemaError();
  }
  const { $schema, $id, $defs, ...body } = root;
  const definitions = $defs ?? {};
  if (
    ($schema !== undefined && $schema !== DIALECT) ||
    ($id !== undefined && typeof $id !== "string") ||
    !record(definitions)
  ) {
    throw new UnsupportedSchemaError();
  }
  for (const definition of Object.values(definitions)) {
    checkSchema(definition, definitions);
  }
  checkSchema(body, definitions);
  const visit = (
    schema: Schema,
    value: unknown,
    path: InstancePath,
    errors: SchemaError[],
  ): void => {
    if (schema.type !== undefined) {
      const types = ([] as unknown[]).concat(schema.type) as string[];
      if (!types.some((type) => matchesType(value, type))) {
        errors.push({ keyword: "type", path });
      }
    }
    if (typeof schema.$ref === "string") {
      const name = REFERENCE.exec(schema.$ref)![1]!;
      visit(definitions[name] as Schema, value, path, errors);
    }
    if (Array.isArray(schema.anyOf)) {
      const anyValid = (schema.anyOf as Schema[]).some((option) => {
        const optionErrors: SchemaError[] = [];
        visit(option, value, path, optionErrors);
        return optionErrors.length === 0;
      });
      if (!anyValid) {
        errors.push({ keyword: "anyOf", path });
      }
    }
    if (record(value)) {
      for (const name of (schema.required as string[] | undefined) ?? []) {
        if (!Object.hasOwn(value, name)) {
          errors.push({ keyword: "required", path });
        }
      }
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const [name, child] of Object.entries(properties)) {
        if (Object.hasOwn(value, name)) {
          visit(child, value[name], [...path, name], errors);
        }
      }
    }
    if (Array.isArray(value) && record(schema.items)) {
      const items = schema.items;
      value.forEach((item, index) =>
        visit(items, item, [...path, index], errors),
      );
    }
  };
  return (instance) => {
    const errors: SchemaError[] = [];
    visit(root, instance, [], errors);
    return errors;
  };
}
