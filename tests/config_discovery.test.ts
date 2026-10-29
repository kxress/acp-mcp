import { test } from "node:test";
import * as nodeFs from "#fs";
import { join } from "node:path";
import { resolveConfiguration } from "../src/config/discovery.ts";

async function writeConfig(directory: string, value: unknown): Promise<string> {
  await nodeFs.mkdir(directory, { recursive: true });
  const path = join(directory, ".acp-mcp.json");
  await nodeFs.writeText(path, JSON.stringify(value));
  return path;
}

test("no files keeps built-ins, while home-only and project-only configs load", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp source-cases-" });
  const home = join(root, "home");
  const project = join(root, "repo");
  try {
    const absent = await resolveConfiguration({
      cwd: project,
      homeDirectory: home,
    });
    if (!absent.agents["antigravity-acp"] || absent.sources.length) {
      throw new Error("missing optional config disabled built-ins");
    }

    await writeConfig(project, {
      agents: { antigravity: { implementation: "agy" } },
    });
    const projectOnly = await resolveConfiguration({
      cwd: project,
      homeDirectory: home,
    });
    if (
      projectOnly.agents["antigravity-acp"].implementation !== "agy" ||
      projectOnly.sources.length !== 1
    ) {
      throw new Error("project-only config was not discovered");
    }

    await writeConfig(home, {
      agents: { antigravity: { models: { deniedModels: ["gpt-*"] } } },
    });
    const homeOnly = await resolveConfiguration({
      cwd: join(root, "elsewhere"),
      homeDirectory: home,
    });
    if (
      homeOnly.agents["antigravity-acp"].models?.deniedModels?.[0] !== "gpt-*"
    ) {
      throw new Error("home-only config was not loaded");
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("hierarchical config merges home and project from outer to nearest", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp config spaces-" });
  const home = join(root, "home");
  const repo = join(root, "repo");
  const nested = join(repo, "nested");
  try {
    const homeFile = await writeConfig(home, {
      agents: {
        antigravity: {
          models: {
            allowedModels: ["claude-*", "gemini-*"],
            modelSizes: { large: { model: "home-model" } },
          },
        },
      },
    });
    const repoFile = await writeConfig(repo, {
      agents: {
        antigravity: {
          implementation: "agy",
          models: {
            allowedModels: ["claude-*"],
            default: { modelSize: "large", thinkingEffort: "max" },
          },
        },
      },
    });
    const nestedFile = await writeConfig(nested, {
      agents: {
        antigravity: {
          models: {
            default: { modelSize: "medium", thinkingEffort: "high" },
          },
        },
      },
    });
    const resolved = await resolveConfiguration({
      cwd: nested,
      homeDirectory: home,
    });
    const agent = resolved.agents["antigravity-acp"];
    if (
      agent.implementation !== "agy" ||
      agent.models?.default?.modelSize !== "medium" ||
      agent.models?.default?.thinkingEffort !== "high" ||
      agent.models?.allowedModels?.join(",") !== "claude-*" ||
      agent.models?.modelSizes?.large?.model !== "home-model" ||
      resolved.sources.map((source) => source.path).join("|") !==
        [homeFile, repoFile, nestedFile].join("|")
    )
      throw new Error(JSON.stringify({ agent, sources: resolved.sources }));
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("project config is safe, arrays replace, and cannot inject launch data", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp project-safe-" });
  const home = join(root, "home");
  const project = join(root, "repo");
  try {
    await writeConfig(home, {
      agents: {
        antigravity: {
          command: "trusted-command",
          args: ["--trusted"],
          env: { AGY_BIN: "trusted-agy" },
          models: { allowedModels: ["a", "b"] },
        },
      },
    });
    await writeConfig(project, {
      agents: {
        antigravity: {
          implementation: "agy",
          models: { allowedModels: ["c"] },
        },
      },
    });
    const resolved = await resolveConfiguration({
      cwd: project,
      homeDirectory: home,
    });
    if (
      resolved.agents["antigravity-acp"].command !== "trusted-command" ||
      resolved.agents["antigravity-acp"].args.join() !== "--trusted" ||
      resolved.agents["antigravity-acp"].env?.AGY_BIN !== "trusted-agy" ||
      resolved.agents["antigravity-acp"].models?.allowedModels?.join() !== "c"
    ) {
      throw new Error(
        "project configuration replaced trusted launch data or concatenated arrays",
      );
    }

    for (const launch of [
      { command: "evil" },
      { args: ["evil"] },
      {
        env: { EVIL: "yes" },
      },
    ]) {
      const bad = join(root, `bad-${Object.keys(launch)[0]}`);
      await writeConfig(bad, { agents: { antigravity: launch } });
      let rejected = false;
      try {
        await resolveConfiguration({
          cwd: bad,
          homeDirectory: join(root, "no-home"),
        });
      } catch (error) {
        rejected =
          error instanceof Error &&
          error.message.includes("project configuration");
      }
      if (!rejected) {
        throw new Error(
          `Project ${Object.keys(launch)[0]} injection was accepted`,
        );
      }
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("project policy may target a trusted custom agent but cannot create or replace one", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp custom trust-" });
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await writeConfig(home, {
      agents: {
        reviewer: {
          command: "trusted-reviewer-acp",
          env: { REVIEWER_SECRET: "trusted-secret-canary" },
          acpProtocol: "v2",
          models: { allowedModels: ["trusted-*"] },
        },
      },
    });
    await writeConfig(repo, {
      agents: {
        reviewer: {
          models: {
            default: { model: "trusted-review-model" },
            deniedModels: ["trusted-expensive-*"],
          },
        },
      },
    });
    const resolved = await resolveConfiguration({
      cwd: repo,
      homeDirectory: home,
    });
    const reviewer = resolved.agents.reviewer;
    if (
      reviewer.command !== "trusted-reviewer-acp" ||
      reviewer.args.length !== 0 ||
      reviewer.env?.REVIEWER_SECRET !== "trusted-secret-canary" ||
      reviewer.acpProtocol !== "v2" ||
      reviewer.models?.default?.model !== "trusted-review-model" ||
      reviewer.models?.deniedModels?.[0] !== "trusted-expensive-*"
    )
      throw new Error("Project policy changed trusted custom launch data");

    for (const launch of [
      { command: "evil.exe" },
      { args: ["--replace"] },
      { env: { REVIEWER_SECRET: "project-value" } },
    ]) {
      const badRepo = join(root, `bad-${Object.keys(launch)[0]}`);
      await writeConfig(badRepo, { agents: { reviewer: launch } });
      let rejected = false;
      try {
        await resolveConfiguration({
          cwd: badRepo,
          homeDirectory: home,
        });
      } catch (error) {
        rejected =
          error instanceof Error &&
          error.message.includes("project configuration");
      }
      if (!rejected) {
        throw new Error(
          `Project configuration replaced trusted custom ${
            Object.keys(launch)[0]
          }`,
        );
      }
    }

    const untrustedOnly = join(root, "untrusted-only");
    await writeConfig(untrustedOnly, {
      agents: { notTrusted: { models: { deniedModels: ["*"] } } },
    });
    let creationRejected = false;
    try {
      await resolveConfiguration({
        cwd: untrustedOnly,
        homeDirectory: join(root, "empty-home"),
      });
    } catch (error) {
      creationRejected =
        error instanceof Error &&
        error.message.includes("agent 'notTrusted' command");
    }
    if (!creationRejected) {
      throw new Error("Project policy created a runnable custom agent");
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("explicit config is exact and disables home/project discovery", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp explicit-" });
  const home = join(root, "home");
  const project = join(root, "project");
  const explicit = join(root, "chosen config.json");
  try {
    await writeConfig(home, {
      agents: { antigravity: { implementation: "agy" } },
    });
    await writeConfig(project, {
      agents: { antigravity: { implementation: "refined" } },
    });
    await nodeFs.writeText(explicit, JSON.stringify({ agents: {} }));
    const resolved = await resolveConfiguration({
      explicitConfigPath: explicit,
      cwd: project,
      homeDirectory: home,
    });
    if (
      !resolved.explicit ||
      resolved.sources.length !== 1 ||
      resolved.agents["antigravity-acp"].implementation !== "official"
    ) {
      throw new Error("explicit configuration did not disable discovery");
    }
    let missingFailed = false;
    try {
      await resolveConfiguration({
        explicitConfigPath: join(root, "missing.json"),
        cwd: project,
        homeDirectory: home,
      });
    } catch {
      missingFailed = true;
    }
    if (!missingFailed) {
      throw new Error("missing explicit config silently fell back");
    }
    let directoryFailed = false;
    try {
      await resolveConfiguration({
        explicitConfigPath: project,
        cwd: project,
        homeDirectory: home,
      });
    } catch (error) {
      directoryFailed =
        error instanceof Error && error.message.includes("not a file");
    }
    if (!directoryFailed) {
      throw new Error("directory was accepted as an explicit config file");
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("home config is not applied twice when it is an ancestor of operation cwd", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp home-ancestor-" });
  const project = join(root, "project");
  try {
    const homeFile = await writeConfig(root, {
      agents: { antigravity: { models: { allowedModels: ["claude-*"] } } },
    });
    const resolved = await resolveConfiguration({
      cwd: project,
      homeDirectory: root,
    });
    if (
      resolved.sources.length !== 1 ||
      resolved.sources[0].path !== homeFile
    ) {
      throw new Error(
        `home file was applied more than once: ${JSON.stringify(
          resolved.sources,
        )}`,
      );
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});

test("invalid discovered config fails with its path", async () => {
  const root = await nodeFs.makeTempDir({ prefix: "acp-mcp invalid-project-" });
  const file = await writeConfig(root, {
    agents: { antigravity: { models: { default: { modelSize: "xl" } } } },
  });
  try {
    let error = "";
    try {
      await resolveConfiguration({
        cwd: root,
        homeDirectory: join(root, "home"),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!error.includes(file) || !error.includes("modelSize")) {
      throw new Error(
        `invalid discovered config error lacked path/field: ${error}`,
      );
    }
  } finally {
    await nodeFs.removePath(root, { recursive: true });
  }
});
