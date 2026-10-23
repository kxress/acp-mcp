import { test } from "node:test";
import * as nodeFs from "#fs";
import { loadAgents } from "../src/agents/config.ts";

interface ExpectedProfile {
  id: string;
  command: string;
  args: string[];
  displayName: string;
  env?: Record<string, string>;
}

const REGISTRY_PROFILES: Array<ExpectedProfile> = [
  {
    id: "agoragentic",
    command: "agoragentic-mcp",
    args: ["--acp"],
    displayName: "Agoragentic",
  },
  { id: "amp", command: "amp-acp", args: [], displayName: "Amp" },
  {
    id: "auggie",
    command: "auggie",
    args: ["--acp"],
    displayName: "Auggie CLI",
  },
  {
    id: "autohand",
    command: "autohand-acp",
    args: [],
    displayName: "Autohand Code",
  },
  { id: "bob", command: "bob", args: ["acp"], displayName: "Bob" },
  { id: "command-code", command: "cmd", args: ["acp"], displayName: "Command Code" },
  { id: "cline", command: "cline", args: ["--acp"], displayName: "Cline" },
  {
    id: "codebuddy",
    command: "codebuddy",
    args: ["--acp"],
    displayName: "Codebuddy Code",
  },
  {
    id: "cortex",
    command: "cortex",
    args: ["acp", "serve"],
    displayName: "Cortex Code",
  },
  {
    id: "corust",
    command: "corust-agent-acp",
    args: [],
    displayName: "Corust Agent",
  },
  {
    id: "crow-cli",
    command: "crow-cli",
    args: ["acp"],
    displayName: "crow-cli",
  },
  {
    id: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    displayName: "Cursor",
  },
  {
    id: "deepagents",
    command: "deepagents-acp",
    args: [],
    displayName: "DeepAgents",
  },
  { id: "devin", command: "devin", args: ["acp"], displayName: "Devin" },
  { id: "dimcode", command: "dimcode", args: ["acp"], displayName: "DimCode" },
  { id: "dirac", command: "dirac", args: ["--acp"], displayName: "Dirac" },
  {
    id: "factory-droid",
    command: "droid",
    args: ["exec", "--output-format", "acp-daemon"],
    displayName: "Factory Droid",
  },
  {
    id: "fast-agent",
    command: "fast-agent",
    args: ["-x"],
    displayName: "fast-agent",
    env: { FAST_AGENT_MODEL: "codexplan" },
  },
  {
    id: "gemini",
    command: "gemini",
    args: ["--acp"],
    displayName: "Gemini CLI",
  },
  {
    id: "github-copilot",
    command: "copilot-language-server",
    args: ["--acp"],
    displayName: "Copilot",
  },
  {
    id: "github-copilot-cli",
    command: "copilot",
    args: ["--acp"],
    displayName: "Copilot CLI",
  },
  { id: "glm", command: "glm-acp-agent", args: [], displayName: "GLM Agent" },
  { id: "goose", command: "goose", args: ["acp"], displayName: "goose" },
  {
    id: "grok-build",
    command: "grok",
    args: ["agent", "stdio"],
    displayName: "Grok Build",
  },
  { id: "harn", command: "harn", args: ["serve", "acp"], displayName: "Harn" },
  { id: "junie", command: "junie", args: ["--acp=true"], displayName: "Junie" },
  { id: "kilo", command: "kilo", args: ["acp"], displayName: "Kilo" },
  {
    id: "kimchi",
    command: "kimchi",
    args: ["--mode", "acp"],
    displayName: "Kimchi",
  },
  { id: "kimi", command: "kimi", args: ["acp"], displayName: "Kimi CLI" },
  {
    id: "minimax",
    command: "mcode",
    args: ["acp"],
    displayName: "MiniMax Code",
  },
  {
    id: "minion-code",
    command: "minion-code",
    args: ["acp"],
    displayName: "Minion Code",
  },
  {
    id: "mistral-vibe",
    command: "vibe-acp",
    args: [],
    displayName: "Mistral Vibe",
  },
  { id: "nova", command: "nova", args: ["acp"], displayName: "Nova" },
  {
    id: "opencode-v2",
    command: "opencode",
    args: ["acp"],
    displayName: "OpenCode V2",
  },
  { id: "pi", command: "pi-acp", args: [], displayName: "pi ACP" },
  { id: "poolside", command: "pool", args: ["acp"], displayName: "Poolside" },
  {
    id: "qoder",
    command: "qodercli",
    args: ["--acp"],
    displayName: "Qoder CLI",
  },
  {
    id: "qwen",
    command: "qwen",
    args: ["--acp", "--experimental-skills"],
    displayName: "Qwen Code",
  },
  { id: "sigit", command: "sigit", args: [], displayName: "siGit Code" },
  { id: "stakpak", command: "stakpak", args: ["acp"], displayName: "Stakpak" },
  { id: "vtcode", command: "vtcode", args: ["acp"], displayName: "VT Code" },
];

test("built-in agents cover every ACP registry agent with launch-only profiles", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await nodeFs.writeText(configPath, JSON.stringify({ agents: {} }));
    const agents = await loadAgents(configPath);

    const ids = new Set(Object.keys(agents));
    const missing = REGISTRY_PROFILES.filter((p) => !ids.has(p.id));
    if (missing.length > 0) {
      throw new Error(
        `Missing built-in profiles for registry agents: ${missing.map((p) => p.id).join(", ")}`,
      );
    }

    for (const profile of REGISTRY_PROFILES) {
      const agent = agents[profile.id];
      const label = profile.id;
      if (agent.command !== profile.command) {
        throw new Error(`${label} command mismatch: ${agent.command}`);
      }
      if (JSON.stringify(agent.args) !== JSON.stringify(profile.args)) {
        throw new Error(
          `${label} args mismatch: ${JSON.stringify(agent.args)}`,
        );
      }
      if (agent.displayName !== profile.displayName) {
        throw new Error(`${label} displayName mismatch: ${agent.displayName}`);
      }
      if (!agent.installHint || agent.installHint.length < 20) {
        throw new Error(`${label} lacks an install hint`);
      }
      if (agent.modelEnrichment || agent.failureClassifier) {
        throw new Error(`${label} unexpectedly owns vendor behavior`);
      }
      if (agent.implementation) {
        throw new Error(`${label} unexpectedly pins an implementation`);
      }
      const requiredProtocol = profile.id === "opencode-v2" ? "v2" : "v1";
      if (!agent.supportedProtocols?.includes(requiredProtocol)) {
        throw new Error(
          `${label} must confirm ACP ${requiredProtocol} support`,
        );
      }
      const expectedEnv = profile.env ?? {};
      if (JSON.stringify(agent.env ?? {}) !== JSON.stringify(expectedEnv)) {
        throw new Error(
          `${label} env mismatch: ${JSON.stringify(agent.env ?? {})}`,
        );
      }
    }

    if (agents["opencode-v2"].supportedProtocols?.includes("v1")) {
      throw new Error("OpenCode V2 profile must not claim v1 support");
    }
    if (agents["opencode-v2"].acpProtocol !== "v2") {
      throw new Error("OpenCode V2 profile must default to ACP v2");
    }
    if (agents.opencode.acpProtocol && agents.opencode.acpProtocol !== "v1") {
      throw new Error("OpenCode profile must default to ACP v1");
    }
    if (!agents.opencode.modelConfigId || !agents.opencode.modelEnrichment) {
      throw new Error("OpenCode profile lost its model enrichment integration");
    }
    if (agents["mistral-vibe"].command !== "vibe-acp") {
      throw new Error("Mistral Vibe profile launch command changed");
    }
    if (
      !agents["mistral-vibe"].installHint?.includes("mistralai/mistral-vibe")
    ) {
      throw new Error("Mistral Vibe profile must point at official releases");
    }
    const expectedCommandCodeCommand =
      process.platform === "win32" ? "cmdc" : "cmd";
    if (agents["command-code"].command !== expectedCommandCodeCommand) {
      throw new Error(
        "Command Code profile must use the platform-correct alias",
      );
    }
    if (
      agents["command-code"].runtimePrerequisites?.[0]?.command !== "node" ||
      agents["command-code"].runtimePrerequisites[0]?.minimumVersion !== "22.0.0"
    ) {
      throw new Error("Command Code profile must require Node.js 22+");
    }
    if (agents.opencode === agents["opencode-v2"]) {
      throw new Error("OpenCode V2 must be a distinct profile from OpenCode");
    }
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});

test("registry profiles stay overridable per agent", async () => {
  const dir = await nodeFs.makeTempDir();
  const configPath = `${dir}/config.json`;
  try {
    await nodeFs.writeText(
      configPath,
      JSON.stringify({
        agents: {
          gemini: { command: "gemini-custom", args: ["--acp", "--custom"] },
          "crow-cli": { installHint: "Local crow build." },
        },
      }),
    );
    const agents = await loadAgents(configPath);
    const gemini = agents.gemini;
    if (
      gemini.command !== "gemini-custom" ||
      JSON.stringify(gemini.args) !== JSON.stringify(["--acp", "--custom"]) ||
      gemini.displayName !== "Gemini CLI"
    ) {
      throw new Error("Gemini override did not preserve the profile identity");
    }
    if (agents["crow-cli"].installHint !== "Local crow build.") {
      throw new Error("crow-cli install hint override was ignored");
    }
    if (agents.auggie.command !== "auggie") {
      throw new Error("Unrelated registry profiles were affected");
    }
  } finally {
    await nodeFs.removePath(dir, { recursive: true });
  }
});
