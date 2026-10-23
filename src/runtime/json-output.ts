/**
 * Characters JSON.stringify leaves raw that can still drive a terminal: DEL,
 * C1 controls, line separators, bidi embeddings, overrides and isolates, and
 * the deprecated shaping and mirroring controls.
 */
const RAW_TERMINAL_CONTROLS =
  /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u206f]/g;

/**
 * `\uXXXX` for each UTF-16 unit: in JSON, the same string value, and inert
 * on a terminal. A supplementary character becomes its surrogate pair.
 */
export function unicodeEscape(text: string): string {
  let escaped = "";
  for (let index = 0; index < text.length; index++) {
    escaped += `\\u${text.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return escaped;
}

/**
 * One JSON result for stdout: indented for a person at a terminal, a single
 * compact line when piped, so scripts and agents keep the exact wire format.
 * A terminal gets those characters as escapes, which parse to the same value.
 */
export function jsonOutput(
  value: unknown,
  stream: { isTTY?: boolean } = process.stdout,
): string {
  return `${
    stream.isTTY
      ? JSON.stringify(value, null, 2).replace(
          RAW_TERMINAL_CONTROLS,
          unicodeEscape,
        )
      : JSON.stringify(value)
  }\n`;
}
