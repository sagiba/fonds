import { styleText } from "node:util";

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

import { jsonOutput, unicodeEscape } from "./json-output.js";

/** How one command presents its result on stdout. */
export interface Presentation {
  /** Human views in a terminal; otherwise the JSON wire output. */
  readonly human: boolean;
  /** ASCII decorations only, for TERM=dumb. */
  readonly ascii: boolean;
  readonly width: number;
  readonly stream: NodeJS.WriteStream;
}

/**
 * Human output only on a terminal and only without --json; redirected
 * output always keeps the JSON wire format scripts and agents rely on.
 */
export function presentation(
  json: boolean,
  stream: NodeJS.WriteStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Presentation {
  return {
    human: !json && stream.isTTY === true,
    ascii: env.TERM === "dumb",
    width: stream.columns > 0 ? stream.columns : 80,
    stream,
  };
}

/** The result as the presentation shows it: a view, or the JSON output. */
export function present<T>(
  p: Presentation,
  value: T,
  view: ((value: T) => string) | undefined,
): string {
  return p.human && view ? view(value) : jsonOutput(value, p.stream);
}

/**
 * Controls that would let source text drive the terminal (C0, DEL, C1, line
 * separators, bidi embeddings, overrides and isolates), shown as escapes.
 */
const TERMINAL_CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Every dynamic string a view prints passes through here. */
export function safe(text: string): string {
  return text.replace(TERMINAL_CONTROLS, unicodeEscape);
}

/**
 * Invisible format characters: legitimate in prose such as Hebrew, but they
 * would make two different identifiers look the same.
 */
const INVISIBLE_FORMAT =
  /[\u00ad\u061c\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g;

/** An identifier or command, shown so that what you see is what you copy. */
export function safeId(text: string): string {
  return safe(text).replace(INVISIBLE_FORMAT, unicodeEscape);
}

/** Text that must be printed exactly, so cannot be escaped, has to be free of controls. */
export function hasTerminalControls(text: string): boolean {
  return safe(text) !== text;
}

type Tone = "ok" | "attention" | "error";

const marks: Record<Tone, readonly [string, string]> = {
  ok: ["✓", "ok"],
  attention: ["!", "!"],
  error: ["✗", "x"],
};
const colors = { ok: "green", attention: "yellow", error: "red" } as const;

/** A status line; color repeats the glyph and word, never replaces them. */
export function headline(p: Presentation, tone: Tone, text: string): string {
  const mark = marks[tone][p.ascii ? 1 : 0];
  return `${styleText(colors[tone], mark, { stream: p.stream })} ${text}`;
}

export function dim(p: Presentation, text: string): string {
  return styleText("dim", text, { stream: p.stream });
}

const separator = (p: Presentation) => (p.ascii ? " | " : " · ");

/** Short facts on one line. */
export function joined(p: Presentation, parts: readonly string[]): string {
  return parts.join(separator(p));
}

/**
 * Short facts filling lines of the width, each fact kept whole: money and
 * IDs are never split, even when one alone is wider than the line.
 */
export function flow(
  p: Presentation,
  parts: readonly string[],
  indent = "",
): string {
  const lines: string[] = [];
  for (const part of parts) {
    const last = lines.at(-1);
    const extended = last === undefined ? "" : `${last}${separator(p)}${part}`;
    if (last !== undefined && stringWidth(extended) <= p.width) {
      lines[lines.length - 1] = extended;
    } else {
      lines.push(`${indent}${part}`);
    }
  }
  return lines.join("\n");
}

/** Prose wrapped at spaces; a word wider than the line stays whole. */
export function wrap(text: string, width: number, indent = ""): string {
  return wrapAnsi(text, Math.max(width - indent.length, 1), {
    hard: false,
  })
    .split("\n")
    .map((line) => `${indent}${line}`.trimEnd())
    .join("\n");
}

/** Narrower than this, a value goes under its label rather than beside it. */
const MIN_VALUE_WIDTH = 24;

/** Label/value rows with the values aligned, or each value under its label. */
export function details(
  rows: readonly (readonly [string, string] | undefined)[],
  width: number,
): string {
  const present = rows.filter((row) => row !== undefined);
  const labelWidth = Math.max(...present.map(([label]) => label.length)) + 2;
  if (width - 2 - labelWidth < MIN_VALUE_WIDTH) {
    return present
      .map(([label, value]) => `  ${label}\n${wrap(value, width, "    ")}`)
      .join("\n");
  }
  return present
    .map(([label, value]) => {
      const lines = wrap(value, width - 2 - labelWidth).split("\n");
      return lines
        .map((line, index) =>
          `  ${(index ? "" : label).padEnd(labelWidth)}${line}`.trimEnd(),
        )
        .join("\n");
    })
    .join("\n");
}

interface Column {
  header: string;
  align?: "left" | "right";
  /** The one column that shrinks, truncated, to fit the terminal. */
  flexible?: boolean;
}

const GAP = 2;
const MIN_FLEXIBLE = 12;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The text cut to a display width, never inside a grapheme, with an ellipsis. */
function truncate(text: string, width: number, ellipsis: string): string {
  const room = width - stringWidth(ellipsis);
  let kept = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    used += stringWidth(segment);
    if (used > room) {
      break;
    }
    kept += segment;
  }
  return `${kept}${ellipsis}`;
}

/**
 * A borderless table that fits the width, or undefined when it cannot: when
 * its fixed columns are too wide, or leave a flexible one unreadable. Callers
 * then stack each row. Widths are display columns, so wide and combining
 * characters align, and only the flexible column is ever shortened.
 */
export function table(
  p: Presentation,
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
): string | undefined {
  const natural = columns.map((column, index) =>
    Math.max(
      stringWidth(column.header),
      ...rows.map((row) => stringWidth(row[index]!)),
    ),
  );
  const flexible = columns.findIndex((column) => column.flexible);
  const fixed = natural.reduce(
    (total, width, index) => (index === flexible ? total : total + width),
    GAP * (columns.length - 1),
  );
  const available = p.width - fixed;
  if (
    flexible >= 0
      ? available < Math.min(MIN_FLEXIBLE, natural[flexible]!)
      : available < 0
  ) {
    return undefined;
  }
  const widths = natural.map((width, index) =>
    index === flexible ? Math.min(width, available) : width,
  );
  const ellipsis = p.ascii ? "~" : "…";
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => {
        const width = widths[index]!;
        const shown =
          stringWidth(cell) > width ? truncate(cell, width, ellipsis) : cell;
        const padding = " ".repeat(width - stringWidth(shown));
        return columns[index]!.align === "right"
          ? `${padding}${shown}`
          : `${shown}${padding}`;
      })
      .join(" ".repeat(GAP))
      .trimEnd();
  return [
    dim(p, line(columns.map((column) => column.header))),
    ...rows.map(line),
  ].join("\n");
}
