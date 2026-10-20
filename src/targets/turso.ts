import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runNodeService } from "../runtime/node-service.js";
import {
  operationUsage,
  runEmbeddedOperation,
} from "../runtime/operation-cli.js";
import {
  initializeTursoDatabase,
  openTursoDatabase,
} from "../storage/turso.js";

export { startNodeService } from "../runtime/node-service.js";
export {
  databaseForClient,
  initializeTursoDatabase,
  openTursoDatabase,
} from "../storage/turso.js";

const tursoUsage = `Fonds — Turso/libSQL target
Usage: node server.js                 serve the loopback HTTP/MCP API (needs FONDS_API_TOKEN)
       node server.js <command> [options]
The database is FONDS_DATABASE_URL (libsql://, https:// or wss://), with
FONDS_DATABASE_AUTH_TOKEN when the server requires one.
This experimental target is outside the state model: it reads FONDS_API_TOKEN from
the environment, has no state directory and binds no installation.

Operation commands take the operation's input fields as kebab-case flags and print
its JSON output; use <command> --help for one command's description and flags:
${operationUsage()}
`;

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  const open = async (initialize: boolean) => {
    const url = process.env.FONDS_DATABASE_URL;
    if (!url) {
      throw new Error("FONDS_DATABASE_URL is required");
    }
    const authToken = process.env.FONDS_DATABASE_AUTH_TOKEN;
    const store = openTursoDatabase({ url, ...(authToken && { authToken }) });
    if (!initialize) {
      return store;
    }
    try {
      await initializeTursoDatabase(store.client);
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  };
  if (process.argv[2] === "--help") {
    process.stdout.write(tursoUsage);
  } else if (process.argv.length > 2) {
    // Operation commands on an existing database; this experimental target
    // does not migrate or check its schema first.
    process.exitCode = await runEmbeddedOperation(process.argv.slice(2), () =>
      open(false),
    );
  } else {
    await runNodeService(() => open(true));
  }
}
