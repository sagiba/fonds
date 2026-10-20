#!/usr/bin/env node
// The `fonds` command of the npm package and the SQLite image: `fonds serve …`
// runs the HTTP/stdio server; anything else is the CLI. Each loads only its own
// bundle.
const [command, ...args] = process.argv.slice(2);
if (command === "serve") {
  const { main } = await import("./server.js");
  await main(args);
} else {
  const { main } = await import("./cli.js");
  process.exitCode = await main(process.argv.slice(2));
}
