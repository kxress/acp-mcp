import { test } from "node:test";
import process from "node:process";
import { ProcessCommand } from "#proc";
import { startAgent, stopAgent } from "../src/runtime/process.ts";

async function processAlive(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const stat = await (await import("node:fs/promises")).readFile(
      `/proc/${pid}/stat`,
      "utf8",
    );
    return (stat.split(" ")[2] ?? "Z") !== "Z";
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processAlive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("stopAgent kills uncooperative agent process trees, not just the direct child", async () => {
  if (process.platform === "win32") {
    return;
  }
  const fixture = new URL("./fixtures/ignore_shutdown_tree.ts", import.meta.url)
    .pathname;
  const agent = await startAgent(
    {
      command: process.execPath,
      args: [fixture],
    },
    process.cwd(),
  );
  let grandchildPid: number | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const text = await (await import("node:fs/promises")).readFile(
          `${agent.child.pid}.tree-test-pids`,
          "utf8",
        );
        grandchildPid = Number(text.trim());
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (grandchildPid === undefined) {
      throw new Error("Test fixture did not report its grandchild pid");
    }
    await stopAgent(agent.child, 100);
    await agent.child.status.catch(() => undefined);
    if (!(await waitForExit(grandchildPid))) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        /* already gone */
      }
      throw new Error("stopAgent left an orphaned grandchild process behind");
    }
  } finally {
    try {
      await (await import("node:fs/promises")).rm(
        `${agent.child.pid}.tree-test-pids`,
        { force: true },
      );
    } catch {
      /* fixture never started */
    }
    await agent.stderrDone.catch(() => undefined);
  }
});

test("agents that ignore stdin EOF are force-killed within a bounded time", async () => {
  const fixture = new URL("./fixtures/ignore_shutdown.ts", import.meta.url)
    .pathname;
  const agent = await startAgent(
    {
      command: process.execPath,
      args: [fixture],
    },
    process.cwd(),
  );
  const started = performance.now();
  try {
    await stopAgent(agent.child, 50);
    await agent.child.status.catch(() => undefined);
    if (performance.now() - started > 3_000) {
      throw new Error("Force kill did not bound the shutdown time");
    }
  } finally {
    await agent.stderrDone.catch(() => undefined);
  }
});

test("SIGTERM shuts the MCP server down like SIGINT", async () => {
  if (process.platform === "win32") return;
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  const child = new ProcessCommand(process.execPath, {
    args: [main],
    cwd: process.cwd(),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGTERM");
    const exited = await Promise.race([
      child.status.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 3_000),
      ),
    ]);
    if (!exited) {
      throw new Error("Server ignored SIGTERM and kept running");
    }
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    await child.status.catch(() => undefined);
  }
});
