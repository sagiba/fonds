/**
 * Characters JSON.stringify leaves raw that can still drive a terminal: DEL,
 * C1 controls, line separators and bidi embeddings, overrides and isolates.
 */
const RAW_TERMINAL_CONTROLS =
  /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `\uXXXX`: in JSON, the same string value, and inert on a terminal. */
export function unicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
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
