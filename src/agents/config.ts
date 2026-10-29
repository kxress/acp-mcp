import process from "node:process";
import * as nodeFs from "#fs";
import {
  type AgentModelPolicy,
  validateModelPolicy,
} from "../models/policy.ts";
import { registryAgentProfiles } from "./registry_profiles.ts";

export interface AgentDefinition {
  command: string;
  args: string[];
  /** Built-in Antigravity implementation selector; omitted means official. */
  implementation?: "official" | "refined" | "agy";
  acpProtocol?: "v1" | "v2";
  /** Protocols confirmed for this maintained profile; custom agents may omit it. */
  supportedProtocols?: Array<"v1" | "v2">;
  /** Protocol-specific launch environment supplied by a maintained profile. */
  protocolEnv?: Partial<Record<"v1" | "v2", Record<string, string>>>;
  displayName?: string;
  installHint?: string;
  env?: Record<string, string>;
  modelConfigId?: string;
  modelEnrichment?: "opencode_catalog";
  failureClassifier?: string;
  /** Trusted local requirements owned by the selected built-in profile. */
  runtimePrerequisites?: Array<{
    command: string;
    minimumVersion?: string;
  }>;
  /** Environment values which must resolve to executable files before launch. */
  requiredExecutableEnv?: string[];
  models?: AgentModelPolicy;
}

export type AgentMap = Record<string, AgentDefinition>;

// Keep these legacy IDs for this transition release; remove them next release.
const DEPRECATED_AGENT_ID_ALIASES = new Map([
  ["codex", "codex-acp"],
  ["claude", "claude-acp"],
  ["antigravity", "antigravity-acp"],
]);

export function canonicalAgentId(agentId: string): string {
  return DEPRECATED_AGENT_ID_ALIASES.get(agentId) ?? agentId;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const ANTIGRAVITY_AGY_ACP_RELEASE = {
  version: "1.2.0",
  revision: "d10aa13c932236ef241863f2c8b3afdda2a2be12",
  target: "windows-x86_64",
  asset: "agy-acp-windows-x64.exe",
  url: "https://github.com/shubzkothekar/antigravity-acp/releases/download/v1.2.0/agy-acp-windows-x64.exe",
  sha256: "fe7515f0e7de51e09f9c8b2c70c6c4ec2a9bd9f08850c21ba86a1fcbe8ff7074",
} as const;

export function antigravityAgyAcpInstallPath(
  localAppData = process.env["LOCALAPPDATA"],
): string {
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set; pass an explicit agent command");
  }
  return `${localAppData}\\acp-mcp\\agents\\antigravity-agy\\${ANTIGRAVITY_AGY_ACP_RELEASE.version}\\${ANTIGRAVITY_AGY_ACP_RELEASE.asset}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function defaultConfigPath(): string {
  const home =
    process.platform === "win32"
      ? process.env["USERPROFILE"]
      : process.env["HOME"];
  if (!home) {
    throw new Error(
      `${process.platform === "win32" ? "USERPROFILE" : "HOME"} is not set`,
    );
  }
  return `${home}${process.platform === "win32" ? "\\" : "/"}.acp-mcp.json`;
}

export function builtInAgents(): AgentMap {
  const antigravityCommand =
    process.platform === "win32" ? "agy_acp_server" : "agy_acp_server.par";
  const agents = Object.assign(
    Object.create(null) as AgentMap,
    registryAgentProfiles(),
    {
      opencode: {
        command: "opencode",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "OpenCode",
        installHint:
          "Install OpenCode and authenticate with opencode auth login.",
        modelConfigId: "model",
        modelEnrichment: "opencode_catalog",
        failureClassifier: "opencode",
      },
      "codex-acp": {
        command: "codex-acp",
        args: [],
        supportedProtocols: ["v1"],
        displayName: "Codex",
        installHint:
          "Install globally with npm install -g @agentclientprotocol/codex-acp, or explicitly configure npx -y @agentclientprotocol/codex-acp. CODEX_PATH can select another Codex executable.",
      },
      "claude-acp": {
        command: "claude-agent-acp",
        args: [],
        supportedProtocols: ["v1", "v2"],
        runtimePrerequisites: [{ command: "node", minimumVersion: "22.0.0" }],
        protocolEnv: {
          v2: { CLAUDE_AGENT_ACP_EXPERIMENTAL_V2: "1" },
        },
        displayName: "Claude Agent ACP",
        installHint:
          "Install Node.js 22 or later, then install the official adapter with npm install -g @agentclientprotocol/claude-agent-acp. Configure command, args, or env in the acp-mcp agent config for a user-local installation or provider setup.",
      },
      "antigravity-acp": {
        command: antigravityCommand,
        args: process.platform === "linux" ? ["--uid="] : [],
        implementation: "official",
        supportedProtocols: ["v1"],
        displayName: "Antigravity",
        installHint:
          "Install Google Antigravity ACP from the official Agent Client Protocol Registry. Configure the executable's absolute path in the acp-mcp agent config (Windows: agy_acp_server.exe); changing PATH is not required.",
      },
    },
  );
  return agents;
}

function antigravityProfiles(
  agents: AgentMap,
): Record<"official" | "refined" | "agy", AgentDefinition> {
  const localAppData =
    process.platform === "win32" ? process.env["LOCALAPPDATA"] : undefined;
  const agyAcpCommand =
    process.platform === "win32" && process.arch === "x64" && localAppData
      ? antigravityAgyAcpInstallPath(localAppData)
      : "agy-acp-windows-x64.exe";
  return {
    official: agents["antigravity-acp"],
    refined: {
      command: "refined-antigravity-acp",
      args: [],
      implementation: "refined",
      supportedProtocols: ["v1"],
      displayName: "Antigravity (Refined)",
      installHint:
        "Install @simonepri/refined-antigravity-acp and Node.js 22 or later. Set env.REFINED_AGY_ACP_BIN to the absolute path of an already-installed official agy_acp_server executable; this prevents the wrapper from downloading its backend during startup.",
      runtimePrerequisites: [{ command: "node", minimumVersion: "22.0.0" }],
      requiredExecutableEnv: ["REFINED_AGY_ACP_BIN"],
    },
    agy: {
      command: agyAcpCommand,
      args: [],
      implementation: "agy",
      supportedProtocols: ["v1"],
      displayName: "Antigravity (agy ACP)",
      installHint:
        "Provision the pinned Windows x64 adapter with 'npm run provision:antigravity-agy'. Set env.AGY_BIN to an existing agy executable; the adapter skips downloads when AGY_BIN is supplied.",
      modelConfigId: "model",
      requiredExecutableEnv: ["AGY_BIN"],
    },
  };
}

export function parseAgentConfig(
  parsed: unknown,
  path = "<configuration>",
): AgentMap {
  const agents = Object.assign(
    Object.create(null) as AgentMap,
    builtInAgents(),
  );
  if (!isRecord(parsed)) {
    throw new Error(`Config file '${path}' must contain a JSON object`);
  }
  if (parsed.agents === undefined) return agents;
  if (!isRecord(parsed.agents)) {
    throw new Error(`Config file '${path}' must contain an 'agents' object`);
  }

  const antigravityImplementations = antigravityProfiles(agents);
  const configuredAgentIds = new Map<string, string>();
  for (const [id, rawDefinition] of Object.entries(parsed.agents)) {
    if (!isRecord(rawDefinition)) {
      throw new Error(
        `Config file '${path}': agent '${id}' must be a JSON object`,
      );
    }
    const def = rawDefinition as Partial<AgentDefinition>;
    if (!AGENT_ID_PATTERN.test(id)) {
      throw new Error(
        `Config file '${path}': agent ID '${id}' must match ${AGENT_ID_PATTERN}`,
      );
    }
    const canonicalId = canonicalAgentId(id);
    const existingId = configuredAgentIds.get(canonicalId);
    if (existingId !== undefined) {
      throw new Error(
        `Config file '${path}': agents.${existingId} and agents.${id} both configure '${canonicalId}'; use only the canonical ID`,
      );
    }
    configuredAgentIds.set(canonicalId, id);
    if (def.implementation !== undefined) {
      if (canonicalId !== "antigravity-acp") {
        throw new Error(
          `Config file '${path}': agent '${id}' implementation is only valid for 'antigravity-acp'`,
        );
      }
      if (
        def.implementation !== "official" &&
        def.implementation !== "refined" &&
        def.implementation !== "agy"
      ) {
        throw new Error(
          `Config file '${path}': agent 'antigravity-acp' implementation must be 'official', 'refined', or 'agy'`,
        );
      }
    }
    const builtIn =
      canonicalId === "antigravity-acp"
        ? antigravityImplementations[def.implementation ?? "official"]
        : Object.hasOwn(agents, canonicalId)
          ? agents[canonicalId]
          : undefined;
    if (
      def.command !== undefined &&
      (typeof def.command !== "string" || !def.command.trim())
    ) {
      throw new Error(
        `Config file '${path}': agent '${id}' command must be a non-empty string`,
      );
    }
    if (def.command === undefined && !builtIn) {
      throw new Error(
        `Config file '${path}': agent '${id}' command must be a non-empty string`,
      );
    }
    const command = def.command ?? builtIn?.command;
    if (command === undefined) {
      throw new Error(
        `Config file '${path}': agent '${id}' command must be a non-empty string`,
      );
    }
    if (
      def.args !== undefined &&
      (!Array.isArray(def.args) ||
        !def.args.every((x) => typeof x === "string"))
    ) {
      throw new Error(
        `Config file '${path}': agent '${id}' args must be an array of strings`,
      );
    }
    if (def.env !== undefined) {
      if (!isRecord(def.env)) {
        throw new Error(
          `Config file '${path}': agent '${id}' env must be an object of string values`,
        );
      }
      for (const [name, value] of Object.entries(def.env)) {
        if (typeof value !== "string") {
          throw new Error(
            `Config file '${path}': agent '${id}' env value for '${name}' must be a string`,
          );
        }
      }
    }
    if (
      def.acpProtocol !== undefined &&
      def.acpProtocol !== "v1" &&
      def.acpProtocol !== "v2"
    ) {
      throw new Error(
        `Config file '${path}': agent '${id}' acpProtocol must be 'v1' or 'v2'`,
      );
    }
    const models =
      def.models === undefined
        ? builtIn?.models
        : validateModelPolicy(def.models, canonicalId, path);
    agents[canonicalId] = {
      ...builtIn,
      ...rawDefinition,
      command,
      args: def.args ?? builtIn?.args ?? [],
      models,
      env: { ...builtIn?.env, ...def.env },
      modelConfigId:
        def.modelConfigId ??
        builtIn?.modelConfigId ??
        (builtIn ? undefined : "model"),
      supportedProtocols: builtIn?.supportedProtocols ?? def.supportedProtocols,
      protocolEnv: builtIn?.protocolEnv ?? def.protocolEnv,
      acpProtocol: def.acpProtocol ?? builtIn?.acpProtocol ?? "v1",
      implementation: builtIn?.implementation,
      runtimePrerequisites: builtIn?.runtimePrerequisites,
      requiredExecutableEnv: builtIn?.requiredExecutableEnv,
    };
  }
  return agents;
}

export async function loadAgents(configPath?: string): Promise<AgentMap> {
  if (configPath === undefined) return builtInAgents();
  const path = configPath;
  let text: string;
  try {
    text = await nodeFs.readText(path);
  } catch (error) {
    if (nodeFs.isErrorCode(error, "ENOENT")) {
      throw new Error(`Explicit config file does not exist: ${path}`);
    }
    throw new Error(`Could not read config file '${path}': ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Config file '${path}' is not valid JSON`);
  }
  return parseAgentConfig(parsed, path);
}
