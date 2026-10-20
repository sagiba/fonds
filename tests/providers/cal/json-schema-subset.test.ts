import { readFileSync } from "node:fs";

import { parse } from "lossless-json";
import { describe, expect, it } from "vitest";

import { compileSchema } from "./scripts/json-schema-subset.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

describe("JSON Schema subset", () => {
  it("compiles the observed CAL schema and reports type, required and anyOf failures", () => {
    const validate = compileSchema(
      JSON.parse(
        readFileSync(
          new URL("./schemas/cal-observed.schema.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const fixture = parse(
      readFileSync(
        new URL("./fixtures/recent-01.json", import.meta.url),
        "utf8",
      ),
    );
    expect(validate(fixture)).toEqual([]);
    expect(
      validate(parse('{"statusCode": 1.0, "result": {"transArr": []}}')),
    ).toEqual([]);
    expect(validate(parse('{"statusCode": 1.5, "result": 3}'))).toEqual([
      { keyword: "anyOf", path: ["result"] },
      { keyword: "type", path: ["statusCode"] },
    ]);
    expect(validate(parse("{}"))).toEqual([
      { keyword: "required", path: [] },
      { keyword: "required", path: [] },
    ]);
  });

  it("resolves references only against root definitions, checking unreferenced ones too", () => {
    const validate = compileSchema({
      $schema: DIALECT,
      $id: "https://example.invalid/synthetic.schema.json",
      type: "object",
      properties: { item: { $ref: "#/$defs/item" } },
      $defs: {
        item: { type: ["integer", "null"] },
        unused: { type: "string", description: "Annotations are allowed." },
      },
    });
    expect(validate(parse('{"item": 1e2}'))).toEqual([]);
    expect(validate(parse('{"item": "x"}'))).toEqual([
      { keyword: "type", path: ["item"] },
    ]);
    expect(() =>
      compileSchema({ $defs: { unused: { type: "string", minLength: 1 } } }),
    ).toThrow();
    expect(() => compileSchema({ $ref: "#/$defs/missing" })).toThrow();
  });

  it("rejects nested $defs, $id and $schema and any unsupported keyword", () => {
    for (const nested of [
      { $defs: { inner: { type: "string", minLength: 1 } } },
      { $defs: { inner: { type: "string" } } },
      { $id: "https://example.invalid/other.schema.json" },
      { $schema: DIALECT },
    ]) {
      expect(() =>
        compileSchema({ $defs: { outer: { type: "object", ...nested } } }),
      ).toThrow();
      expect(() =>
        compileSchema({ properties: { field: { type: "object", ...nested } } }),
      ).toThrow();
    }
    for (const unsupported of [
      { additionalProperties: false },
      { items: [{ type: "string" }] },
      { enum: ["a"] },
      { type: "float" },
      { $schema: "http://json-schema.org/draft-07/schema#" },
    ]) {
      expect(() => compileSchema(unsupported)).toThrow();
    }
  });
});
