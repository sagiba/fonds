// PostgreSQL text cannot contain NUL. JSON-escaped scalar values use an
// unambiguous prefix; ordinary scalar values remain ordinary SQL text.
export const encodeScalarText = (value: string): string => {
  const json = JSON.stringify(value);
  return json.includes("\\") ? "\\j" + json : value;
};
export const decodeScalarText = (value: string): string =>
  value.startsWith("\\j") ? (JSON.parse(value.slice(2)) as string) : value;
