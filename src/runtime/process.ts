import process from "node:process";
import { ProcessCommand, type SpawnedProcess } from "#proc";
import * as nodeFs from "#fs";
import type { AgentDefinition } from "../agents/config.ts";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await nodeFs.stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findExecutablePath(
  command: string,
  pathValue = process.env["PATH"] ?? "",
): Promise<string | undefined> {
  const windows = process.platform === "win32";
  const hasExtension = windows && /\.[^\\/]+$/.test(command);
  const extensions = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.toLowerCase() !== ".exe");
  const candidates =
    windows && !hasExtension
      ? [
          command + ".exe",
          ...extensions.map((extension) => command + extension),
        ]
      : [command];
  const hasDirectory = command.includes("\\") || command.includes("/");
  const separator = windows ? ";" : ":";
  const roots = hasDirectory
    ? [""]
    : pathValue.split(separator).filter(Boolean);
  for (const root of roots) {
    for (const candidate of candidates) {
      const full = root
        ? `${root.replace(/[\\/]$/, "")}${windows ? "\\" : "/"}${candidate}`
        : candidate;
      try {
        const info = await nodeFs.stat(full);
        if (!info.isFile()) continue;
        if (
          !windows &&
          info.mode !== null &&
          info.mode !== undefined &&
          (info.mode & 0o111) === 0
        )
          continue;
        return full;
      } catch {
        // Search the next PATH candidate.
      }
    }
  }
  return undefined;
}

export function getAgentEnvironmentValue(
  definition: AgentDefinition,
  name: string,
): string | undefined {
  const overrideName = Object.keys(definition.env ?? {}).find((candidate) =>
    process.platform === "win32"
      ? candidate.toLowerCase() === name.toLowerCase()
      : candidate === name,
  );
  return overrideName === undefined
    ? process.env[name]
    : definition.env?.[overrideName];
}

export async function resolveWindowsExecutable(
  command: string,
): Promise<string> {
  if (process.platform !== "win32") return command;
  const pathExt = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";");
  const hasExtension = /\.[^\\/]+$/.test(command);
  const candidates = hasExtension
    ? [command]
    : [
        command + ".exe",
        ...pathExt
          .filter((ext) => ext.toLowerCase() !== ".exe")
          .map((ext) => command + ext),
      ];
  const hasDirectory = command.includes("\\") || command.includes("/");
  const roots = hasDirectory
    ? [""]
    : (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const root of roots) {
    for (const candidate of candidates) {
      const full = root
        ? `${root.replace(/[\\/]$/, "")}\\${candidate}`
        : candidate;
      if (await isFile(full)) return full;
    }
  }
  return command;
}

export function quoteCmdStaticArgument(value: string): string {
  // Shell operators are inert inside a quoted command argument.
  const escaped = value.replace(/%/g, "%%");
  return `"${escaped.replace(/"/g, '""')}"`;
}

const liveChildren = new Set<SpawnedProcess>();
let exitHooksInstalled = false;

function killLiveChildren() {
  for (const child of [...liveChildren]) {
    try {
      if (process.platform === "win32" && child.pid) {
        void new ProcessCommand("taskkill.exe", {
          args: ["/PID", String(child.pid), "/T", "/F"],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).output();
      } else {
        child.killTree("SIGKILL");
      }
    } catch {
      /* already exited */
    }
  }
}

function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on("exit", killLiveChildren);
}

export async function startAgent(definition: AgentDefinition, cwd: string) {
  for (const name of definition.requiredExecutableEnv ?? []) {
    const value = getAgentEnvironmentValue(definition, name);
    if (!value?.trim() || !(await findExecutablePath(value.trim()))) {
      throw new Error(
        `Agent requires environment variable '${name}' to name an existing executable`,
      );
    }
  }
  const resolved = await resolveWindowsExecutable(definition.command);
  if (!(await findExecutablePath(resolved))) {
    throw new Error(`Agent command '${definition.command}' was not found`);
  }
  const isBatch =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
  const command = isBatch ? (process.env["COMSPEC"] ?? "cmd.exe") : resolved;
  const args = isBatch
    ? ["/d", "/c", "%ACPMCP_CONFIGURED_COMMAND%"]
    : definition.args;
  const env = isBatch
    ? {
        ...definition.env,
        ACPMCP_CONFIGURED_COMMAND: [resolved, ...definition.args]
          .map(quoteCmdStaticArgument)
          .join(" "),
      }
    : definition.env;
  const child = new ProcessCommand(command, {
    args,
    cwd,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  liveChildren.add(child);
  installExitHooks();
  void child.status.finally(() => liveChildren.delete(child));
  const tail: string[] = [];
  const stderrDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      tail.push(decoder.decode(chunk));
      while (tail.join("").length > 16_000) tail.shift();
    }
  })();
  return { child, stderrDone, stderrTail: () => tail.join("").slice(-16_000) };
}

export async function stopAgent(
  child: SpawnedProcess,
  timeoutMs = 5000,
): Promise<void> {
  try {
    child.stdin.close();
  } catch {
    /* already closed */
  }
  const exitedWithin = async (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      child.status.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return done;
  };
  if (await exitedWithin(timeoutMs)) return;
  // Graceful close was ignored: force-terminate the whole process tree.
  if (process.platform === "win32" && child.pid) {
    try {
      await new ProcessCommand("taskkill.exe", {
        args: ["/PID", String(child.pid), "/T", "/F"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
    } catch {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    }
  } else {
    try {
      child.killTree("SIGKILL");
    } catch {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    }
  }
  await child.status.catch(() => undefined);
}
