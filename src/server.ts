import process from "node:process";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolveConfiguration } from "./config/discovery.ts";
import { createMcpServer } from "./mcp/server.ts";
import { SessionManager } from "./sessions/manager.ts";

export async function startMcpServer(configPath?: string): Promise<void> {
  const startup = await resolveConfiguration({
    explicitConfigPath: configPath,
    cwd: process.cwd(),
    includeProject: false,
  });
  const agents = startup.agents;
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager, {
    resolveConfiguration: (cwd) =>
      resolveConfiguration({
        explicitConfigPath: configPath,
        cwd: cwd ?? process.cwd(),
      }),
  });
  let closing: Promise<void> | undefined;
  const closeSessions = () => {
    if (!closing) closing = manager.closeAll();
    return closing;
  };
  try {
    const closeAndExit = () => {
      void closeSessions().finally(() => process.exit(0));
    };
    process.on("SIGINT", closeAndExit);
    process.on("SIGTERM", closeAndExit);
  } catch {
    /* Signal support varies by platform. */
  }
  process.stdin.once("end", closeSessions);
  process.stdin.once("close", closeSessions);
  await serveStdio(() => server);
}
