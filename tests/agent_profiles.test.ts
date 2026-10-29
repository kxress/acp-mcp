import { test } from "node:test";
import process from "node:process";
import * as nodeFs from "#fs";
import { loadAgents } from "../src/agents/config.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { findExecutablePath, startAgent } from "../src/runtime/process.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { connectMcp, parseToolResult } from "./helpers/mcp_wire.ts";

test("built-in profiles describe ACP launch routes without vendor behavior", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await nodeFs.writeText(configPath, JSON.stringify({ agents: {} }));
    const agents = await loadAgents(configPath);
    if (
      agents.opencode.command !== "opencode" ||
      JSON.stringify(agents.opencode.args) !== JSON.stringify(["acp"])
    )
      throw new Error("OpenCode native ACP launch changed");
    if (
      agents["codex-acp"].command !== "codex-acp" ||
      agents["codex-acp"].args.length !== 0 ||
      agents["codex-acp"].env ||
      agents["codex-acp"].modelConfigId ||
      agents["codex-acp"].modelEnrichment ||
      agents["codex-acp"].failureClassifier
    )
      throw new Error("Codex profile is not a plain ACP adapter profile");
    if (
      agents["claude-acp"].command !== "claude-agent-acp" ||
      agents["claude-acp"].args.length !== 0 ||
      agents["claude-acp"].displayName !== "Claude Agent ACP" ||
      agents["claude-acp"].env ||
      JSON.stringify(agents["claude-acp"].protocolEnv?.v2) !==
        JSON.stringify({ CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "1" }) ||
      agents["claude-acp"].modelConfigId ||
      agents["claude-acp"].modelEnrichment ||
      agents["claude-acp"].failureClassifier
    )
      throw new Error("Claude profile is not a plain ACP adapter profile");
    const expectedAntigravityCommand =
      process.platform === "win32" ? "agy_acp_server" : "agy_acp_server.par";
    const expectedAntigravityArgs =
      process.platform === "linux" ? ["--uid="] : [];
    if (
      agents["antigravity-acp"].command !== expectedAntigravityCommand ||
      JSON.stringify(agents["antigravity-acp"].args) !==
        JSON.stringify(expectedAntigravityArgs) ||
      agents["antigravity-acp"].implementation !== "official" ||
      agents["antigravity-acp"].env ||
      agents["antigravity-acp"].modelConfigId ||
      agents["antigravity-acp"].modelEnrichment ||
      agents["antigravity-acp"].failureClassifier
    )
      throw new Error("Antigravity profile has unexpected special behavior");
    if (
      !agents["codex-acp"].installHint?.includes(
        "@agentclientprotocol/codex-acp",
      ) ||
      !agents["claude-acp"].installHint?.includes(
        "@agentclientprotocol/claude-agent-acp",
      ) ||
      !agents["claude-acp"].installHint?.includes("Node.js 22") ||
      !agents["antigravity-acp"].installHint?.includes(
        "Agent Client Protocol Registry",
      ) ||
      !agents["antigravity-acp"].installHint?.includes("absolute path")
    )
      throw new Error("Built-in profiles lack canonical install hints");
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("Antigravity implementation selection is explicit and profile-driven", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: { antigravity: { implementation: "refined" } },
      }),
    );
    const agents = await loadAgents(configPath);
    const refined = agents["antigravity-acp"];
    if (
      refined.implementation !== "refined" ||
      refined.command !== "refined-antigravity-acp" ||
      refined.args.length !== 0 ||
      refined.acpProtocol !== "v1" ||
      JSON.stringify(refined.supportedProtocols) !== JSON.stringify(["v1"]) ||
      refined.modelEnrichment !== undefined ||
      JSON.stringify(refined.requiredExecutableEnv) !==
        JSON.stringify(["REFINED_AGY_ACP_BIN"]) ||
      refined.runtimePrerequisites?.[0]?.command !== "node" ||
      refined.runtimePrerequisites[0]?.minimumVersion !== "22.0.0"
    )
      throw new Error("Refined selection did not load its distinct v1 profile");

    await nodeFs.writeText(
      configPath,
      JSON.stringify({ agents: { antigravity: { implementation: "other" } } }),
    );
    let rejected = false;
    try {
      await loadAgents(configPath);
    } catch (error) {
      rejected = String(error).includes(
        "implementation must be 'official', 'refined', or 'agy'",
      );
    }
    if (!rejected) {
      throw new Error("Invalid Antigravity implementation accepted");
    }

    await nodeFs.writeText(
      configPath,
      JSON.stringify({ agents: { antigravity: { implementation: "agy" } } }),
    );
    const agy = (await loadAgents(configPath))["antigravity-acp"];
    const localAppData = process.env["LOCALAPPDATA"];
    const expectedAgyCommand =
      process.platform === "win32" && process.arch === "x64" && localAppData
        ? `${localAppData}\\acp-mcp\\agents\\antigravity-agy\\1.2.0\\agy-acp-windows-x64.exe`
        : "agy-acp-windows-x64.exe";
    if (
      agy.implementation !== "agy" ||
      agy.command !== expectedAgyCommand ||
      agy.args.length !== 0 ||
      agy.acpProtocol !== "v1" ||
      JSON.stringify(agy.supportedProtocols) !== JSON.stringify(["v1"]) ||
      agy.modelConfigId !== "model" ||
      JSON.stringify(agy.requiredExecutableEnv) !==
        JSON.stringify(["AGY_BIN"]) ||
      agy.runtimePrerequisites?.length
    )
      throw new Error("agy selection did not load its pinned v1 profile");

    await nodeFs.writeText(
      configPath,
      JSON.stringify({ agents: { opencode: { implementation: "agy" } } }),
    );
    rejected = false;
    try {
      await loadAgents(configPath);
    } catch (error) {
      rejected = String(error).includes(
        "implementation is only valid for 'antigravity-acp'",
      );
    }
    if (!rejected) {
      throw new Error("Antigravity implementation selector leaked to OpenCode");
    }
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("agy Antigravity profile preserves overrides and validates AGY_BIN paths with spaces", async () => {
  const dir = await nodeFs.makeTempDir({ prefix: "acp agy profile " });
  const configPath = `${dir}/config.json`;
  const executable = `${dir}/fake agy${
    process.platform === "win32" ? ".exe" : ""
  }`;
  const adapter = `${dir}/fake agy adapter${
    process.platform === "win32" ? ".exe" : ""
  }`;
  try {
    await nodeFs.copyFile(process.execPath, executable);
    await nodeFs.copyFile(process.execPath, adapter);
    if (process.platform !== "win32") {
      await nodeFs.chmod(executable, 0o755);
      await nodeFs.chmod(adapter, 0o755);
    }
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: {
          antigravity: {
            implementation: "agy",
            command: adapter,
            args: ["argument with spaces"],
            env: { AGY_BIN: executable, ACP_MCP_PROFILE_TEST: "preserved" },
          },
        },
      }),
    );
    const definition = (await loadAgents(configPath))["antigravity-acp"];
    if (
      definition.implementation !== "agy" ||
      definition.command !== adapter ||
      JSON.stringify(definition.args) !==
        JSON.stringify(["argument with spaces"]) ||
      definition.env?.AGY_BIN !== executable ||
      definition.env.ACP_MCP_PROFILE_TEST !== "preserved" ||
      definition.requiredExecutableEnv?.[0] !== "AGY_BIN"
    ) {
      throw new Error(
        "agy user overrides did not compose with profile metadata",
      );
    }

    const started = await startAgent(
      {
        ...definition,
        args: [
          "-e",
          `process.exit(process.env["AGY_BIN"] === ${JSON.stringify(
            executable,
          )} && process.env["ACP_MCP_PROFILE_TEST"] === "preserved" ? 0 : 1)`,
        ],
      },
      dir,
    );
    const status = await started.child.status;
    await started.stderrDone;
    if (status.code !== 0) {
      throw new Error(
        "agy adapter/AGY_BIN paths containing spaces were not preserved at process launch",
      );
    }
    let rejected = false;
    try {
      await startAgent({ ...definition, env: { AGY_BIN: "" } }, dir);
    } catch (error) {
      rejected = String(error).includes("AGY_BIN");
    }
    if (!rejected) throw new Error("Missing AGY_BIN was not rejected");
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("refined Antigravity inherits generic profile overrides and requires an installed backend", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  const backend = process.execPath;
  try {
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: {
          antigravity: {
            implementation: "refined",
            command: backend,
            args: ["-e", "process.exit(0)"],
            env: { REFINED_AGY_ACP_BIN: backend, ACP_MCP_PROFILE_TEST: "yes" },
          },
        },
      }),
    );
    const definition = (await loadAgents(configPath))["antigravity-acp"];
    if (
      definition.implementation !== "refined" ||
      definition.command !== backend ||
      JSON.stringify(definition.args) !==
        JSON.stringify(["-e", "process.exit(0)"]) ||
      definition.env?.ACP_MCP_PROFILE_TEST !== "yes" ||
      definition.requiredExecutableEnv?.[0] !== "REFINED_AGY_ACP_BIN" ||
      definition.acpProtocol !== "v1"
    )
      throw new Error("User overrides lost refined profile metadata");

    const withoutBackend = {
      ...definition,
      env: { REFINED_AGY_ACP_BIN: "" },
    };
    let rejected = false;
    try {
      await startAgent(withoutBackend, dir);
    } catch (error) {
      rejected = String(error).includes("REFINED_AGY_ACP_BIN");
    }
    if (!rejected) throw new Error("Missing refined backend was not rejected");

    const process = await startAgent(definition, dir);
    const status = await process.child.status;
    await process.stderrDone;
    if (status.code !== 0) {
      throw new Error("Configured executable did not launch");
    }
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("list_agents identifies the explicitly selected agy implementation", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await nodeFs.writeText(
      configPath,
      JSON.stringify({ agents: { antigravity: { implementation: "agy" } } }),
    );
    const agents = await loadAgents(configPath);
    agents["antigravity-acp"].command = process.execPath;
    agents["antigravity-acp"].env = { AGY_BIN: process.execPath };
    const manager = new SessionManager(agents);
    const server = createMcpServer(agents, manager);
    const mcp = await connectMcp(server);
    try {
      const listedResponse = (await mcp.callTool("list_agents", {})
        .response) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const listedText = listedResponse.result?.content?.find(
        (item) => item.text,
      )?.text;
      if (!listedText) throw new Error("list_agents returned no result");
      const listed = JSON.parse(listedText) as Array<Record<string, unknown>>;
      const antigravity = listed.find(
        (entry) => entry.id === "antigravity-acp",
      );
      if (
        antigravity?.implementation !== "agy" ||
        antigravity.displayName !== "Antigravity (agy ACP)"
      )
        throw new Error("list_agents hid the selected agy implementation");
    } finally {
      await mcp.close();
      await manager.closeAll();
      await server.close();
    }
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("Claude profile accepts generic command, args, and env overrides", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  const override = {
    command: `${dir}/claude-agent.cmd`,
    args: ["--stdio"],
    env: { ACPMCP_TEST_PROVIDER_ENDPOINT: "https://provider.invalid/v1" },
  };
  try {
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: { claude: override },
      }),
    );
    const agents = await loadAgents(configPath);
    if (
      agents["claude-acp"].command !== override.command ||
      JSON.stringify(agents["claude-acp"].args) !==
        JSON.stringify(override.args) ||
      agents["claude-acp"].env?.ACPMCP_TEST_PROVIDER_ENDPOINT !==
        override.env.ACPMCP_TEST_PROVIDER_ENDPOINT ||
      agents["claude-acp"].protocolEnv?.v2?.CLAUDE_AGENT_ACP_EXPERIMENTAL_V2 !==
        "1"
    ) {
      throw new Error("Generic Claude override lost profile protocol metadata");
    }
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("ACP protocol config defaults to v1 and rejects invalid values", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: { custom: { command: "custom-agent" } },
      }),
    );
    const defaulted = await loadAgents(configPath);
    if (
      defaulted.custom.acpProtocol !== "v1" ||
      defaulted.custom.args.length !== 0 ||
      defaulted.custom.modelConfigId !== "model"
    ) {
      throw new Error("Omitted custom agent protocol did not default to v1");
    }
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: {
          custom: { command: "custom-agent", args: [], acpProtocol: "v3" },
        },
      }),
    );
    let rejected = false;
    try {
      await loadAgents(configPath);
    } catch (error) {
      rejected = String(error).includes("acpProtocol must be 'v1' or 'v2'");
    }
    if (!rejected) throw new Error("Invalid ACP protocol was accepted");
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("trusted config may override built-in launches and select ACP v2", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: {
          codex: {
            command: "replacement-codex-acp",
            args: ["--stdio", "arg with spaces"],
            env: { CUSTOM_ROUTE: "configured" },
          },
          custom_v2: {
            command: "custom-acp-v2",
            acpProtocol: "v2",
          },
        },
      }),
    );
    const agents = await loadAgents(configPath);
    if (
      agents["codex-acp"].command !== "replacement-codex-acp" ||
      agents["codex-acp"].args.join("|") !== "--stdio|arg with spaces" ||
      agents["codex-acp"].acpProtocol !== "v1" ||
      agents["codex-acp"].supportedProtocols?.join() !== "v1" ||
      agents.custom_v2.command !== "custom-acp-v2" ||
      agents.custom_v2.args.length !== 0 ||
      agents.custom_v2.acpProtocol !== "v2"
    ) {
      throw new Error(
        "Trusted launch override or explicit v2 selection failed",
      );
    }

    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: { "bad/id": { command: "bad" } },
      }),
    );
    let rejected = false;
    try {
      await loadAgents(configPath);
    } catch (error) {
      rejected = String(error).includes("agent ID 'bad/id'");
    }
    if (!rejected) throw new Error("Invalid custom agent ID was accepted");
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("executable discovery distinguishes present and missing commands", async () => {
  if (!(await findExecutablePath(process.execPath))) {
    throw new Error(
      "The running Node executable was not found by absolute path",
    );
  }
  const missing = await findExecutablePath(
    `acp-mcp-missing-${crypto.randomUUID()}`,
  );
  if (missing) {
    throw new Error(`Missing command resolved unexpectedly: ${missing}`);
  }

  if (process.platform === "win32") {
    const dir = await nodeFs.makeTempDir();
    const batch = `${dir}\\profile-agent.cmd`;
    try {
      await nodeFs.writeText(batch, "@echo off\r\nexit /b 0\r\n");
      const resolved = await findExecutablePath("profile-agent", dir);
      if (resolved?.toLowerCase() !== batch.toLowerCase()) {
        throw new Error(`Windows .cmd discovery failed: ${resolved}`);
      }
    } finally {
      await nodeFs.removePath(dir, { recursive: true });
    }
  }
});

test("list_agents reports command presence without implying authentication", async () => {
  const dir = await nodeFs.makeTempDir();
  const separator = process.platform === "win32" ? "\\" : "/";
  const found = `${dir}${separator}present${
    process.platform === "win32" ? ".cmd" : ".sh"
  }`;
  const missing = `${dir}${separator}missing${
    process.platform === "win32" ? ".exe" : ""
  }`;
  try {
    if (process.platform === "win32") {
      await nodeFs.writeText(found, "@echo off\r\nexit /b 0\r\n");
    } else {
      await nodeFs.writeText(found, "#!/bin/sh\nexit 0\n");
      await nodeFs.chmod(found, 0o755);
    }
    const agents = {
      present: { command: found, args: [], displayName: "Present" },
      missing: {
        command: missing,
        args: [],
        displayName: "Missing",
        installHint: "Install the missing ACP agent.",
      },
    };
    const manager = new SessionManager(agents);
    const server = createMcpServer(agents, manager);
    const mcp = await connectMcp(server);
    try {
      const reply = await mcp.callTool("list_agents", {}).response;
      let rows: unknown;
      try {
        rows = parseToolResult(reply);
      } catch (error) {
        throw new Error(
          `${String(error)}; MCP reply: ${JSON.stringify(reply)}`,
        );
      }
      if (!Array.isArray(rows)) {
        throw new Error("list_agents did not return a list");
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (byId.get("present")?.commandFound !== true) {
        throw new Error("Present executable was not reported");
      }
      if (byId.get("present")?.acpProtocol !== "v1") {
        throw new Error("list_agents omitted the effective ACP protocol");
      }
      if (
        byId.get("missing")?.commandFound !== false ||
        byId.get("missing")?.installHint !== "Install the missing ACP agent."
      )
        throw new Error("Missing executable was not clearly reported");
    } finally {
      await mcp.close();
      await manager.closeAll();
      await server.close();
    }
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("Codex, Claude, and Antigravity use generic ACP discovery and failures", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  await nodeFs.writeText(
    configPath,
    JSON.stringify({ agents: { antigravity: { implementation: "refined" } } }),
  );
  const agents = await loadAgents(configPath);
  const fixtureArgs = [
    "tests/fixtures/fake_acp_agent.ts",
    "--advertise-models",
  ];
  for (const id of ["codex-acp", "claude-acp", "antigravity-acp"]) {
    agents[id] = {
      ...agents[id],
      command: process.execPath,
      args: fixtureArgs,
      ...(id === "antigravity-acp"
        ? { env: { REFINED_AGY_ACP_BIN: process.execPath } }
        : {}),
    };
  }
  const manager = new SessionManager(agents);
  const server = createMcpServer(agents, manager);
  const mcp = await connectMcp(server);
  try {
    const listed: unknown = parseToolResult(
      await mcp.callTool("list_agents", {}).response,
    );
    if (!Array.isArray(listed)) {
      throw new Error("list_agents did not return a list");
    }
    const antigravity = listed.find((row) => row.id === "antigravity-acp");
    if (
      antigravity?.implementation !== "refined" ||
      antigravity.displayName !== "Antigravity (Refined)"
    )
      throw new Error("list_agents did not expose the selected implementation");
    for (const agentId of ["codex-acp", "claude-acp", "antigravity-acp"]) {
      const discovery = parseToolResult(
        await mcp.callTool("list_models", {
          agentId,
          enrich: true,
        }).response,
      );
      const models = discovery.models as Array<Record<string, unknown>>;
      if (
        discovery.status !== "completed" ||
        !models.some((model) => model.id === "opencode/fledge-alpha-free") ||
        (discovery.enrichment as Record<string, unknown>)?.status !==
          "not_supported"
      ) {
        throw new Error(
          `${agentId} did not use generic ACP model semantics: ${JSON.stringify(
            discovery,
          )}`,
        );
      }
      if (
        agentId === "antigravity-acp" &&
        JSON.stringify(models.map((model) => model.id).sort()) !==
          JSON.stringify([
            "opencode/available-without-metadata",
            "opencode/fledge-alpha-free",
            "opencode/paid-model",
          ])
      ) {
        throw new Error(
          "Refined profile discovery added models not advertised by the ACP fixture",
        );
      }
      if (
        agentId === "antigravity-acp" &&
        agents["antigravity-acp"].implementation !== "refined"
      )
        throw new Error("Refined profile selection was not retained");
      const failure = parseToolResult(
        await mcp.callTool("run_task", {
          agentId,
          task: "rate limit failure",
        }).response,
      );
      const error = failure.error as Record<string, unknown>;
      if (
        failure.status !== "failed" ||
        error.kind !== "prompt_failed" ||
        error.acpCode !== -32603 ||
        "classification" in error
      )
        throw new Error(`${agentId} did not keep generic failure semantics`);
    }
    if (manager.sessionCount) {
      throw new Error("Compatibility fixture leaked a session");
    }
  } finally {
    await mcp.close();
    await manager.closeAll();
    await server.close();
    await nodeFs.removePath(dir, { recursive: true });
  }
});
