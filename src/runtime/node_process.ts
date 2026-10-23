import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import process from "node:process";

export type ProcessStatus = {
  success: boolean;
  code: number;
  signal: NodeJS.Signals | null;
};

export type ProcessOutput = ProcessStatus & {
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export type ProcessCommandOptions = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "inherit" | "null" | "piped";
  stdout?: "inherit" | "null" | "piped";
  stderr?: "inherit" | "null" | "piped";
  shell?: boolean;
};

function stdio(value: "inherit" | "null" | "piped" | undefined) {
  if (value === "piped") return "pipe";
  if (value === "null" || value === undefined) return "ignore";
  return value;
}

function asBytes(value: Buffer | Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export class SpawnedProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<ProcessStatus>;
  readonly pid?: number;
  private readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    this.pid = child.pid;
    this.stdin = child.stdin
      ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>)
      : new WritableStream<Uint8Array>();
    this.stdout = child.stdout
      ? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
      : new ReadableStream<Uint8Array>();
    this.stderr = child.stderr
      ? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>)
      : new ReadableStream<Uint8Array>();
    this.status = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ success: code === 0, code: code ?? -1, signal });
      });
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    return this.child.kill(signal);
  }

  /**
   * Signal the child's whole process group when it leads one (POSIX), so
   * grandchildren (npx wrappers, batch chains) cannot survive a stop request.
   */
  killTree(signal: NodeJS.Signals): boolean {
    if (process.platform !== "win32" && this.pid !== undefined) {
      try {
        process.kill(-this.pid, signal);
        return true;
      } catch {
        /* Group already gone; fall back to the direct child. */
      }
    }
    return this.child.kill(signal);
  }
}

export class ProcessCommand {
  private readonly command: string;
  private readonly options: ProcessCommandOptions;

  constructor(command: string, options: ProcessCommandOptions = {}) {
    this.command = command;
    this.options = options;
  }

  spawn(): SpawnedProcess {
    const child = spawn(this.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env
        ? { ...process.env, ...this.options.env }
        : process.env,
      stdio: [
        stdio(this.options.stdin),
        stdio(this.options.stdout),
        stdio(this.options.stderr),
      ],
      windowsHide: true,
      shell: this.options.shell ?? false,
      detached: process.platform !== "win32",
    });
    return new SpawnedProcess(child);
  }

  async output(): Promise<ProcessOutput> {
    const child = spawn(this.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env
        ? { ...process.env, ...this.options.env }
        : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: this.options.shell ?? false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const status = await new SpawnedProcess(child).status;
    return {
      ...status,
      stdout: asBytes(Buffer.concat(stdout)),
      stderr: asBytes(Buffer.concat(stderr)),
    };
  }
}
