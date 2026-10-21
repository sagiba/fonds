import { fileURLToPath } from "node:url";

import { shellWord } from "./cli-invocation.js";
import { hasTerminalControls } from "./cli-output.js";
import { CommandInputError } from "./operation-cli.js";

export const MCP_CLIENTS = [
  "chatgpt-desktop",
  "claude-desktop",
  "claude-code",
  "codex",
] as const;

export type McpClient = (typeof MCP_CLIENTS)[number];

/** Server names every client accepts, and safe as one shell word. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface Server {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

const sections: Record<McpClient, (server: Server) => string[]> = {
  "chatgpt-desktop": ({ command, args, env }) => [
    "ChatGPT desktop: Settings > MCP servers > Add server > STDIO.",
    "Enter this command, args and env, then save and restart ChatGPT:",
    `  ${JSON.stringify({ command, args, env })}`,
  ],
  "claude-desktop": ({ name, command, args, env }) => [
    "Claude Desktop: Settings > Developer > Edit Config. Merge this entry into",
    "claude_desktop_config.json, then fully quit and restart Claude:",
    `  ${JSON.stringify({ mcpServers: { [name]: { command, args, env } } })}`,
  ],
  "claude-code": (server) => [
    "Claude Code, from the project you will use it in (--scope user for all projects):",
    `  claude mcp add ${shellWord(server.name)} --scope local --transport stdio ${invocation(server)}`,
  ],
  codex: (server) => [
    "Codex CLI; ChatGPT desktop on this host shares its MCP configuration:",
    `  codex mcp add ${shellWord(server.name)} ${invocation(server)}`,
  ],
};

/**
 * Setup is copied exactly, so it cannot be escaped for the terminal: output
 * whose paths hold control characters is refused instead of printed.
 */
function plainOutput(lines: readonly string[]): string {
  if (lines.some(hasTerminalControls)) {
    throw new CommandInputError(
      "Client setup cannot print paths that contain control characters; use a plain path.",
    );
  }
  return lines.join("\n");
}

function invocation({ command, args, env }: Server): string {
  const state = Object.entries(env).map(
    ([key, value]) => `--env ${shellWord(`${key}=${value}`)}`,
  );
  return [...state, "--", ...[command, ...args].map(shellWord)].join(" ");
}

/**
 * Desktop hosts need not inherit the shell's PATH or Fonds environment. Pin
 * the Node runtime and SQLite entry point as well as the ledger's state;
 * never copy the process environment, which may contain provider secrets.
 * moduleUrl must be the root CLI entry point's URL, not this helper's URL.
 * The name must match MCP_SERVER_NAME.
 */
export function localMcpSetup(
  databasePath: string,
  stateDirectory: string,
  moduleUrl: string,
  options: { name?: string; client?: McpClient | "all" } = {},
): string {
  const { name = "fonds", client = "all" } = options;
  const source = moduleUrl.endsWith(".ts");
  const server: Server = {
    name,
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL(source ? "../dist/server.js" : "./server.js", moduleUrl),
      ),
      "--transport",
      "stdio",
      "--db",
      databasePath,
    ],
    env: { FONDS_STATE_DIR: stateDirectory },
  };
  const clients = client === "all" ? MCP_CLIENTS : [client];
  return plainOutput([
    ...(source ? ["Build the source checkout first: npm run build", ""] : []),
    ...clients.flatMap((entry) => [...sections[entry](server), ""]),
    ...(client === "all"
      ? [
          "ChatGPT web: https://github.com/sagiba/fonds/blob/main/docs/guides/chatgpt-connect.md",
        ]
      : []),
    "Then check /mcp or the client's MCP settings, and ask it to list connections.",
    "Rerun mcp-config after moving the installation or changing Node versions.",
    "",
  ]);
}

/** What mcp-config prints without --client: one command per client. */
export function mcpClientChooser(
  databasePath: string,
  command: (args: string[]) => string,
): string {
  return plainOutput([
    `Set up a local assistant for ${databasePath}:`,
    ...MCP_CLIENTS.map((client) => `  ${command(["--client", client])}`),
    "",
    `Every client's setup: ${command(["--all"])}`,
    "",
  ]);
}
