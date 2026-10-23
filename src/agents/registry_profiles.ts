import type { AgentMap } from "./config.ts";

/**
 * Agent profiles sourced from the Agent Client Protocol registry
 * (https://agentclientprotocol.com/get-started/registry).
 *
 * Each profile mirrors the registry's `agent.json` distribution entry: the
 * launch command is the binary the registry documents for that distribution
 * channel (npx package bin, uvx entry point, or standalone binary), and the
 * install hint names the registry package or release archive. The profiles are
 * launch descriptions only; behavior, protocol conformance, and authentication
 * remain owned by each downstream agent.
 */

const NPM_PACKAGES: Record<string, { pkg: string; bin: string }> = {
  agoragentic: { pkg: "agoragentic-mcp", bin: "agoragentic-mcp" },
  auggie: { pkg: "@augmentcode/auggie", bin: "auggie" },
  autohand: { pkg: "@autohandai/autohand-acp", bin: "autohand-acp" },
  bob: { pkg: "@ibm/bob", bin: "bob" },
  cline: { pkg: "cline", bin: "cline" },
  codebuddy: { pkg: "@tencent-ai/codebuddy-code", bin: "codebuddy" },
  deepagents: { pkg: "deepagents-acp", bin: "deepagents-acp" },
  dimcode: { pkg: "dimcode", bin: "dimcode" },
  dirac: { pkg: "dirac-cli", bin: "dirac" },
  "factory-droid": { pkg: "droid", bin: "droid" },
  gemini: { pkg: "@google/gemini-cli", bin: "gemini" },
  "github-copilot": {
    pkg: "@github/copilot-language-server",
    bin: "copilot-language-server",
  },
  "github-copilot-cli": { pkg: "@github/copilot", bin: "copilot" },
  glm: { pkg: "glm-acp-agent", bin: "glm-acp-agent" },
  "grok-build": { pkg: "@xai-official/grok", bin: "grok" },
  kilo: { pkg: "@kilocode/cli", bin: "kilo" },
  minimax: { pkg: "@minimax-ai/code", bin: "mcode" },
  nova: { pkg: "@compass-ai/nova", bin: "nova" },
  pi: { pkg: "pi-acp", bin: "pi-acp" },
  qoder: { pkg: "@qoder-ai/qodercli", bin: "qodercli" },
  qwen: { pkg: "@qwen-code/qwen-code", bin: "qwen" },
  sigit: { pkg: "@smbcloud/sigit", bin: "sigit" },
};

export function registryAgentProfiles(): AgentMap {
  const agents = Object.assign(
    Object.create(null) as AgentMap,
    {
      agoragentic: {
        command: NPM_PACKAGES.agoragentic.bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Agoragentic",
        installHint: `Install with npm install -g ${NPM_PACKAGES.agoragentic.pkg}, or run npx -y ${NPM_PACKAGES.agoragentic.pkg} --acp. Requires an Agoragentic account and USDC balance on Base.`,
      },
      amp: {
        command: "amp-acp",
        args: [],
        supportedProtocols: ["v1"],
        displayName: "Amp",
        installHint:
          "Install the Amp ACP adapter binary from https://github.com/agentclientprotocol/registry (amp-acp) and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires Amp authentication.",
      },
      auggie: {
        command: NPM_PACKAGES.auggie.bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Auggie CLI",
        installHint: `Install with npm install -g ${NPM_PACKAGES.auggie.pkg}, or run npx -y ${NPM_PACKAGES.auggie.pkg} --acp. Requires Augment Code authentication.`,
      },
      autohand: {
        command: NPM_PACKAGES.autohand.bin,
        args: [],
        supportedProtocols: ["v1"],
        displayName: "Autohand Code",
        installHint: `Install with npm install -g ${NPM_PACKAGES.autohand.pkg}, or run npx -y ${NPM_PACKAGES.autohand.pkg}. Requires Autohand AI authentication.`,
      },
      bob: {
        command: NPM_PACKAGES.bob.bin,
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Bob",
        installHint: `Install with npm install -g ${NPM_PACKAGES.bob.pkg}, or run npx -y ${NPM_PACKAGES.bob.pkg} acp. Requires IBM watsonx Orchestrate authentication.`,
      },
      "command-code": {
      command: process.platform === "win32" ? "cmdc" : "cmd",
      args: ["acp"],
      supportedProtocols: ["v1"],
      displayName: "Command Code",
      runtimePrerequisites: [{ command: "node", minimumVersion: "22.0.0" }],
      installHint:
        "Install Node.js 22 or later, then npm install -g command-code. Authenticate once with cmd login in a terminal, or set COMMAND_CODE_API_KEY for headless use. The ACP server is 'cmd acp' (native Windows alias: cmdc acp; the full name command-code works everywhere). If 'cmd acp' exits with 'the acp mod is disabled', remove 'acp' from mods.disabled in Command Code settings.",
    },
    cline: {
        command: NPM_PACKAGES.cline.bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Cline",
        installHint: `Install with npm install -g ${NPM_PACKAGES.cline.pkg}, or run npx -y ${NPM_PACKAGES.cline.pkg} --acp. Configure provider API keys via Cline settings.`,
      },
      codebuddy: {
        command: NPM_PACKAGES.codebuddy.bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Codebuddy Code",
        installHint: `Install with npm install -g ${NPM_PACKAGES.codebuddy.pkg}, or run npx -y ${NPM_PACKAGES.codebuddy.pkg} --acp. Requires Tencent Cloud authentication.`,
      },
      cortex: {
        command: "cortex",
        args: ["acp", "serve"],
        supportedProtocols: ["v1"],
        displayName: "Cortex Code",
        installHint:
          "Install the Cortex Code binary from https://github.com/agentclientprotocol/registry (coco release archive) and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires Snowflake authentication.",
      },
      corust: {
        command: "corust-agent-acp",
        args: [],
        supportedProtocols: ["v1"],
        displayName: "Corust Agent",
        installHint:
          "Install the corust-agent-acp binary from https://github.com/agentclientprotocol/registry and add its directory to PATH; configure the absolute path in the acp-mcp agent config.",
      },
      "crow-cli": {
        command: "crow-cli",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "crow-cli",
        installHint:
          "Install the crow-cli binary from https://github.com/agentclientprotocol/registry and add its directory to PATH; configure the absolute path in the acp-mcp agent config.",
      },
      cursor: {
        command: "cursor-agent",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Cursor",
        installHint:
          "Install cursor-agent from the Cursor agent release (dist-package/cursor-agent) and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires Cursor authentication.",
      },
      deepagents: {
        command: NPM_PACKAGES.deepagents.bin,
        args: [],
        supportedProtocols: ["v1"],
        displayName: "DeepAgents",
        installHint: `Install with npm install -g ${NPM_PACKAGES.deepagents.pkg}, or run npx -y ${NPM_PACKAGES.deepagents.pkg}.`,
      },
      devin: {
        command: "devin",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Devin",
        installHint:
          "Install the Devin CLI binary from https://github.com/agentclientprotocol/registry (bin/devin) and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires Cognition authentication.",
      },
      dimcode: {
        command: NPM_PACKAGES.dimcode.bin,
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "DimCode",
        installHint: `Install with npm install -g ${NPM_PACKAGES.dimcode.pkg}, or run npx -y ${NPM_PACKAGES.dimcode.pkg} acp. Requires provider authentication.`,
      },
      dirac: {
        command: NPM_PACKAGES.dirac.bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Dirac",
        installHint: `Install with npm install -g ${NPM_PACKAGES.dirac.pkg}, or run npx -y ${NPM_PACKAGES.dirac.pkg} --acp. Requires provider authentication.`,
      },
      "factory-droid": {
        command: NPM_PACKAGES["factory-droid"].bin,
        args: ["exec", "--output-format", "acp-daemon"],
        supportedProtocols: ["v1"],
        displayName: "Factory Droid",
        installHint: `Install with npm install -g ${NPM_PACKAGES["factory-droid"].pkg}, or run npx -y ${NPM_PACKAGES["factory-droid"].pkg} exec --output-format acp-daemon. Requires Factory AI authentication.`,
      },
      "fast-agent": {
        command: "fast-agent",
        args: ["-x"],
        supportedProtocols: ["v1"],
        displayName: "fast-agent",
        env: { FAST_AGENT_MODEL: "codexplan" },
        installHint:
          "Install with uvx (pipx or uv tool install fast-agent-acp), then ensure the fast-agent entry point is on PATH; configure the absolute path in the acp-mcp agent config. Requires a configured fast-agent model provider.",
      },
      gemini: {
        command: NPM_PACKAGES.gemini.bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Gemini CLI",
        installHint: `Install with npm install -g ${NPM_PACKAGES.gemini.pkg}, or run npx -y ${NPM_PACKAGES.gemini.pkg} --acp. Requires Google account or API key authentication.`,
      },
      "github-copilot": {
        command: NPM_PACKAGES["github-copilot"].bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Copilot",
        installHint: `Install with npm install -g ${NPM_PACKAGES["github-copilot"].pkg}, or run npx -y ${NPM_PACKAGES["github-copilot"].pkg} --acp. Requires GitHub Copilot authentication.`,
      },
      "github-copilot-cli": {
        command: NPM_PACKAGES["github-copilot-cli"].bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Copilot CLI",
        installHint: `Install with npm install -g ${NPM_PACKAGES["github-copilot-cli"].pkg}, or run npx -y ${NPM_PACKAGES["github-copilot-cli"].pkg} --acp. Requires GitHub Copilot authentication.`,
      },
      glm: {
        command: NPM_PACKAGES.glm.bin,
        args: [],
        supportedProtocols: ["v1"],
        displayName: "GLM Agent",
        installHint: `Install with npm install -g ${NPM_PACKAGES.glm.pkg}, or run npx -y ${NPM_PACKAGES.glm.pkg}. Requires Zhipu AI GLM Coding Plan credentials.`,
      },
      goose: {
        command: "goose",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "goose",
        installHint:
          "Install goose from https://github.com/block/goose releases and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires goose provider configuration.",
      },
      "grok-build": {
        command: NPM_PACKAGES["grok-build"].bin,
        args: ["agent", "stdio"],
        supportedProtocols: ["v1"],
        displayName: "Grok Build",
        installHint: `Install with npm install -g ${NPM_PACKAGES["grok-build"].pkg}, or run npx -y ${NPM_PACKAGES["grok-build"].pkg} agent stdio. Requires xAI authentication.`,
      },
      harn: {
        command: "harn",
        args: ["serve", "acp"],
        supportedProtocols: ["v1"],
        displayName: "Harn",
        installHint:
          "Install the harn binary from https://github.com/agentclientprotocol/registry and add its directory to PATH; configure the absolute path in the acp-mcp agent config.",
      },
      junie: {
        command: "junie",
        args: ["--acp=true"],
        supportedProtocols: ["v1"],
        displayName: "Junie",
        installHint:
          "Install JetBrains Junie (junie-app/junie on PATH, or Applications/junie.app on macOS) and authenticate with a JetBrains account; configure the absolute path in the acp-mcp agent config.",
      },
      kilo: {
        command: NPM_PACKAGES.kilo.bin,
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Kilo",
        installHint: `Install with npm install -g ${NPM_PACKAGES.kilo.pkg}, or run npx -y ${NPM_PACKAGES.kilo.pkg} acp. Requires provider authentication.`,
      },
      kimchi: {
        command: "kimchi",
        args: ["--mode", "acp"],
        supportedProtocols: ["v1"],
        displayName: "Kimchi",
        installHint:
          "Install the kimchi binary (bin/kimchi) and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires provider authentication.",
      },
      kimi: {
        command: "kimi",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Kimi CLI",
        installHint:
          "Install the Kimi CLI binary and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires Moonshot AI authentication.",
      },
      minimax: {
        command: NPM_PACKAGES.minimax.bin,
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "MiniMax Code",
        installHint: `Install with npm install -g ${NPM_PACKAGES.minimax.pkg}, or run npx -y ${NPM_PACKAGES.minimax.pkg} acp. Requires MiniMax authentication.`,
      },
      "minion-code": {
        command: "minion-code",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Minion Code",
        installHint:
          "Install with uvx (uvx minion-code@latest acp) and ensure the minion-code entry point is on PATH; configure the absolute path in the acp-mcp agent config.",
      },
      "mistral-vibe": {
        command: "vibe-acp",
        args: [],
        supportedProtocols: ["v1"],
        displayName: "Mistral Vibe",
        installHint:
          "Install the vibe-acp adapter binary from the official Mistral Vibe releases (https://github.com/mistralai/mistral-vibe/releases) or the Agent Client Protocol registry, add its directory to PATH, and configure the absolute path in the acp-mcp agent config. Requires Mistral authentication.",
      },
      nova: {
        command: NPM_PACKAGES.nova.bin,
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Nova",
        installHint: `Install with npm install -g ${NPM_PACKAGES.nova.pkg}, or run npx -y ${NPM_PACKAGES.nova.pkg} acp. Requires Compass AI authentication.`,
      },
      "opencode-v2": {
        command: "opencode",
        args: ["acp"],
        acpProtocol: "v2",
        supportedProtocols: ["v2"],
        displayName: "OpenCode V2",
        installHint:
          "Install OpenCode v2 from https://opencode.ai and authenticate with opencode auth login. Configure command or args in the acp-mcp agent config if a v2-specific binary is required.",
      },
      pi: {
        command: NPM_PACKAGES.pi.bin,
        args: [],
        supportedProtocols: ["v1"],
        displayName: "pi ACP",
        installHint: `Install with npm install -g ${NPM_PACKAGES.pi.pkg}, or run npx -y ${NPM_PACKAGES.pi.pkg}. Requires pi credentials.`,
      },
      poolside: {
        command: "pool",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Poolside",
        installHint:
          "Install the Poolside CLI binary from https://github.com/agentclientprotocol/registry and add its directory to PATH; configure the absolute path in the acp-mcp agent config. Requires Poolside authentication.",
      },
      qoder: {
        command: NPM_PACKAGES.qoder.bin,
        args: ["--acp"],
        supportedProtocols: ["v1"],
        displayName: "Qoder CLI",
        installHint: `Install with npm install -g ${NPM_PACKAGES.qoder.pkg}, or run npx -y ${NPM_PACKAGES.qoder.pkg} --acp. Requires Alibaba Cloud authentication.`,
      },
      qwen: {
        command: NPM_PACKAGES.qwen.bin,
        args: ["--acp", "--experimental-skills"],
        supportedProtocols: ["v1"],
        displayName: "Qwen Code",
        installHint: `Install with npm install -g ${NPM_PACKAGES.qwen.pkg}, or run npx -y ${NPM_PACKAGES.qwen.pkg} --acp. Requires Alibaba Cloud Model Studio authentication.`,
      },
      sigit: {
        command: NPM_PACKAGES.sigit.bin,
        args: [],
        supportedProtocols: ["v1"],
        displayName: "siGit Code",
        installHint: `Install with npm install -g ${NPM_PACKAGES.sigit.pkg}, or run npx -y ${NPM_PACKAGES.sigit.pkg}. Local-first; optionally configure an on-device model.`,
      },
      stakpak: {
        command: "stakpak",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "Stakpak",
        installHint:
          "Install the stakpak binary from https://github.com/agentclientprotocol/registry and add its directory to PATH; configure the absolute path in the acp-mcp agent config.",
      },
      vtcode: {
        command: "vtcode",
        args: ["acp"],
        supportedProtocols: ["v1"],
        displayName: "VT Code",
        installHint:
          "Install the vtcode binary from https://github.com/agentclientprotocol/registry and add its directory to PATH; configure the absolute path in the acp-mcp agent config.",
      },
    } satisfies AgentMap as AgentMap,
  );
  return agents;
}
