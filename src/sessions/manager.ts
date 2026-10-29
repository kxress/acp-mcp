import process from "node:process";
import {
  canonicalAgentId,
  type AgentDefinition,
  type AgentMap,
} from "../agents/config.ts";
import type {
  AgentModelPolicy,
  ModelSize,
  ThinkingEffort,
} from "../models/policy.ts";
import { createProtocolDriver } from "../acp/driver_factory.ts";
import type {
  AcpPermissionRequest,
  AcpProtocol,
  NormalizedAcpUpdate,
  ProtocolDriver,
} from "../acp/protocol.ts";
import { startAgent, stopAgent } from "../runtime/process.ts";

interface ManagedSession {
  id: string;
  agentId: string;
  agentDefinition: AgentDefinition;
  cwd: string;
  acpSessionId: string;
  acpProtocol: AcpProtocol;
  driver: ProtocolDriver;
  process: Awaited<ReturnType<typeof startAgent>>;
  promptActive: boolean;
  capabilities: unknown;
  authMethods: unknown;
  configOptions: Array<Record<string, unknown>>;
  modes: Record<string, unknown> | undefined;
  prompt?: PromptRecord;
  events: SessionEvent[];
  nextSequence: number;
  droppedThrough: number;
  permissionPolicy: PermissionPolicy;
  modelSelection?: {
    model: string;
    modelSize?: ModelSize;
    thinkingEffort?: ThinkingEffort;
  };
  pendingPermissions: Map<string, PendingPermission>;
  permissionLease?: ReturnType<typeof setTimeout>;
}

export interface SessionEvent {
  sequence: number;
  timestamp: string;
  kind: string;
  update: unknown;
  raw: unknown;
}

interface PromptRecord {
  id: string;
  state: "running" | "completed" | "cancelled" | "failed";
  text: string;
  messageText: Map<string, string>;
  messageOrder: string[];
  lastActivityAt: number;
  activityVersion: number;
  activityWaiters: Set<() => void>;
  stopReason?: string;
  error?: string;
  errorCode?: number;
  errorData?: unknown;
  done: Promise<void>;
}

export type PermissionPolicy =
  | "read_only"
  | "operator"
  | "allow_all"
  | "deny_all";

export interface SessionSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly implementation?: string;
  readonly cwd: string;
  readonly acpSessionId: string;
  readonly acpProtocol: AcpProtocol;
  readonly promptActive: boolean;
  readonly capabilities: unknown;
  readonly authMethods: unknown;
  readonly configOptions: Array<Record<string, unknown>>;
  readonly modes: Record<string, unknown> | undefined;
  readonly permissionPolicy: PermissionPolicy;
  readonly modelConfigId?: string;
  readonly models?: AgentModelPolicy;
  readonly modelSelection?: {
    readonly model: string;
    readonly modelSize?: ModelSize;
    readonly thinkingEffort?: ThinkingEffort;
  };
  readonly pendingPermissions: Array<{
    id: string;
    toolCall: unknown;
    options: Array<{ optionId: string; kind: string; name: string }>;
  }>;
  readonly prompt?: {
    id: string;
    state: PromptRecord["state"];
    text: string;
    stopReason?: string;
    error?: string;
    errorCode?: number;
    errorData?: unknown;
  };
  readonly nextSequence: number;
}

export interface PromptHandle {
  readonly id: string;
  readonly state: PromptRecord["state"];
  readonly text: string;
  readonly stopReason?: string;
  readonly error?: string;
  readonly errorCode?: number;
  readonly errorData?: unknown;
  readonly lastActivityAt: number;
  readonly activityVersion: number;
  readonly done: Promise<void>;
}

export interface SessionLaunchOptions {
  agentDefinition?: AgentDefinition;
}

type PendingPermissionSnapshot = SessionSnapshot["pendingPermissions"][number];

type ConfigOptionWaiter = {
  predicate: (options: Array<Record<string, unknown>>) => boolean;
  finish: (options: Array<Record<string, unknown>>) => void;
};

function configOptionsFromUpdate(
  event: NormalizedAcpUpdate,
): Array<Record<string, unknown>> | undefined {
  if (event.kind !== "config_option_update") return undefined;
  if (!event.update || typeof event.update !== "object") return undefined;
  const options = (event.update as { configOptions?: unknown }).configOptions;
  if (
    !Array.isArray(options) ||
    !options.every((option) => option !== null && typeof option === "object")
  )
    return undefined;
  return options as Array<Record<string, unknown>>;
}

export const DEFAULT_SESSION_START_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_MANAGED_SESSIONS = 8;

interface PendingPermission {
  id: string;
  toolCall: unknown;
  options: Array<{ optionId: string; kind: string; name: string }>;
  resolve: (value: {
    outcome:
      | { outcome: "selected"; optionId: string }
      | {
          outcome: "cancelled";
        };
  }) => void;
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly configOptionWaiters = new Map<
    string,
    Set<ConfigOptionWaiter>
  >();
  private agents: AgentMap;
  private readonly startupTimeoutMs: number;
  private readonly closeRequestTimeoutMs: number;
  private readonly maxSessions: number;

  constructor(
    agents: AgentMap,
    startupTimeoutMs = DEFAULT_SESSION_START_TIMEOUT_MS,
    closeRequestTimeoutMs = DEFAULT_SESSION_CLOSE_TIMEOUT_MS,
    maxSessions = DEFAULT_MAX_MANAGED_SESSIONS,
  ) {
    this.agents = agents;
    this.startupTimeoutMs = startupTimeoutMs;
    this.closeRequestTimeoutMs = closeRequestTimeoutMs;
    this.maxSessions = maxSessions;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  listSessionSnapshots(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) =>
      this.sessionSnapshot(session),
    );
  }

  getSessionSnapshot(id: string): SessionSnapshot {
    return this.sessionSnapshot(this.requireSession(id));
  }

  recordModelSelection(
    sessionId: string,
    selection:
      | {
          model: string;
          modelSize?: ModelSize;
          thinkingEffort?: ThinkingEffort;
        }
      | undefined,
  ): void {
    const session = this.requireSession(sessionId);
    session.modelSelection = selection ? { ...selection } : undefined;
  }

  getPromptHandle(sessionId: string, promptId: string): PromptHandle {
    return this.promptHandle(this.requirePrompt(sessionId, promptId));
  }

  private sessionSnapshot(session: ManagedSession): SessionSnapshot {
    return {
      id: session.id,
      agentId: session.agentId,
      implementation: session.agentDefinition.implementation,
      cwd: session.cwd,
      acpSessionId: session.acpSessionId,
      acpProtocol: session.acpProtocol,
      promptActive: session.promptActive,
      capabilities: structuredClone(session.capabilities),
      authMethods: structuredClone(session.authMethods),
      configOptions: structuredClone(session.configOptions),
      modes: structuredClone(session.modes),
      permissionPolicy: session.permissionPolicy,
      modelConfigId: session.agentDefinition.modelConfigId,
      models: session.agentDefinition.models
        ? structuredClone(session.agentDefinition.models)
        : undefined,
      modelSelection: session.modelSelection
        ? { ...session.modelSelection }
        : undefined,
      pendingPermissions: [...session.pendingPermissions.values()].map(
        (pending) => ({
          id: pending.id,
          toolCall: structuredClone(pending.toolCall),
          options: structuredClone(pending.options),
        }),
      ),
      prompt: session.prompt
        ? {
            id: session.prompt.id,
            state: session.prompt.state,
            text: session.prompt.text,
            stopReason: session.prompt.stopReason,
            error: session.prompt.error,
            errorCode: session.prompt.errorCode,
            errorData: structuredClone(session.prompt.errorData),
          }
        : undefined,
      nextSequence: session.nextSequence,
    };
  }

  private promptHandle(prompt: PromptRecord): PromptHandle {
    return {
      get id() {
        return prompt.id;
      },
      get state() {
        return prompt.state;
      },
      get text() {
        return prompt.text;
      },
      get stopReason() {
        return prompt.stopReason;
      },
      get error() {
        return prompt.error;
      },
      get errorCode() {
        return prompt.errorCode;
      },
      get errorData() {
        return structuredClone(prompt.errorData);
      },
      get lastActivityAt() {
        return prompt.lastActivityAt;
      },
      get activityVersion() {
        return prompt.activityVersion;
      },
      done: prompt.done,
    };
  }

  private requireSession(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }

  private requirePrompt(sessionId: string, promptId: string): PromptRecord {
    const prompt = this.requireSession(sessionId).prompt;
    if (!prompt || prompt.id !== promptId) {
      throw new Error(`Unknown prompt: ${promptId}`);
    }
    return prompt;
  }

  private clearPermissionLease(session: ManagedSession): void {
    if (session.permissionLease) clearTimeout(session.permissionLease);
    session.permissionLease = undefined;
  }

  private cancelPendingPermissions(session: ManagedSession): void {
    for (const pending of session.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    session.pendingPermissions.clear();
  }

  start(
    agentId: string,
    cwd = process.cwd(),
    config: Record<string, string> = {},
    modeId?: string,
    permissionPolicy: PermissionPolicy = "read_only",
    options: SessionLaunchOptions = {},
  ): Promise<SessionSnapshot> {
    return this.launch(
      agentId,
      cwd,
      config,
      modeId,
      permissionPolicy,
      undefined,
      options,
    ).then((session) => this.sessionSnapshot(session));
  }

  load(
    agentId: string,
    acpSessionId: string,
    cwd: string,
    permissionPolicy: PermissionPolicy = "read_only",
    options: SessionLaunchOptions = {},
  ): Promise<SessionSnapshot> {
    return this.launch(
      agentId,
      cwd,
      {},
      undefined,
      permissionPolicy,
      acpSessionId,
      options,
    ).then((session) => this.sessionSnapshot(session));
  }

  private async launch(
    agentId: string,
    cwd: string,
    config: Record<string, string>,
    modeId: string | undefined,
    permissionPolicy: PermissionPolicy,
    loadSessionId?: string,
    options: SessionLaunchOptions = {},
  ): Promise<ManagedSession> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Active session limit (${this.maxSessions}) reached`);
    }
    const canonicalId = canonicalAgentId(agentId);
    const def =
      options.agentDefinition ??
      this.agents[canonicalId] ??
      this.agents[agentId];
    if (!def) throw new Error(`Unknown agent: ${canonicalId}`);
    const protocol = def.acpProtocol ?? "v1";
    if (def.supportedProtocols && !def.supportedProtocols.includes(protocol)) {
      throw new Error(
        `Agent profile '${canonicalId}' does not confirm ACP ${protocol} support`,
      );
    }
    const launchDefinition = {
      ...def,
      env: { ...def.protocolEnv?.[protocol], ...def.env },
    };
    const process = await startAgent(launchDefinition, cwd);
    const earlyUpdates: NormalizedAcpUpdate[] = [];
    let wakeStartupUpdate: (() => void) | undefined;
    const driver = createProtocolDriver(protocol, def, process, {
      update: (update) => {
        const managed = [...this.sessions.values()].find(
          (item) => item.acpSessionId === update.sessionId,
        );
        if (!managed) {
          earlyUpdates.push(update);
          wakeStartupUpdate?.();
        } else this.receiveUpdate(managed, update);
      },
      permission: (request) =>
        this.requestPermission(request, permissionPolicy),
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startup = async () => {
        const initialized = await driver.initialize();
        const sessionResponse = loadSessionId
          ? await driver.resumeSession(loadSessionId, cwd)
          : await driver.newSession(cwd);
        const acpId = sessionResponse.sessionId;
        let configOptions = [...sessionResponse.configOptions];
        let configOptionsEarlyUpdateCursor = 0;
        let appliedEarlyUpdates = 0;
        const applyEarlyConfigUpdates = () => {
          for (
            ;
            appliedEarlyUpdates < earlyUpdates.length;
            appliedEarlyUpdates++
          ) {
            const update = earlyUpdates[appliedEarlyUpdates];
            const options = configOptionsFromUpdate(update);
            if (options) configOptions = options;
          }
        };
        let modes = sessionResponse.modes;
        const modelConfigIds = new Set(
          configOptions.flatMap((option) => {
            const id = typeof option.id === "string" ? option.id : undefined;
            if (
              id &&
              (option.category === "model" ||
                ((option.category === undefined || option.category === null) &&
                  id === def.modelConfigId))
            )
              return [id];
            return [];
          }),
        );
        const desired = Object.entries(config).sort(
          ([a], [b]) =>
            Number(modelConfigIds.has(b)) - Number(modelConfigIds.has(a)),
        );
        for (const [configId, value] of desired) {
          applyEarlyConfigUpdates();
          let option = configOptions.find((item) => item.id === configId);
          while (!option && configOptions.length) {
            const received = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => {
                if (wakeStartupUpdate === wake) wakeStartupUpdate = undefined;
                resolve(false);
              }, DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS);
              const wake = () => {
                clearTimeout(timer);
                if (wakeStartupUpdate === wake) wakeStartupUpdate = undefined;
                resolve(true);
              };
              wakeStartupUpdate = wake;
            });
            if (!received) break;
            applyEarlyConfigUpdates();
            option = configOptions.find((item) => item.id === configId);
          }
          if (!option && configOptions.length) {
            throw new Error(`Unknown config option: ${configId}`);
          }
          if (option?.type === "select" && Array.isArray(option.options)) {
            const values = (
              option.options as Array<Record<string, unknown>>
            ).flatMap((entry) =>
              Array.isArray(entry.options)
                ? (entry.options as Array<Record<string, unknown>>)
                : [entry],
            );
            if (
              values.length &&
              !values.some((entry) => entry.value === value)
            ) {
              throw new Error(
                `Invalid value '${value}' for config option '${configId}'`,
              );
            }
          }
          configOptions = await driver.setConfigOption(
            acpId,
            configId,
            value,
            option,
          );
          configOptionsEarlyUpdateCursor = earlyUpdates.length;
        }
        if (modeId) {
          modes =
            (await driver.setMode(acpId, modeId, configOptions, modes)) ??
            modes;
        }
        return {
          initialized,
          sessionResponse,
          configOptions,
          modes,
          configOptionsEarlyUpdateCursor,
        };
      };
      const timedOut = new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => {
          const error = new Error(
            `ACP session startup timed out after ${this.startupTimeoutMs}ms`,
          );
          driver.closeConnection(error);
          reject(error);
        }, this.startupTimeoutMs);
      });
      const {
        initialized,
        sessionResponse,
        configOptions,
        modes,
        configOptionsEarlyUpdateCursor,
      } = await Promise.race([startup(), timedOut]);
      const acpId = sessionResponse.sessionId;
      const session: ManagedSession = {
        id: crypto.randomUUID(),
        agentId: canonicalId,
        agentDefinition: def,
        cwd,
        acpSessionId: acpId,
        acpProtocol: driver.protocol,
        driver,
        process,
        promptActive: false,
        capabilities: initialized.capabilities,
        authMethods: initialized.authMethods,
        configOptions,
        modes,
        events: [],
        nextSequence: 1,
        droppedThrough: 0,
        permissionPolicy,
        pendingPermissions: new Map(),
      };
      this.sessions.set(session.id, session);
      for (const [index, update] of earlyUpdates.entries()) {
        if (update.sessionId === acpId) {
          this.receiveUpdate(
            session,
            update,
            index >= configOptionsEarlyUpdateCursor,
          );
        }
      }
      return session;
    } catch (error) {
      driver.closeConnection(error);
      await stopAgent(process.child, 1000);
      throw new Error(
        `Could not start ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (startupTimer !== undefined) clearTimeout(startupTimer);
    }
  }

  beginPrompt(sessionId: string, text: string): PromptHandle {
    const session = this.requireSession(sessionId);
    if (session.promptActive) {
      throw new Error("A prompt is already active for this session");
    }
    session.promptActive = true;
    const record: PromptRecord = {
      id: crypto.randomUUID(),
      state: "running",
      text: "",
      messageText: new Map(),
      messageOrder: [],
      lastActivityAt: performance.now(),
      activityVersion: 0,
      activityWaiters: new Set(),
      done: Promise.resolve(),
    };
    session.prompt = record;
    record.done = this.consumePrompt(session, record, text);
    return this.promptHandle(record);
  }

  waitForPromptActivity(
    sessionId: string,
    promptId: string,
    activityVersion: number,
  ): { promise: Promise<void>; cancel: () => void } {
    const prompt = this.requirePrompt(sessionId, promptId);
    if (
      prompt.state !== "running" ||
      prompt.activityVersion !== activityVersion
    ) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const waiter = () => {
      prompt.activityWaiters.delete(waiter);
      resolve();
    };
    prompt.activityWaiters.add(waiter);
    return {
      promise,
      cancel: () => prompt.activityWaiters.delete(waiter),
    };
  }

  waitForPromptCompletion(
    sessionId: string,
    promptId: string,
  ): Promise<PromptHandle> {
    const prompt = this.requirePrompt(sessionId, promptId);
    return prompt.done.then(() => this.promptHandle(prompt));
  }

  private recordPromptActivity(session: ManagedSession): void {
    const prompt = session.prompt;
    if (!prompt || prompt.state !== "running") return;
    prompt.lastActivityAt = performance.now();
    prompt.activityVersion++;
    for (const waiter of [...prompt.activityWaiters]) waiter();
  }

  private async consumePrompt(
    session: ManagedSession,
    record: PromptRecord,
    text: string,
  ): Promise<void> {
    try {
      record.stopReason = await session.driver.prompt(
        session.acpSessionId,
        text,
      );
      if (record.state === "running") {
        record.state =
          record.stopReason === "cancelled" ? "cancelled" : "completed";
      }
    } catch (error) {
      if (record.state === "running") {
        record.state = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "number"
        )
          record.errorCode = error.code;
        if (error && typeof error === "object" && "data" in error) {
          record.errorData = error.data;
        }
      }
    } finally {
      session.promptActive = false;
      this.clearPermissionLease(session);
      this.cancelPendingPermissions(session);
    }
  }

  async waitPrompt(
    sessionId: string,
    promptId: string,
    waitMs: number,
  ): Promise<PromptHandle> {
    const prompt = this.requirePrompt(sessionId, promptId);
    if (prompt.state === "running") {
      await Promise.race([
        prompt.done,
        new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs))),
      ]);
    }
    return this.promptHandle(prompt);
  }

  async cancelPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<PromptHandle> {
    const session = this.requireSession(sessionId);
    const prompt = this.requirePrompt(sessionId, promptId);
    if (prompt.state === "running") {
      prompt.state = "cancelled";
      for (const waiter of [...prompt.activityWaiters]) waiter();
      this.cancelPendingPermissions(session);
      this.clearPermissionLease(session);
      await session.driver.cancel(session.acpSessionId);
      await Promise.race([
        prompt.done,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
    return this.promptHandle(prompt);
  }

  getEvents(sessionId: string, afterSequence = 0, limit = 100) {
    const session = this.requireSession(sessionId);
    const events = session.events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, Math.max(1, Math.min(limit, 500)));
    return {
      events: events.map((event) => structuredClone(event)),
      nextSequence:
        events.at(-1)?.sequence ??
        Math.max(afterSequence, session.droppedThrough),
      gap: afterSequence < session.droppedThrough,
      prompt: session.prompt
        ? {
            id: session.prompt.id,
            state: session.prompt.state,
            text: session.prompt.text,
            stopReason: session.prompt.stopReason,
          }
        : undefined,
    };
  }

  private appendEvent(
    session: ManagedSession,
    kind: string,
    update: unknown,
    raw: unknown,
  ): void {
    const event: SessionEvent = {
      sequence: session.nextSequence++,
      timestamp: new Date().toISOString(),
      kind,
      update,
      raw,
    };
    session.events.push(event);
    while (
      session.events.length > 1000 ||
      JSON.stringify(session.events).length > 4 * 1024 * 1024
    ) {
      const removed = session.events.shift();
      if (removed) session.droppedThrough = removed.sequence;
    }
  }

  private receiveUpdate(
    session: ManagedSession,
    updateEvent: NormalizedAcpUpdate,
    applyConfigOptions = true,
  ) {
    this.recordPromptActivity(session);
    const configOptions = configOptionsFromUpdate(updateEvent);
    if (configOptions && applyConfigOptions) {
      session.configOptions = configOptions;
      this.notifyConfigOptionWaiters(session);
    }
    this.appendEvent(
      session,
      updateEvent.kind,
      updateEvent.update,
      updateEvent.raw,
    );
    if (session.prompt?.state === "running" && updateEvent.text) {
      const prompt = session.prompt;
      const messageId = updateEvent.text.messageId;
      if (!messageId) {
        prompt.text += updateEvent.text.text;
      } else {
        if (!prompt.messageText.has(messageId)) {
          prompt.messageOrder.push(messageId);
        }
        const previous = prompt.messageText.get(messageId) ?? "";
        prompt.messageText.set(
          messageId,
          updateEvent.text.replace
            ? updateEvent.text.text
            : previous + updateEvent.text.text,
        );
        prompt.text = prompt.messageOrder
          .map((id) => prompt.messageText.get(id) ?? "")
          .join("");
      }
    }
    if (updateEvent.stopReason && session.prompt?.state === "running") {
      session.prompt.stopReason = updateEvent.stopReason;
      if (updateEvent.stopReason === "cancelled") {
        session.prompt.state = "cancelled";
      } else if (updateEvent.error) {
        session.prompt.state = "failed";
        session.prompt.error =
          updateEvent.error?.message ?? "ACP prompt failed";
        session.prompt.errorCode = updateEvent.error?.code;
        session.prompt.errorData = updateEvent.error?.data;
      } else {
        session.prompt.state = "completed";
      }
      session.promptActive = false;
      this.clearPermissionLease(session);
      this.cancelPendingPermissions(session);
    }
  }

  waitForConfigOptions(
    sessionId: string,
    predicate: (options: Array<Record<string, unknown>>) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const session = this.requireSession(sessionId);
    if (predicate(structuredClone(session.configOptions)) || timeoutMs <= 0) {
      return Promise.resolve(structuredClone(session.configOptions));
    }
    return new Promise((resolve) => {
      const waiters = this.configOptionWaiters.get(sessionId) ?? new Set();
      this.configOptionWaiters.set(sessionId, waiters);
      let abort: (() => void) | undefined;
      const waiter: ConfigOptionWaiter = {
        predicate,
        finish: (options) => {
          clearTimeout(timer);
          if (signal && abort) signal.removeEventListener("abort", abort);
          waiters.delete(waiter);
          if (waiters.size === 0) this.configOptionWaiters.delete(sessionId);
          resolve(structuredClone(options));
        },
      };
      const timer = setTimeout(
        () => waiter.finish(session.configOptions),
        timeoutMs,
      );
      if (signal) {
        abort = () => waiter.finish(session.configOptions);
        signal.addEventListener("abort", abort, { once: true });
      }
      if (signal?.aborted) {
        waiter.finish(session.configOptions);
      } else {
        waiters.add(waiter);
      }
    });
  }

  private notifyConfigOptionWaiters(session: ManagedSession): void {
    const waiters = this.configOptionWaiters.get(session.id);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(structuredClone(session.configOptions))) {
        waiter.finish(session.configOptions);
      }
    }
  }

  async prompt(
    sessionId: string,
    text: string,
  ): Promise<{ stopReason?: string; text: string; promptId?: string }> {
    const prompt = this.beginPrompt(sessionId, text);
    await prompt.done;
    if (prompt.state === "failed") {
      throw new Error(prompt.error ?? "Prompt failed");
    }
    return { stopReason: prompt.stopReason, text: prompt.text };
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
    const session = this.requireSession(sessionId);
    const option = session.configOptions.find((item) => item.id === configId);
    if (!option && session.configOptions.length) {
      throw new Error(`Unknown config option: ${configId}`);
    }
    if (option?.type === "select" && Array.isArray(option.options)) {
      const values = (option.options as Array<Record<string, unknown>>).flatMap(
        (entry) =>
          Array.isArray(entry.options)
            ? (entry.options as Array<Record<string, unknown>>)
            : [entry],
      );
      if (values.length && !values.some((entry) => entry.value === value)) {
        throw new Error(
          `Invalid value '${value}' for config option '${configId}'`,
        );
      }
    }
    session.configOptions = await session.driver.setConfigOption(
      session.acpSessionId,
      configId,
      value,
      option,
    );
    if (
      option?.category === "model" ||
      configId === session.agentDefinition.modelConfigId ||
      configId === session.agentDefinition.models?.thinkingEffort?.configOption
    )
      session.modelSelection = undefined;
    return structuredClone(session.configOptions);
  }

  async setMode(sessionId: string, modeId: string) {
    const session = this.requireSession(sessionId);
    session.modes = await session.driver.setMode(
      session.acpSessionId,
      modeId,
      session.configOptions,
      session.modes,
    );
    return structuredClone(session.modes);
  }

  private async requestPermission(
    params: AcpPermissionRequest,
    policy: PermissionPolicy,
  ) {
    const session = [...this.sessions.values()].find(
      (item) => item.acpSessionId === params.sessionId,
    );
    const options = params.options ?? [];
    const choose = (kind: string) =>
      options.find((option) => option.kind === kind);
    if (!session) return { outcome: { outcome: "cancelled" as const } };
    this.recordPromptActivity(session);
    const requestId = crypto.randomUUID();
    const raw = {
      sessionId: params.sessionId,
      toolCall: params.toolCall,
      options,
    };
    this.appendEvent(session, "permission_request", { requestId, ...raw }, raw);
    if (policy === "operator") {
      return await new Promise<{
        outcome:
          | { outcome: "selected"; optionId: string }
          | {
              outcome: "cancelled";
            };
      }>((resolve) => {
        session.pendingPermissions.set(requestId, {
          id: requestId,
          toolCall: params.toolCall,
          options,
          resolve,
        });
      });
    }
    const kind = (params.toolCall as { kind?: string | null } | undefined)
      ?.kind;
    const permit =
      policy === "allow_all" ||
      (policy === "read_only" &&
        ["read", "search", "fetch", "think"].includes(kind ?? ""));
    const option = permit
      ? (choose("allow_once") ?? choose("allow_always"))
      : (choose("reject_once") ?? choose("reject_always"));
    return {
      outcome: option
        ? { outcome: "selected" as const, optionId: option.optionId }
        : { outcome: "cancelled" as const },
    };
  }

  beginPermissionContinuation(
    sessionId: string,
    leaseTimeoutMs: number,
  ): PendingPermissionSnapshot | undefined {
    const session = this.requireSession(sessionId);
    if (session.prompt?.state !== "running") return undefined;
    const pending = session.pendingPermissions.values().next().value as
      | PendingPermission
      | undefined;
    if (!pending) return undefined;

    this.clearPermissionLease(session);
    session.permissionLease = setTimeout(() => {
      session.permissionLease = undefined;
      const current = this.sessions.get(sessionId);
      if (
        current !== session ||
        current.prompt?.state !== "running" ||
        !current.pendingPermissions.has(pending.id)
      )
        return;
      void this.close(sessionId).catch(() => undefined);
    }, leaseTimeoutMs);

    return {
      id: pending.id,
      toolCall: structuredClone(pending.toolCall),
      options: structuredClone(pending.options),
    };
  }

  resolvePermission(sessionId: string, permissionId: string, optionId: string) {
    const session = this.requireSession(sessionId);
    const pending = session.pendingPermissions.get(permissionId);
    if (!pending) {
      throw new Error(`Unknown permission request: ${permissionId}`);
    }
    if (!pending.options.some((option) => option.optionId === optionId)) {
      throw new Error(`Invalid permission option: ${optionId}`);
    }
    pending.resolve({ outcome: { outcome: "selected", optionId } });
    session.pendingPermissions.delete(permissionId);
    this.clearPermissionLease(session);
    return { permissionId, optionId, resolved: true };
  }

  async close(id: string): Promise<void> {
    const session = this.requireSession(id);
    if (session.prompt?.state === "running") {
      try {
        await this.cancelPrompt(id, session.prompt.id);
      } catch {
        /* Closing the connection remains authoritative. */
      }
    }
    this.clearPermissionLease(session);
    for (const waiter of [...(this.configOptionWaiters.get(id) ?? [])])
      waiter.finish(session.configOptions);
    this.cancelPendingPermissions(session);
    this.sessions.delete(id);
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closeRequest = session.driver
      .closeSession(session.acpSessionId)
      .catch(() => undefined);
    await Promise.race([
      closeRequest,
      new Promise<void>((resolve) => {
        closeTimer = setTimeout(resolve, this.closeRequestTimeoutMs);
      }),
    ]);
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    session.driver.closeConnection();
    await stopAgent(session.process.child, 5000);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.close(id)),
    );
  }
}
