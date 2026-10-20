/**
 * One JSON result for stdout: indented for a person at a terminal, a single
 * compact line when piped, so scripts and agents keep the exact wire format.
 */
export function jsonOutput(
  value: unknown,
  stream: { isTTY?: boolean } = process.stdout,
): string {
  return `${stream.isTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`;
}
