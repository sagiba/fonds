import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Offline check of relative Markdown links: every local target must exist and
// every fragment into a Markdown file must name a heading or an explicit HTML
// anchor there. Links with a URL scheme (https:, mailto: …) are not fetched.
// The parser covers the GitHub Markdown this repository writes: fenced code,
// code spans, HTML comments, ATX and setext headings (also in block quotes),
// inline links with balanced parentheses and reference definitions. Indented
// code blocks are read as prose, so a link-like line there is still checked.

const schemePattern = /^[a-z][a-z\d+.-]*:/i;
const fencePattern = /^[ \t>]*(`{3,}(?=[^`]*$)|~{3,})/;
const quotePrefixPattern = /^ {0,3}(?:>[ \t]?)+/;
const atxHeadingPattern = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const setextUnderlinePattern = /^ {0,3}(?:=+|-+)[ \t]*$/;
const paragraphBreakPattern = /^\s*(?:$|[-*+][ \t]|\d+[.)][ \t]|\|)/;
const htmlAnchorPattern = /<[a-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/gi;
const linkTextPattern = /!?\[(?:[^[\]\\]|\\.|\[(?:[^[\]\\]|\\.)*\])*\]\(/g;
const linkTailPattern =
  /[ \t]*\n?[ \t]*(?:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))[ \t]*\n?[ \t]*)?\)/y;
const referenceDefinitionPattern =
  /^ {0,3}(?:>[ \t]?)*[ \t]*\[(?:[^\]\\]|\\.)+\]:[ \t]*\n?(?:[ \t>]*)(<[^>\n]*>|\S+)/gm;
// A code span opens and closes with unescaped backtick runs of equal length
// and never crosses a blank line or a heading; a comment hides its contents.
const codeSpanOrCommentPattern =
  /(?<![`\\])(`+)(?!`)(?:(?!\n[ \t>]*\n|\n[ \t>]*#{1,6}(?:[ \t]|$))[\s\S])*?(?<!`)\1(?!`)|<!--[\s\S]*?-->/g;
const entities = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Spaces in place of every character except line breaks, so offsets hold. */
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

/** A closing fence repeats the opening character, at least as often, alone on its line. */
function closesFence(match, fence, line) {
  return (
    match &&
    match[1][0] === fence[0] &&
    match[1].length >= fence.length &&
    line.replace(/^[ \t>]*/, "").trim() === match[1]
  );
}

/** Blank fenced code blocks, keeping line breaks so offsets map to lines. */
function blankFencedCode(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const match = fencePattern.exec(line);
      if (fence === null) {
        if (match) {
          fence = match[1];
          return "";
        }
        return line;
      }
      if (closesFence(match, fence, line)) {
        fence = null;
      }
      return "";
    })
    .join("\n");
}

/**
 * The document with fenced code and comments blanked (`headings`, which keep
 * code-span text) and with code spans blanked too (`prose`, for links).
 */
function visibleText(text) {
  const fenced = blankFencedCode(text);
  let headings = "";
  let prose = "";
  let last = 0;
  for (const match of fenced.matchAll(codeSpanOrCommentPattern)) {
    const before = fenced.slice(last, match.index);
    const comment = match[1] === undefined;
    headings += before + (comment ? blank(match[0]) : match[0]);
    prose += before + blank(match[0]);
    last = match.index + match[0].length;
  }
  return {
    headings: headings + fenced.slice(last),
    prose: prose + fenced.slice(last),
  };
}

function decodeEntities(text) {
  return text.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal, hex, name) => {
      if (decimal || hex) {
        return String.fromCodePoint(
          Number.parseInt(decimal ?? hex, decimal ? 10 : 16),
        );
      }
      // Other named entities are almost all symbols, which slugs drop; a
      // symbol placeholder gives the same anchor without the full HTML table.
      return entities[name.toLowerCase()] ?? "\u00a4";
    },
  );
}

/** The heading's rendered text: inline markup removed, code text kept. */
function headingText(raw) {
  return raw
    .split(/(`+)((?:(?!\1)[\s\S])*?)\1/)
    .map((part, index) => {
      if (index % 3 === 1) {
        return "";
      }
      if (index % 3 === 2) {
        return part;
      }
      return decodeEntities(
        part
          .replace(
            /!?\[((?:[^[\]\\]|\\.)*)\](?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|\[[^\]]*\])/g,
            "$1",
          )
          .replace(/<[^>]+>/g, "")
          .replace(
            /(^|[^\p{L}\p{N}\\])[*_]+|(?<!\\)[*_]+(?=[^\p{L}\p{N}]|$)/gu,
            "$1",
          )
          .replace(/(?<!\\)[*~]/g, ""),
      ).replace(/\\([!-/:-@[-`{-~])/g, "$1");
    })
    .join("");
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export function githubSlug(heading) {
  return headingText(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Every fragment a Markdown document defines, with GitHub's -1, -2 suffixes. */
export function markdownAnchors(text) {
  const anchors = new Set();
  const occurrences = new Map();
  // GitHub's slugger: a repeated slug takes the next free numeric suffix.
  const add = (heading) => {
    const base = githubSlug(heading);
    let slug = base;
    while (occurrences.has(slug)) {
      const count = occurrences.get(base) + 1;
      occurrences.set(base, count);
      slug = `${base}-${count}`;
    }
    occurrences.set(slug, 0);
    anchors.add(slug);
  };
  const { headings, prose } = visibleText(text);
  let paragraph = [];
  let paragraphQuoted = false;
  for (const line of headings.split("\n")) {
    const quoted = quotePrefixPattern.test(line);
    const content = line.replace(quotePrefixPattern, "");
    const atx = atxHeadingPattern.exec(content);
    if (atx) {
      add(atx[2] ?? "");
      paragraph = [];
    } else if (
      paragraph.length > 0 &&
      quoted === paragraphQuoted &&
      setextUnderlinePattern.test(content)
    ) {
      add(paragraph.join("\n"));
      paragraph = [];
    } else if (paragraphBreakPattern.test(content)) {
      paragraph = [];
    } else {
      if (paragraph.length === 0) {
        paragraphQuoted = quoted;
      }
      paragraph.push(content.trim());
    }
  }
  for (const [, id] of prose.matchAll(htmlAnchorPattern)) {
    anchors.add(id);
  }
  return anchors;
}

/** An inline link's destination starting at `start`, or null if none closes. */
function inlineDestination(text, start) {
  let index = start;
  while (text[index] === " " || text[index] === "\t") {
    index += 1;
  }
  if (text[index] === "\n") {
    index += 1;
    while (text[index] === " " || text[index] === "\t") {
      index += 1;
    }
  }
  let destination;
  let end;
  if (text[index] === "<") {
    end = text.indexOf(">", index);
    if (end === -1 || text.slice(index, end).includes("\n")) {
      return null;
    }
    destination = text.slice(index + 1, end);
    end += 1;
  } else {
    let depth = 0;
    for (end = index; end < text.length; end += 1) {
      const char = text[end];
      if (char === "\\") {
        end += 1;
      } else if (/\s/.test(char)) {
        break;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        if (depth === 0) {
          break;
        }
        depth -= 1;
      }
    }
    if (depth !== 0) {
      return null;
    }
    destination = text.slice(index, end);
  }
  linkTailPattern.lastIndex = end;
  return linkTailPattern.test(text) ? destination : null;
}

/** Link destinations outside code and comments, with 1-based line numbers. */
export function markdownLinks(text) {
  const { prose } = visibleText(text);
  const lineOf = (offset) => prose.slice(0, offset).split("\n").length;
  const links = [];
  const seen = new Set();
  linkTextPattern.lastIndex = 0;
  for (let match; (match = linkTextPattern.exec(prose));) {
    const start = match.index + match[0].length;
    // Resume inside the text so a link nested in another's text is found too.
    linkTextPattern.lastIndex = match.index + 1;
    const target = inlineDestination(prose, start);
    if (target !== null && !seen.has(start)) {
      seen.add(start);
      links.push({ target, line: lineOf(match.index) });
    }
  }
  for (const match of prose.matchAll(referenceDefinitionPattern)) {
    const target = match[1].replace(/^<([\s\S]*)>$/, "$1");
    links.push({ target, line: lineOf(match.index) });
  }
  return links
    .map(({ target, line }) => ({
      target: target.replace(/\\([!-/:-@[-`{-~])/g, "$1"),
      line,
    }))
    .sort((left, right) => left.line - right.line);
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Check the links in `files` (paths relative to `root`). Returns one message
 * per broken link, empty when every relative link and anchor resolves.
 */
export function checkMarkdownLinks(root, files) {
  const anchorCache = new Map();
  const anchorsOf = (path) => {
    if (!anchorCache.has(path)) {
      anchorCache.set(path, markdownAnchors(readFileSync(path, "utf8")));
    }
    return anchorCache.get(path);
  };
  const problems = [];
  for (const file of files) {
    const source = resolve(root, file);
    for (const { target, line } of markdownLinks(
      readFileSync(source, "utf8"),
    )) {
      if (schemePattern.test(target) || target.startsWith("//")) {
        continue;
      }
      const hashIndex = target.indexOf("#");
      const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const fragment =
        hashIndex === -1 ? null : decode(target.slice(hashIndex + 1));
      const where = `${file}:${line}`;
      const path = decode(pathPart.replace(/\?.*$/, ""));
      const destination =
        path === ""
          ? source
          : path.startsWith("/")
            ? join(resolve(root), path)
            : resolve(dirname(source), path);
      const fromRoot = relative(resolve(root), destination);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        problems.push(`${where}: ${target} leaves the repository`);
        continue;
      }
      if (!existsSync(destination)) {
        problems.push(`${where}: ${target} does not exist`);
        continue;
      }
      if (
        fragment === null ||
        statSync(destination).isDirectory() ||
        extname(destination).toLowerCase() !== ".md"
      ) {
        continue;
      }
      if (!anchorsOf(destination).has(fragment)) {
        problems.push(`${where}: ${target} names no heading or anchor`);
      }
    }
  }
  return problems;
}

/** Authored Markdown: tracked and untracked files that git does not ignore. */
export function repositoryMarkdownFiles(root) {
  return execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "*.md",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(root, file)));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = process.cwd();
  const files = repositoryMarkdownFiles(root);
  const problems = checkMarkdownLinks(root, files);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exitCode = 1;
  } else {
    console.info(`Markdown links verified in ${files.length} files`);
  }
}
