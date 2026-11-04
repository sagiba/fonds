import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { isLosslessNumber, parse } from "lossless-json";

// Value-free view of a private HAR, for discovering a provider's API without
// reading its contents. A HAR holds passwords, tokens and financial rows in
// clear text, so this prints structure only: endpoints, header and field names,
// presence counts and value classes. Of source values, only explicitly requested
// booleans, nulls and short codes are printed. Names can embed identifiers, and
// their masking is a heuristic that catches digits and opaque tokens, not a
// person's name, so the owner reads this output before sharing it. It is still
// derived from real data: keep it out of the repository.
//
//   node scripts/har-profile.mjs endpoints CAPTURE.har
//   node scripts/har-profile.mjs shape CAPTURE.har PATH_SUFFIX [--codes a,b]

const staticContent = /^(image|font|audio|video)\/|css|javascript/;
const maxCodeLength = 3;
const mediaClasses = [
  [/json/, "json"],
  [/html/, "html"],
  [/xml/, "xml"],
  [/urlencoded/, "form"],
  [/^text\//, "text"],
];

/** A fixed category, because a media type is an arbitrary header value. */
function mediaClass(type = "") {
  return mediaClasses.find(([pattern]) => pattern.test(type))?.[1] ?? "other";
}

/** Keeps a source-defined name; masks anything that could be a value. */
function safeName(name) {
  if (!/^[A-Za-z_$][\w$.-]{0,63}$/.test(name)) {
    return "<name>";
  }
  return name.replace(/\d{4,}/g, "<n>");
}

function safeSegment(segment) {
  if (segment === "") {
    return segment;
  }
  const opaque = segment.length >= 16 && /\d/.test(segment);
  return !opaque && /^[A-Za-z][\w.-]{0,63}$/.test(segment)
    ? safeName(segment)
    : "<id>";
}

function safePath(pathname) {
  return pathname.split("/").map(safeSegment).join("/");
}

function headerNames(headers) {
  return new Set(
    (Array.isArray(headers) ? headers : [])
      .filter((header) => typeof header?.name === "string")
      .map(({ name }) => name.toLowerCase()),
  );
}

function targetOf(entry) {
  const { method, url } = entry?.request ?? {};
  if (typeof url !== "string") {
    return null;
  }
  if (method === "CONNECT") {
    return { host: url.replace(/^\w+:\/\//, "").split(/[/:]/)[0], method };
  }
  try {
    const parsed = new URL(url);
    return { host: parsed.host, method, parsed };
  } catch {
    return null;
  }
}

function endpointKey({ host, method, parsed }) {
  if (parsed === undefined) {
    return `${method} ${host}`;
  }
  const query = [...new Set(parsed.searchParams.keys())]
    .map(safeName)
    .sort()
    .join(",");
  return `${method} ${host}${safePath(parsed.pathname)}${query && `?${query}`}`;
}

/** One line per endpoint in first-seen order, so the login flow reads top down. */
export function endpointReport(har) {
  const rows = new Map();
  let unparsed = 0;
  har.log.entries.forEach((entry, index) => {
    const target = targetOf(entry);
    if (target === null) {
      unparsed++;
      return;
    }
    const type = (entry.response?.content?.mimeType ?? "").split(";")[0];
    if (staticContent.test(type)) {
      return;
    }
    const key = endpointKey(target);
    const row = rows.get(key) ?? {
      first: index,
      count: 0,
      statuses: new Set(),
      types: new Set(),
      flags: new Set(),
    };
    const sent = headerNames(entry.request.headers);
    row.count++;
    row.statuses.add(entry.response?.status ?? 0);
    row.types.add(mediaClass(type));
    if (sent.has("authorization")) {
      row.flags.add("auth");
    }
    if (sent.has("cookie")) {
      row.flags.add("cookie");
    }
    if (headerNames(entry.response?.headers).has("set-cookie")) {
      row.flags.add("sets-cookie");
    }
    rows.set(key, row);
  });
  const lines = [...rows].map(([key, row]) =>
    [
      `#${row.first}`,
      `x${row.count}`,
      [...row.statuses].join("/"),
      [...row.types].join("/"),
      [...row.flags].sort().join(",") || "-",
      key,
    ].join("\t"),
  );
  if (unparsed > 0) {
    lines.push(`${unparsed} entries with an unparsable URL were skipped`);
  }
  return lines.join("\n");
}

function stringClass(text) {
  if (text === "") {
    return "empty";
  }
  if (text.trim() === "") {
    return "blank";
  }
  if (/^\d{4}-\d\d-\d\d$/.test(text)) {
    return "date(yyyy-mm-dd)";
  }
  if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(text)) {
    return "datetime(iso)";
  }
  if (/^\d\d\/\d\d\/\d{2,4}/.test(text)) {
    return "date(dd/mm/yy..)";
  }
  if (/^\d\d:\d\d(:\d\d)?$/.test(text)) {
    return "time";
  }
  if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(text)) {
    return "uuid";
  }
  if (/^\d+$/.test(text)) {
    return `digits(${text.length}${text[0] === "0" ? ",leading-zero" : ""})`;
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    return "decimal-text";
  }
  return text.length <= 16 ? "text(short)" : "text(long)";
}

function numberClass(lexeme) {
  if (/e/i.test(lexeme)) {
    return "number(exponent)";
  }
  const places = lexeme.split(".")[1]?.length ?? 0;
  return places === 0 ? "number(integer)" : `number(${places}dp)`;
}

function valueClass(value) {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "string") {
    return stringClass(value);
  }
  return isLosslessNumber(value) ? numberClass(value.value) : typeof value;
}

function codeLabel(value) {
  if (value === null || typeof value === "boolean") {
    return String(value);
  }
  const text = isLosslessNumber(value) ? value.value : value;
  return typeof text === "string" && /^[\w-]+$/.test(text)
    ? text.length <= maxCodeLength
      ? JSON.stringify(text)
      : "<too long>"
    : "<not a code>";
}

function bump(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function field(fields, path) {
  const entry = fields.get(path) ?? {
    present: 0,
    classes: new Map(),
    codes: new Map(),
  };
  fields.set(path, entry);
  return entry;
}

/** Merge a value into per-path presence and class counts; arrays merge their rows. */
function collect(value, path, fields, codes, parents) {
  const entry = field(fields, path);
  entry.present++;
  entry.parent = parents;
  if (Array.isArray(value)) {
    bump(entry.classes, "array");
    const rows = `${path}[]`;
    for (const row of value) {
      field(fields, rows);
      collect(row, rows, fields, codes, path);
    }
    return;
  }
  if (value !== null && typeof value === "object" && !isLosslessNumber(value)) {
    bump(entry.classes, "object");
    for (const [key, child] of Object.entries(value)) {
      const name = safeName(key);
      collect(child, `${path}.${name}`, fields, codes, path);
      if (codes.has(key)) {
        for (const item of [child].flat()) {
          bump(field(fields, `${path}.${name}`).codes, codeLabel(item));
        }
      }
    }
    return;
  }
  bump(entry.classes, valueClass(value));
}

function report(fields) {
  return [...fields].map(([path, entry]) => {
    const total = fields.get(entry.parent)?.present ?? entry.present;
    const classes = [...entry.classes]
      .map(([name, count]) => `${name}:${count}`)
      .join(" ");
    const codes = [...entry.codes]
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
    return [path, `${entry.present}/${total}`, classes, codes]
      .filter((part) => part !== "")
      .join("\t");
  });
}

/** Repeated keys become arrays, so no occurrence is lost. */
function pairsObject(params) {
  const object = Object.create(null);
  for (const [key, value] of params) {
    object[key] = Object.hasOwn(object, key)
      ? [object[key], value].flat()
      : value;
  }
  return object;
}

function parseBody(text, mimeType = "") {
  if (typeof text !== "string" || text === "") {
    return undefined;
  }
  try {
    return parse(text);
  } catch {
    return /urlencoded/i.test(mimeType)
      ? pairsObject(new URLSearchParams(text))
      : undefined;
  }
}

function responseText(content) {
  return content?.encoding === "base64" && typeof content.text === "string"
    ? Buffer.from(content.text, "base64").toString("utf8")
    : content?.text;
}

/** Field, presence and class report for the entries whose path ends with the suffix. */
export function shapeReport(har, suffix, codeFields = []) {
  const codes = new Set(codeFields);
  const sections = {
    query: new Map(),
    request: new Map(),
    response: new Map(),
  };
  const sentHeaders = new Set();
  const received = { statuses: new Map(), unparsed: 0, matches: 0 };
  const requestTypes = new Set();
  for (const entry of har.log.entries) {
    const target = targetOf(entry);
    if (!target?.parsed?.pathname.endsWith(suffix)) {
      continue;
    }
    received.matches++;
    bump(received.statuses, entry.response?.status ?? 0);
    headerNames(entry.request.headers).forEach((name) => sentHeaders.add(name));
    const { postData } = entry.request;
    if (postData?.mimeType) {
      requestTypes.add(mediaClass(postData.mimeType));
    }
    const query = pairsObject(target.parsed.searchParams);
    if (Object.keys(query).length > 0) {
      collect(query, "$", sections.query, codes);
    }
    const sent = parseBody(postData?.text, postData?.mimeType);
    if (sent !== undefined) {
      collect(sent, "$", sections.request, codes);
    }
    const body = parseBody(responseText(entry.response?.content ?? null));
    if (body === undefined) {
      received.unparsed++;
    } else {
      collect(body, "$", sections.response, codes);
    }
  }
  const statuses = [...received.statuses]
    .map(([status, count]) => `${status}:${count}`)
    .join(" ");
  return [
    `matches ${received.matches}; statuses ${statuses || "-"}; responses without a parsed body ${received.unparsed}`,
    `request content types: ${[...requestTypes].join(", ") || "-"}`,
    `request headers: ${[...sentHeaders].sort().map(safeName).join(", ") || "-"}`,
    ...Object.entries(sections).flatMap(([name, fields]) =>
      fields.size === 0 ? [] : [`== ${name}`, ...report(fields)],
    ),
  ].join("\n");
}

function readHar(path) {
  try {
    const har = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(har?.log?.entries)) {
      return har;
    }
  } catch {
    // The parser's message can quote file content, so none of it is reported.
  }
  throw new Error("The file could not be read as a HAR.");
}

function main([command, path, ...rest]) {
  if (command === "endpoints" && path !== undefined) {
    return endpointReport(readHar(path));
  }
  const [suffix, flag, list] = rest;
  if (
    command === "shape" &&
    path !== undefined &&
    suffix !== undefined &&
    (flag === undefined || (flag === "--codes" && list !== undefined))
  ) {
    return shapeReport(readHar(path), suffix, list?.split(",") ?? []);
  }
  throw new Error(
    "Usage: har-profile.mjs endpoints FILE | shape FILE PATH_SUFFIX [--codes a,b]",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
