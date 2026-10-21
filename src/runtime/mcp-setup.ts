import { fileURLToPath } from "node:url";

/** A POSIX shell word, quoted only when it needs to be. */
export function shellWord(value: string): string {
  return /^[\w./:@%+=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Desktop hosts need not inherit the shell's PATH or Fonds environment. Pin
 * the Node runtime and SQLite entry point as well as the ledger's state;
 * never copy the process environment, which may contain provider secrets.
 */
export function localMcpSetup(
  databasePath: string,
  stateDirectory: string,
  moduleUrl: string,
  name = "fonds",
): string {
  const source = moduleUrl.endsWith(".ts");
  const server = fileURLToPath(
    new URL(source ? "../dist/server.js" : "./server.js", moduleUrl),
  );
  const command = process.execPath;
  const args = [server, "--transport", "stdio", "--db", databasePath];
  const env = { FONDS_STATE_DIR: stateDirectory };
  const invocation = [command, ...args].map(shellWord).join(" ");
  const state = shellWord(`FONDS_STATE_DIR=${stateDirectory}`);
  return [
    ...(source ? ["Build the source checkout first: npm run build", ""] : []),
    "ChatGPT desktop: Settings > MCP servers > Add server > STDIO.",
    "Use command, args and env from the JSON below, then save and restart.",
    "Claude Desktop: merge this entry into claude_desktop_config.json:",
    `  ${JSON.stringify({ mcpServers: { [name]: { command, args, env } } })}`,
    "",
    "Claude Code (current project only; use --scope user for all projects):",
    `  claude mcp add ${name} --scope local --transport stdio --env ${state} -- ${invocation}`,
    "Optional Codex CLI shortcut for ChatGPT desktop on the same local host:",
    `  codex mcp add ${name} --env ${state} -- ${invocation}`,
    "",
    "Restart the client, check /mcp (or its MCP settings), and ask it to list connections.",
    "ChatGPT web needs a hosted connection; see docs/guides/chatgpt-connect.md.",
    "Rerun mcp-config after moving the installation or changing Node versions.",
    "",
  ].join("\n");
}
