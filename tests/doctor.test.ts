import { test } from "node:test";
import * as nodeFs from "#fs";
import {
  diagnose,
  type DoctorDependencies,
} from "../src/diagnostics/doctor.ts";
import type { AgentDefinition } from "../src/agents/config.ts";
import { resolveConfiguration } from "../src/config/discovery.ts";
import { join } from "node:path";

function staleResult(eligible = 0) {
  return {
    root: "",
    dryRun: true,
    olderThanMs: 24 * 60 * 60 * 1000,
    eligible,
    removed: 0,
    skipped: 0,
    failed: 0,
    entries: [],
  };
}

function dependencies(
  root: string,
  agents: Record<string, AgentDefinition>,
  overrides: Partial<DoctorDependencies> = {},
): DoctorDependencies {
  return {
    resolveExecutable: (command) =>
      Promise.resolve(`C:\\fixtures\\${command}.exe`),
    loadAgents: () => Promise.resolve(agents),
    inspectStaleWorkspaces: (options) => {
      if (options.delete !== false || options.checkCreatorProcess !== false) {
        return Promise.reject(
          new Error("Doctor must inspect workspaces without deleting"),
        );
      }
      return Promise.resolve(staleResult());
    },
    workspaceRoot: () => Promise.resolve(root),
    runVersionCommand: () => Promise.resolve("v22.1.0"),
    ...overrides,
  };
}

test("doctor reports local configuration and agent checks without secrets", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-doctor-root-" });
  const config = `${root}\\config.json`;
  try {
    await nodeFs.writeText(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(root, {
        "claude-acp": {
          command: "agent",
          args: ["--api-key", "DOCTOR_SECRET_VALUE"],
          env: { OPENROUTER_API_KEY: "DOCTOR_SECRET_VALUE" },
          installHint: "DOCTOR_SECRET_HINT",
        },
      }),
    );
    const serialized = JSON.stringify(report);
    if (
      report.status !== "healthy" ||
      report.configPath !== config ||
      !report.checks.some((check) =>
        check.summary.includes("configured argument(s)"),
      ) ||
      serialized.includes("DOCTOR_SECRET_VALUE") ||
      serialized.includes("DOCTOR_SECRET_HINT")
    )
      throw new Error(`Unexpected doctor report: ${serialized}`);
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("doctor reports missing agent commands without dumping config hints", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-doctor-missing-" });
  const config = `${root}\\config.json`;
  try {
    await nodeFs.writeText(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(
        root,
        {
          custom: {
            command: "missing-agent",
            args: [],
            installHint: "DOCTOR_SECRET_HINT",
          },
        },
        {
          resolveExecutable: () => Promise.resolve(undefined),
        },
      ),
    );
    const agent = report.checks.find((check) => check.id === "agent.custom");
    if (
      report.status !== "errors" ||
      agent?.status !== "error" ||
      !agent.detail?.includes("README") ||
      agent.detail.includes("DOCTOR_SECRET_HINT")
    )
      throw new Error("Missing agent command was not diagnosed usefully");
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("doctor handles invalid and missing explicit configs as structured errors", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-doctor-config-" });
  const invalidConfig = `${root}\\invalid.json`;
  const missingConfig = `${root}\\missing.json`;
  try {
    await nodeFs.writeText(invalidConfig, "not json");
    const invalid = await diagnose(
      { configPath: invalidConfig },
      dependencies(
        root,
        {},
        {
          loadAgents: () => Promise.reject(new Error("opaque parse failure")),
        },
      ),
    );
    const missing = await diagnose(
      { configPath: missingConfig },
      dependencies(root, {}),
    );
    if (
      invalid.status !== "errors" ||
      !invalid.checks
        .find((check) => check.id === "config")
        ?.summary.includes("invalid or unreadable configuration") ||
      JSON.stringify(invalid).includes("opaque parse failure") ||
      missing.status !== "errors" ||
      !missing.checks
        .find((check) => check.id === "config")
        ?.summary.includes("does not exist")
    ) {
      throw new Error(
        "Config failures were not returned safely as diagnostics",
      );
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("doctor reports stale workspaces without requesting deletion", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-doctor-stale-" });
  const config = `${root}\\config.json`;
  let deleteRequested: boolean | undefined;
  try {
    await nodeFs.writeText(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(
        root,
        {},
        {
          inspectStaleWorkspaces: (options) => {
            deleteRequested = options.delete;
            return Promise.resolve(staleResult(2));
          },
        },
      ),
    );
    if (
      deleteRequested !== false ||
      report.status !== "warnings" ||
      !report.checks.some(
        (check) =>
          check.id === "workspace.stale" && check.summary.includes("2 stale"),
      )
    )
      throw new Error("Doctor did not safely report stale workspaces");
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("doctor reports hierarchical source order and effective cwd without loading providers", async () => {
  const root = await nodeFs.makeTempDir({
    prefix: "acp-mcp doctor hierarchy-",
  });
  const home = join(root, "home");
  const project = join(root, "repo");
  const nested = join(project, "nested");
  await nodeFs.mkdir(home, { recursive: true });
  await nodeFs.mkdir(nested, { recursive: true });
  const homePath = await nodeFs
    .writeText(join(home, ".acp-mcp.json"), JSON.stringify({ agents: {} }))
    .then(() => join(home, ".acp-mcp.json"));
  const projectPath = await nodeFs
    .writeText(
      join(project, ".acp-mcp.json"),
      JSON.stringify({ agents: { antigravity: { implementation: "agy" } } }),
    )
    .then(() => join(project, ".acp-mcp.json"));
  try {
    const deps = dependencies(
      root,
      {},
      {
        resolveConfiguration: (options) =>
          resolveConfiguration({
            ...options,
            homeDirectory: home,
          }),
      },
    );
    const report = await diagnose({ cwd: nested }, deps);
    if (
      report.effectiveCwd !== nested ||
      report.configSources?.map((source) => source.path).join("|") !==
        `${homePath}|${projectPath}` ||
      report.configSources?.map((source) => source.kind).join("|") !==
        "home|project"
    ) {
      throw new Error(
        `Doctor omitted hierarchical config context: ${JSON.stringify(report)}`,
      );
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("doctor reports a too-old local runtime prerequisite", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-doctor-runtime-" });
  const config = `${root}\\config.json`;
  try {
    await nodeFs.writeText(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(
        root,
        {
          "claude-acp": {
            command: "agent",
            args: [],
            acpProtocol: "v2",
            runtimePrerequisites: [
              { command: "node", minimumVersion: "22.0.0" },
            ],
          },
        },
        { runVersionCommand: () => Promise.resolve("v20.15.0") },
      ),
    );
    if (
      report.status !== "errors" ||
      report.checks.find((check) => check.id === "agent.claude-acp.protocol")
        ?.summary !== "claude-acp: ACP v2 selected" ||
      !report.checks.some(
        (check) =>
          check.id === "runtime.claude-acp.1" &&
          check.summary.includes("found v20.15.0"),
      )
    )
      throw new Error("Runtime version prerequisite was not checked");
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("doctor identifies the selected Antigravity implementation and backend prerequisite", async () => {
  const root = await nodeFs.makeTempDir({
    prefix: "acp-mcp-doctor-antigravity-",
  });
  const config = `${root}\\config.json`;
  try {
    await nodeFs.writeText(config, JSON.stringify({ agents: {} }));
    const report = await diagnose(
      { configPath: config },
      dependencies(
        root,
        {
          "antigravity-acp": {
            command: "refined-antigravity-acp",
            args: [],
            implementation: "refined",
            acpProtocol: "v1",
            requiredExecutableEnv: ["REFINED_AGY_ACP_BIN"],
            runtimePrerequisites: [
              { command: "node", minimumVersion: "22.0.0" },
            ],
            env: { REFINED_AGY_ACP_BIN: "" },
          },
        },
        {
          resolveExecutable: (command) =>
            Promise.resolve(
              command === "refined-antigravity-acp" || command === "node"
                ? `C:\\fixtures\\${command}.exe`
                : undefined,
            ),
          runVersionCommand: () => Promise.resolve("v22.1.0"),
        },
      ),
    );
    if (
      !report.checks.some(
        (check) =>
          check.id === "agent.antigravity-acp.protocol" &&
          check.summary.includes("refined implementation"),
      ) ||
      !report.checks.some(
        (check) =>
          check.id === "agent.antigravity-acp.required.REFINED_AGY_ACP_BIN" &&
          check.status === "error",
      ) ||
      !report.checks.some(
        (check) =>
          check.id === "runtime.antigravity-acp.1" && check.status === "ok",
      )
    ) {
      throw new Error(
        "Doctor did not report refined implementation prerequisites",
      );
    }

    const configured = await diagnose(
      { configPath: config },
      dependencies(
        root,
        {
          "antigravity-acp": {
            command: "refined-antigravity-acp",
            args: [],
            implementation: "refined",
            acpProtocol: "v1",
            requiredExecutableEnv: ["REFINED_AGY_ACP_BIN"],
            runtimePrerequisites: [
              { command: "node", minimumVersion: "22.0.0" },
            ],
            env: { REFINED_AGY_ACP_BIN: "C:\\fixtures\\agy_acp_server.exe" },
          },
        },
        {
          resolveExecutable: (command) =>
            Promise.resolve(`C:\\fixtures\\${command}.exe`),
          runVersionCommand: () => Promise.resolve("v22.1.0"),
        },
      ),
    );
    if (
      configured.checks.find(
        (check) =>
          check.id === "agent.antigravity-acp.required.REFINED_AGY_ACP_BIN",
      )?.status !== "ok"
    )
      throw new Error("Doctor rejected an existing refined ACP backend");
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("doctor checks agy adapter identity and the explicitly supplied agy executable", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp-doctor-agy-" });
  const config = `${root}\\config.json`;
  try {
    await nodeFs.writeText(config, JSON.stringify({ agents: {} }));
    const missing = await diagnose(
      { configPath: config },
      dependencies(
        root,
        {
          "antigravity-acp": {
            command: "agy-acp-windows-x64.exe",
            args: [],
            implementation: "agy",
            displayName: "Antigravity (agy ACP)",
            acpProtocol: "v1",
            requiredExecutableEnv: ["AGY_BIN"],
            env: { AGY_BIN: "" },
          },
        },
        {
          resolveExecutable: (command) =>
            Promise.resolve(
              command === "agy-acp-windows-x64.exe"
                ? "C:\\fixtures\\agy-acp-windows-x64.exe"
                : undefined,
            ),
        },
      ),
    );
    if (
      !missing.checks.some(
        (check) =>
          check.id === "agent.antigravity-acp.protocol" &&
          check.summary.includes("agy implementation"),
      ) ||
      missing.checks.find(
        (check) => check.id === "agent.antigravity-acp.required.AGY_BIN",
      )?.status !== "error"
    ) {
      throw new Error(
        "Doctor did not report the agy implementation requirement",
      );
    }

    const configured = await diagnose(
      { configPath: config },
      dependencies(
        root,
        {
          "antigravity-acp": {
            command: "agy-acp-windows-x64.exe",
            args: [],
            implementation: "agy",
            acpProtocol: "v1",
            requiredExecutableEnv: ["AGY_BIN"],
            env: { AGY_BIN: "C:\\fixtures\\agy.exe" },
          },
        },
        {
          resolveExecutable: (command) =>
            Promise.resolve(`C:\\fixtures\\${command}.exe`),
        },
      ),
    );
    if (
      configured.checks.find(
        (check) => check.id === "agent.antigravity-acp.required.AGY_BIN",
      )?.status !== "ok"
    )
      throw new Error("Doctor rejected an existing agy executable");
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});
