import {
  basename,
  delimiter,
  dirname,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

/** A POSIX shell word, quoted only when it needs to be. */
export function shellWord(value: string): string {
  return /^[\w./:@%+=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The installed `fonds` command when this process runs through it, as an
 * absolute path: an MCP host may start it without the shell's PATH.
 */
export function installedLauncher(
  entry: string | undefined = process.argv[1],
): string | undefined {
  return entry && /^fonds(?:\.mjs)?$/.test(basename(entry))
    ? resolve(entry)
    : undefined;
}

/** The command a person types to run a sibling entry point from here. */
function entryCommand(path: string): string {
  const shown = relative(process.cwd(), path);
  return shellWord(
    shown.startsWith("..") || shown.startsWith(sep) ? path : shown,
  );
}

/**
 * How a person reruns this CLI, for printed next steps: `fonds` when it is
 * the installed command on PATH, otherwise the launcher or entry point.
 * moduleUrl must be the root CLI entry point's URL.
 */
export function cliCommand(
  moduleUrl: string,
  launcher: string | undefined = installedLauncher(),
): string {
  if (launcher) {
    const onPath =
      basename(launcher) === "fonds" &&
      (process.env.PATH ?? "").split(delimiter).includes(dirname(launcher));
    return onPath ? "fonds" : shellWord(launcher);
  }
  const entry = entryCommand(fileURLToPath(moduleUrl));
  return moduleUrl.endsWith(".ts") ? `npx tsx ${entry}` : `node ${entry}`;
}

/** One printable command line; every argument is quoted on its own. */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args.map(shellWord)].join(" ");
}
