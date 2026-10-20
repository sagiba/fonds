import { validateCollectionRange } from "../application/collection.js";
import type { CollectionRange } from "../domain/source-adapter.js";
import type { ProviderCollectionOptions } from "../domain/source-adapter.js";
import { CommandInputError } from "./operation-cli.js";

function integerOption(
  value: string | undefined,
  flag: string,
  minimum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum
  ) {
    throw new CommandInputError(
      `--${flag} must be a safe integer of at least ${minimum}.`,
    );
  }
  return Number(value);
}

/** The `refresh` history window, provider controls and credential descriptor. */
export function collectionControls(values: {
  from?: string | undefined;
  to?: string | undefined;
  "history-mode"?: string | undefined;
  "search-window-months"?: string | undefined;
  "call-budget"?: string | undefined;
  "max-details"?: string | undefined;
  "credentials-fd"?: string | undefined;
}) {
  let range: CollectionRange | undefined;
  if (values.from !== undefined || values.to !== undefined) {
    if (!values.from?.trim() || !values.to?.trim()) {
      throw new CommandInputError(
        values.from?.trim() ? "--to is required." : "--from is required.",
      );
    }
    range = { from: values.from, to: values.to };
    try {
      validateCollectionRange(range);
    } catch {
      throw new CommandInputError(
        "--from and --to must be valid YYYY-MM-DD dates in ascending order.",
      );
    }
  }
  const options: ProviderCollectionOptions = {};
  const mode = values["history-mode"];
  if (mode !== undefined) {
    if (mode !== "monthly" && mode !== "search") {
      throw new CommandInputError("--history-mode must be monthly or search.");
    }
    if (!range) {
      throw new CommandInputError("--history-mode requires --from and --to.");
    }
    options.historyMode = mode;
  }
  if (values["search-window-months"] !== undefined) {
    if (!range) {
      throw new CommandInputError(
        "--search-window-months requires --from and --to.",
      );
    }
    if (options.historyMode === "monthly") {
      throw new CommandInputError(
        "--search-window-months requires search history mode.",
      );
    }
    const months = integerOption(
      values["search-window-months"],
      "search-window-months",
      1,
    );
    if (months !== 1 && months !== 3 && months !== 6 && months !== 12) {
      throw new CommandInputError(
        "--search-window-months must be 1, 3, 6, or 12.",
      );
    }
    options.searchWindowMonths = months;
  }
  const callBudget = integerOption(values["call-budget"], "call-budget", 1);
  if (callBudget !== undefined) {
    if (callBudget > 100) {
      throw new CommandInputError("--call-budget must be at most 100.");
    }
    options.callBudget = callBudget;
  }
  const credentialFd = integerOption(
    values["credentials-fd"],
    "credentials-fd",
    3,
  );
  const maxDetails = integerOption(values["max-details"], "max-details", 0);
  if (maxDetails !== undefined) {
    if (maxDetails > 20) {
      throw new CommandInputError("--max-details must be at most 20.");
    }
    options.maxDetails = maxDetails;
  }
  return { range, options, credentialFd };
}
