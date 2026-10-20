import { resolveInstallation } from "../../src/runtime/installation.js";
import {
  localStateDirectory,
  openLocalLedger,
} from "../../src/runtime/local-ledger.js";

/** The installation the CLI and server use in this test process, created once. */
export function localState(env: NodeJS.ProcessEnv = process.env) {
  return resolveInstallation(localStateDirectory(env), { create: true });
}

/** A test ledger bound to that installation, as `init` would create it. */
export async function openBoundDatabase(path: string) {
  return openLocalLedger(path, await localState());
}
