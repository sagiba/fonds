#!/usr/bin/env node
// The `fonds` command of the npm package. A postgresql:// FONDS_DATABASE_URL
// selects the PostgreSQL build, the rule the CLI's backend selection applies;
// otherwise SQLite, where `fonds serve …` runs the HTTP/stdio server and
// anything else the CLI. Each loads only its own bundle.
const args = process.argv.slice(2);
if (args[0] === "help" && args.length === 2) {
  args.shift();
  args.push("--help");
}
if (/^postgres(?:ql)?:/i.test(process.env.FONDS_DATABASE_URL ?? "")) {
  const { main } = await import("./postgres/server.js");
  await main(args);
} else if (args[0] === "serve" && args.includes("--hosted")) {
  process.stderr.write(
    "The hosted service runs on PostgreSQL: set FONDS_DATABASE_URL to a postgresql:// URL.\n",
  );
  process.exitCode = 1;
} else if (args[0] === "serve") {
  const { main } = await import("./server.js");
  await main(args.slice(1));
} else {
  const { main } = await import("./cli.js");
  process.exitCode = await main(args);
}
