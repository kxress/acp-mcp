import process from "node:process";
import * as nodeFs from "#fs";
import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import {
  canonicalAgentId,
  type AgentDefinition,
  type AgentMap,
} from "../agents/config.ts";
import type { ResolvedConfiguration } from "../config/discovery.ts";
import {
  type AgentFailureClassifiers,
  classifyAgentFailure,
} from "../agents/failure_classifiers.ts";
import { classifyOpenCodeFailure } from "../agents/opencode_failure_classifier.ts";
import { findExecutablePath } from "../runtime/process.ts";
import { discoverAdvertisedModels } from "../models/discovery.ts";
import {
  filterModels,
  isModelAllowed,
  type ModelSelectionRequest,
  policyFilteredModels,
  resolveModelSelection,
} from "../models/policy.ts";
import { MODEL_SIZES, THINKING_EFFORTS } from "../models/policy.ts";
import {
  enrichAdvertisedModels,
  fetchOpenCodeCatalog,
  type OpenCodeCatalog,
} from "../models/opencode_catalog.ts";
import {
  DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS,
  SessionManager,
} from "../sessions/manager.ts";
import { cleanupStaleWorkspaceSnapshots } from "../workspaces/stale_cleanup.ts";
import { VERSION } from "../version.ts";

type McpServerOptions = {
  loadOpenCodeCatalog?: (signal: AbortSignal) => Promise<OpenCodeCatalog>;
  failureClassifiers?: AgentFailureClassifiers;
  workspaceCleanupRemove?: typeof nodeFs.removePath;
  workspaceCleanupIsProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  resolveConfiguration?: (cwd?: string) => Promise<ResolvedConfiguration>;
};

const defaultFailureClassifiers: AgentFailureClassifiers = {
  opencode: classifyOpenCodeFailure,
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => {
    if (abort) signal.removeEventListener("abort", abort);
  });
}

function runTaskFailure(
  status: "failed" | "timed_out" | "cancelled",
  kind: string,
  stage: string,
  acpCode?: number,
  classification?: ReturnType<typeof classifyAgentFailure>,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          status,
          error: {
            kind,
            stage,
            ...(acpCode === undefined ? {} : { acpCode }),
            ...(classification ? { classification } : {}),
          },
        }),
      },
    ],
  };
}

function workspaceId(path: string) {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function workspaceEntrySummaries(
  entries: Array<{
    path: string;
    status: string;
    ageMs?: number;
    kind?: string;
    reason?: string;
  }>,
) {
  return entries
    .filter((entry) => /^plan-[a-z0-9]+$/i.test(workspaceId(entry.path)))
    .map((entry) => ({
      workspaceId: workspaceId(entry.path),
      status: entry.status,
      ...(entry.ageMs === undefined ? {} : { ageMs: entry.ageMs }),
      ...(entry.kind === undefined ? {} : { kind: entry.kind }),
      ...(entry.reason === undefined
        ? {}
        : { reason: entry.reason.split(":", 1)[0] }),
    }));
}

function reasonCounts(entries: Array<{ reason?: string }>) {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const reason = entry.reason?.split(":", 1)[0] ?? "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

async function waitForModelCatalog(
  manager: SessionManager,
  sessionId: string,
  agent: AgentDefinition,
  configOptions: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  if (discoverAdvertisedModels(configOptions, agent).length) {
    return configOptions;
  }
  return await manager.waitForConfigOptions(
    sessionId,
    (options) => discoverAdvertisedModels(options, agent).length > 0,
    DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS,
  );
}

function isModelOption(
  option: Record<string, unknown>,
  agent: AgentDefinition,
): boolean {
  return (
    option.type === "select" &&
    (option.category === "model" ||
      ((option.category === undefined || option.category === null) &&
        option.id === agent.modelConfigId))
  );
}

function configOptionIds(configOptions: Array<Record<string, unknown>>) {
  return new Set(
    configOptions.flatMap((option) =>
      typeof option.id === "string" ? [option.id] : [],
    ),
  );
}

function advertisedOptionValues(option: Record<string, unknown>): string[] {
  if (!Array.isArray(option.options)) return [];
  return option.options.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.options) && typeof record.value !== "string") {
      return advertisedOptionValues(record);
    }
    return typeof record.value === "string" ? [record.value] : [];
  });
}

async function waitForThinkingChoice(
  manager: SessionManager,
  sessionId: string,
  options: Array<Record<string, unknown>>,
  agent: AgentDefinition,
) {
  const mapping = agent.models?.thinkingEffort;
  if (!mapping) return options;
  const mappedValues = new Set(Object.values(mapping.values));
  const hasChoice = (current: Array<Record<string, unknown>>) => {
    const option = current.find((item) => item.id === mapping.configOption);
    if (!option || option.type !== "select") return false;
    const values = advertisedOptionValues(option);
    return values.some((value) => mappedValues.has(value));
  };
  if (hasChoice(options)) return options;
  return await manager.waitForConfigOptions(
    sessionId,
    hasChoice,
    DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS,
  );
}

async function applyRequestSelection(
  manager: SessionManager,
  sessionId: string,
  agent: AgentDefinition,
  modelRequest: ModelSelectionRequest,
  requestConfig: Record<string, string> = {},
) {
  const policy = agent.models ?? {};
  let options = manager.getSessionSnapshot(sessionId).configOptions;
  const mayNeedModel =
    modelRequest.model !== undefined ||
    modelRequest.modelSize !== undefined ||
    modelRequest.thinkingEffort !== undefined ||
    policy.default !== undefined ||
    policy.allowedModels !== undefined ||
    policy.deniedModels !== undefined ||
    Object.keys(requestConfig).length > 0;
  if (mayNeedModel) {
    options = await waitForModelCatalog(manager, sessionId, agent, options);
  }
  if (Object.keys(requestConfig).length) {
    const ids = configOptionIds(options);
    const missing = Object.keys(requestConfig).filter((id) => !ids.has(id));
    if (missing.length) {
      options = await manager.waitForConfigOptions(
        sessionId,
        (updated) => {
          const updatedIds = configOptionIds(updated);
          return missing.every((id) => updatedIds.has(id));
        },
        DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS,
      );
    }
  }
  const modelOptions = options.filter((option) => isModelOption(option, agent));
  const modelConfigIds = new Set(
    modelOptions.flatMap((option) =>
      typeof option.id === "string" ? [option.id] : [],
    ),
  );
  const configuredModelEntries = Object.entries(requestConfig).filter(([id]) =>
    modelConfigIds.has(id),
  );
  if (configuredModelEntries.length > 1) {
    throw new Error(
      "Only one ACP model config option may be selected per request",
    );
  }
  let requested: ModelSelectionRequest = { ...modelRequest };
  if (configuredModelEntries.length) {
    const [configId, model] = configuredModelEntries[0];
    if (requested.modelSize) {
      throw new Error("config model and modelSize are mutually exclusive");
    }
    if (requested.model && requested.model !== model) {
      throw new Error("config model conflicts with the model request");
    }
    requested = { ...requested, model };
    requestConfig = Object.fromEntries(
      Object.entries(requestConfig).filter(([id]) => id !== configId),
    );
  }

  const effortMapping = policy.thinkingEffort;
  if (effortMapping && effortMapping.configOption in requestConfig) {
    const raw = requestConfig[effortMapping.configOption];
    const normalized = Object.entries(effortMapping.values).find(
      ([, value]) => value === raw,
    )?.[0];
    if (!normalized) {
      throw new Error(
        `Config value '${raw}' is not mapped by normalized thinkingEffort policy`,
      );
    }
    if (requested.thinkingEffort && requested.thinkingEffort !== normalized) {
      throw new Error(
        "config thinking effort conflicts with thinkingEffort request",
      );
    }
    requested = {
      ...requested,
      thinkingEffort: normalized as ModelSelectionRequest["thinkingEffort"],
    };
    requestConfig = Object.fromEntries(
      Object.entries(requestConfig).filter(
        ([id]) => id !== effortMapping.configOption,
      ),
    );
  }

  for (const [id, value] of Object.entries(requestConfig)) {
    options = await manager.setConfigOption(sessionId, id, value);
  }

  const requestedEffort =
    requested.thinkingEffort ?? policy.default?.thinkingEffort;
  if (requestedEffort) {
    options = await waitForThinkingChoice(manager, sessionId, options, agent);
  }

  let advertised = discoverAdvertisedModels(options, agent);
  let selection = resolveModelSelection(advertised, options, policy, requested);
  const currentModelValue = options.find(
    (option) => option.id === selection.configId,
  )?.currentValue;
  if (
    selection.configId &&
    selection.configValue !== undefined &&
    currentModelValue !== selection.configValue
  ) {
    options = await manager.setConfigOption(
      sessionId,
      selection.configId,
      selection.configValue,
    );
    if (requestedEffort) {
      options = await waitForThinkingChoice(manager, sessionId, options, agent);
    }
    advertised = discoverAdvertisedModels(options, agent);
    selection = resolveModelSelection(advertised, options, policy, requested);
  }
  const currentThinkingValue = options.find(
    (option) => option.id === selection.thinkingConfigId,
  )?.currentValue;
  if (
    selection.thinkingConfigId &&
    selection.thinkingConfigValue !== undefined &&
    currentThinkingValue !== selection.thinkingConfigValue
  ) {
    options = await manager.setConfigOption(
      sessionId,
      selection.thinkingConfigId,
      selection.thinkingConfigValue,
    );
  }
  manager.recordModelSelection(
    sessionId,
    selection.model
      ? {
          model: selection.model.id,
          ...(selection.modelSize ? { modelSize: selection.modelSize } : {}),
          ...(selection.thinkingEffort
            ? { thinkingEffort: selection.thinkingEffort }
            : {}),
        }
      : undefined,
  );
  return { selection, configOptions: options };
}

export function createMcpServer(
  agents: AgentMap,
  manager: SessionManager,
  options: McpServerOptions = {},
) {
  const server = new McpServer({ name: "acp-mcp", version: VERSION });
  const loadOpenCodeCatalog =
    options.loadOpenCodeCatalog ?? ((signal) => fetchOpenCodeCatalog(signal));
  const failureClassifiers = {
    ...defaultFailureClassifiers,
    ...options.failureClassifiers,
  };
  const resolveOperationConfig =
    options.resolveConfiguration ??
    ((cwd?: string): Promise<ResolvedConfiguration> =>
      Promise.resolve({
        agents,
        sources: [],
        cwd: cwd ?? process.cwd(),
        explicit: false,
      }));
  const launchOptions = (agentDefinition: AgentDefinition) =>
    options.resolveConfiguration ? { agentDefinition } : {};
  server.registerTool(
    "list_stale_workspaces",
    {
      description:
        "Inspect acp-mcp-owned disposable workspaces eligible for stale cleanup. This never deletes workspaces. The default age threshold is 24 hours.",
      annotations: {
        title: "List stale workspaces",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.strictObject({
        olderThanMs: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Minimum workspace age in milliseconds (defaults to 86400000)",
          ),
      }),
    },
    async ({ olderThanMs }) => {
      try {
        const result = await cleanupStaleWorkspaceSnapshots({
          olderThanMs,
          ...(options.workspaceCleanupIsProcessAlive
            ? { isProcessAlive: options.workspaceCleanupIsProcessAlive }
            : {}),
        });
        const candidates = result.entries.filter(
          (entry) => entry.status === "eligible",
        );
        const skippedEntries = result.entries.filter(
          (entry) => entry.status === "skipped",
        );
        const failedEntries = result.entries.filter(
          (entry) => entry.status === "failed",
        );
        const summary = {
          status: failedEntries.length ? "failed" : "completed",
          root: result.root,
          olderThanMs: result.olderThanMs,
          candidates: workspaceEntrySummaries(candidates),
          skipped: result.skipped,
          skippedByReason: reasonCounts(skippedEntries),
          failed: result.failed,
          failures: workspaceEntrySummaries(failedEntries),
        };
        return {
          ...(result.failed ? { isError: true } : {}),
          content: [{ type: "text" as const, text: JSON.stringify(summary) }],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "failed",
                stage: "workspace_list",
              }),
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "cleanup_stale_workspaces",
    {
      description:
        "Delete all eligible stale acp-mcp-owned disposable workspaces. Only valid managed workspaces older than the threshold are removed; recent, active, unknown, and invalid entries are preserved. The default age threshold is 24 hours.",
      annotations: {
        title: "Clean up stale workspaces",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.strictObject({
        olderThanMs: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Minimum workspace age in milliseconds (defaults to 86400000)",
          ),
      }),
    },
    async ({ olderThanMs }) => {
      try {
        const result = await cleanupStaleWorkspaceSnapshots({
          olderThanMs,
          delete: true,
          ...(options.workspaceCleanupRemove
            ? { remove: options.workspaceCleanupRemove }
            : {}),
          ...(options.workspaceCleanupIsProcessAlive
            ? { isProcessAlive: options.workspaceCleanupIsProcessAlive }
            : {}),
        });
        const failures = workspaceEntrySummaries(
          result.entries.filter((entry) => entry.status === "failed"),
        );
        const summary = {
          status: result.failed ? "failed" : "completed",
          root: result.root,
          olderThanMs: result.olderThanMs,
          removed: result.removed,
          skipped: result.skipped,
          skippedByReason: reasonCounts(
            result.entries.filter((entry) => entry.status === "skipped"),
          ),
          failed: result.failed,
          failures,
          entries: workspaceEntrySummaries(result.entries),
        };
        return {
          ...(result.failed ? { isError: true } : {}),
          content: [{ type: "text" as const, text: JSON.stringify(summary) }],
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "failed",
                stage: "workspace_cleanup",
              }),
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "list_agents",
    {
      description:
        "List configured ACP agents and whether their launch executable is present. commandFound does not verify authentication or provider access.",
      annotations: {
        title: "List ACP agents",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({ cwd: z.string().optional() }),
    },
    async ({ cwd }): Promise<CallToolResult> => {
      const resolved = await resolveOperationConfig(cwd);
      const listedAgents = await Promise.all(
        Object.entries(resolved.agents).map(async ([id, agent]) => ({
          id,
          displayName: agent.displayName ?? id,
          ...(agent.implementation
            ? { implementation: agent.implementation }
            : {}),
          acpProtocol: agent.acpProtocol ?? "v1",
          supportedProtocols: agent.supportedProtocols,
          ...(agent.models
            ? {
                modelPolicy: {
                  default: agent.models.default,
                  allowedModels: agent.models.allowedModels,
                  deniedModels: agent.models.deniedModels,
                },
              }
            : {}),
          commandFound: !!(await findExecutablePath(agent.command)),
          installHint: agent.installHint,
        })),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(listedAgents),
          },
        ],
      };
    },
  );
  server.registerTool(
    "start_session",
    {
      description: "Start an ACP session and optionally send an initial prompt",
      annotations: {
        title: "Start ACP session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        agentId: z.string(),
        cwd: z.string().optional(),
        config: z.record(z.string(), z.string()).optional(),
        model: z.string().optional(),
        modelSize: z.enum(MODEL_SIZES).optional(),
        thinkingEffort: z.enum(THINKING_EFFORTS).optional(),
        modeId: z.string().optional(),
        permissionPolicy: z
          .enum(["read_only", "operator", "allow_all", "deny_all"])
          .optional(),
        prompt: z.string().optional(),
      },
    },
    async ({
      agentId: requestedAgentId,
      cwd,
      config,
      model,
      modelSize,
      thinkingEffort,
      modeId,
      permissionPolicy,
      prompt,
    }) => {
      const agentId = canonicalAgentId(requestedAgentId);
      try {
        const resolved = await resolveOperationConfig(cwd);
        const agent = resolved.agents[agentId];
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const session = await manager.start(
          agentId,
          cwd,
          {},
          modeId,
          permissionPolicy,
          launchOptions(agent),
        );
        try {
          await applyRequestSelection(
            manager,
            session.id,
            agent,
            {
              model,
              modelSize,
              thinkingEffort,
            },
            config,
          );
          const result = prompt
            ? await manager.prompt(session.id, prompt)
            : undefined;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionId: session.id,
                  acpSessionId: session.acpSessionId,
                  agentId,
                  acpProtocol: session.acpProtocol,
                  result,
                }),
              },
            ],
          };
        } catch (e) {
          await manager.close(session.id);
          throw e;
        }
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "run_task",
    {
      description:
        "Run one task through a configured ACP agent and return only its final answer. Failures include a compact generic kind and stage; ACP codes are protocol codes, not provider HTTP status. No automatic retries or model fallback are performed. Use explicit session tools for multi-turn work or event inspection. The task and repository content read by the agent may be sent to its configured model provider; permissionPolicy does not prevent external data disclosure. permissionPolicy controls only ACP session/request_permission responses. read_only allows agent-reported read, search, fetch, and think kinds and rejects other requested kinds; agents may act without requesting permission. This is not filesystem isolation or an OS sandbox. Host approval policies still apply.",
      annotations: {
        title: "Run ACP task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        agentId: z.string().describe("Configured ACP agent to run"),
        task: z
          .string()
          .describe(
            "Task instructions. Repository context is read by the ACP agent; do not include file contents unless intended for its model provider.",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory the ACP agent may inspect. Files it reads may be sent to its configured model provider.",
          ),
        config: z
          .record(z.string(), z.string())
          .optional()
          .describe("Generic ACP configuration options, such as a model ID"),
        model: z
          .string()
          .optional()
          .describe("Exact model ID advertised by the agent"),
        modelSize: z
          .enum(MODEL_SIZES)
          .optional()
          .describe("Configured model-size mapping"),
        thinkingEffort: z
          .enum(THINKING_EFFORTS)
          .optional()
          .describe("Normalized thinking-effort request"),
        modeId: z.string().optional(),
        permissionPolicy: z
          .enum(["read_only", "operator", "allow_all", "deny_all"])
          .optional()
          .describe(
            "ACP session/request_permission response policy (defaults to read_only). read_only allows agent-reported read, search, fetch, and think kinds and rejects other requested kinds. Agents may act without requesting permission; this does not sandbox the process or keep data local.",
          ),
        idleTimeoutMs: z
          .number()
          .int()
          .min(1)
          .max(3600000)
          .optional()
          .describe(
            "Maximum consecutive time without ACP activity (defaults to 600000); active tasks may run longer",
          ),
        permissionLeaseMs: z
          .number()
          .int()
          .min(1)
          .max(600000)
          .optional()
          .describe(
            "How long an unresolved operator permission handoff remains available (defaults to 120000)",
          ),
      },
    },
    async (
      {
        agentId: requestedAgentId,
        task: text,
        cwd,
        config,
        model,
        modelSize,
        thinkingEffort,
        modeId,
        permissionPolicy = "read_only",
        idleTimeoutMs = 600000,
        permissionLeaseMs = 120000,
      },
      extra,
    ) => {
      const agentId = canonicalAgentId(requestedAgentId);
      let sessionId: string | undefined;
      let effectiveAgents = agents;
      let selectedModelForFailure: string | undefined;
      let closed = false;
      let failureStage = "session_start";
      let promptRecord: ReturnType<SessionManager["beginPrompt"]> | undefined;
      let abortHandler: (() => void) | undefined;
      const close = async () => {
        if (!sessionId || closed) return;
        closed = true;
        try {
          await manager.close(sessionId);
        } catch {
          /* already closed */
        }
      };
      try {
        const resolved = await resolveOperationConfig(cwd);
        effectiveAgents = resolved.agents;
        const agent = resolved.agents[agentId];
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const session = await manager.start(
          agentId,
          cwd,
          {},
          modeId,
          permissionPolicy,
          launchOptions(agent),
        );
        sessionId = session.id;
        failureStage = "model_selection";
        const appliedSelection = await applyRequestSelection(
          manager,
          session.id,
          agent,
          {
            model,
            modelSize,
            thinkingEffort,
          },
          config,
        );
        selectedModelForFailure = appliedSelection.selection.model?.id;
        failureStage = "prompt_start";
        promptRecord = manager.beginPrompt(session.id, text);
        failureStage = "prompt";
        const signal = extra.mcpReq.signal;
        let resolveAbort!: () => void;
        const aborted = new Promise<"cancelled">((resolve) => {
          resolveAbort = () => resolve("cancelled");
        });
        if (signal.aborted) resolveAbort();
        else {
          abortHandler = resolveAbort;
          signal.addEventListener("abort", abortHandler, { once: true });
        }
        while (promptRecord.state === "running") {
          if (signal?.aborted) {
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("cancelled", "cancelled", "prompt");
          }
          if (permissionPolicy === "operator") {
            const pending = manager.beginPermissionContinuation(
              session.id,
              permissionLeaseMs,
            );
            if (pending) {
              const call = pending.toolCall as Record<string, unknown> | null;
              const action =
                call && typeof call === "object"
                  ? Object.fromEntries(
                      ["kind", "title", "name"].flatMap((key) =>
                        typeof call[key] === "string" ? [[key, call[key]]] : [],
                      ),
                    )
                  : {};
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      status: "permission_required",
                      sessionId,
                      permissionId: pending.id,
                      leaseTimeoutMs: permissionLeaseMs,
                      action,
                      choices: pending.options,
                    }),
                  },
                ],
              };
            }
          }
          const activityVersion = promptRecord.activityVersion;
          const remaining =
            idleTimeoutMs - (performance.now() - promptRecord.lastActivityAt);
          if (remaining <= 0) {
            if (signal.aborted) {
              await manager.cancelPrompt(session.id, promptRecord.id);
              await close();
              return runTaskFailure("cancelled", "cancelled", "prompt");
            }
            if (
              promptRecord.activityVersion !== activityVersion ||
              performance.now() - promptRecord.lastActivityAt < idleTimeoutMs
            )
              continue;
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("timed_out", "timeout", "prompt");
          }
          const activity = manager.waitForPromptActivity(
            session.id,
            promptRecord.id,
            activityVersion,
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idleExpired = new Promise<"idle_timeout">((resolve) => {
            timer = setTimeout(() => resolve("idle_timeout"), remaining);
          });
          const outcome = await Promise.race([
            promptRecord.done.then(() => "prompt_done" as const),
            activity.promise.then(() => "activity" as const),
            idleExpired,
            aborted,
          ]);
          if (timer !== undefined) clearTimeout(timer);
          activity.cancel();
          if (outcome === "cancelled" || signal.aborted) {
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("cancelled", "cancelled", "prompt");
          }
          if (outcome === "idle_timeout") {
            if (
              promptRecord.activityVersion !== activityVersion ||
              performance.now() - promptRecord.lastActivityAt < idleTimeoutMs
            )
              continue;
            await manager.cancelPrompt(session.id, promptRecord.id);
            await close();
            return runTaskFailure("timed_out", "timeout", "prompt");
          }
        }
        if (promptRecord.state === "completed") {
          if (!promptRecord.text.trim()) {
            await close();
            return runTaskFailure(
              "failed",
              "invalid_response",
              "prompt_complete",
            );
          }
          const result = {
            status: "completed",
            response: promptRecord.text,
            stopReason: promptRecord.stopReason,
          };
          await close();
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        if (promptRecord.state === "cancelled") {
          await close();
          return runTaskFailure("cancelled", "cancelled", "prompt");
        }
        await close();
        const classification = classifyAgentFailure(
          effectiveAgents,
          failureClassifiers,
          agentId,
          {
            agentId,
            model: effectiveAgents[agentId]?.modelConfigId
              ? (config?.[effectiveAgents[agentId].modelConfigId!] ??
                selectedModelForFailure)
              : selectedModelForFailure,
            stage: "prompt",
            acpCode: promptRecord.errorCode,
            errorMessage: promptRecord.error,
            errorData: promptRecord.errorData,
          },
        );
        return runTaskFailure(
          "failed",
          "prompt_failed",
          "prompt",
          promptRecord.errorCode,
          classification,
        );
      } catch (error) {
        await close();
        if (failureStage === "model_selection") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "failed",
                  error: {
                    kind: "model_selection",
                    stage: "model_selection",
                    message:
                      error instanceof Error
                        ? error.message
                        : "Model selection failed",
                  },
                }),
              },
            ],
          };
        }
        return runTaskFailure(
          "failed",
          failureStage === "session_start"
            ? "session_start_failed"
            : "prompt_start_failed",
          failureStage,
          promptRecord?.errorCode,
        );
      } finally {
        if (abortHandler) {
          extra.mcpReq.signal.removeEventListener("abort", abortHandler);
        }
      }
    },
  );
  server.registerTool(
    "list_models",
    {
      description:
        "List model choices advertised by a live ACP session, with optional OpenCode metadata",
      annotations: {
        title: "List ACP models",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        agentId: z.string(),
        cwd: z.string().optional(),
        enrich: z.boolean().optional(),
        timeoutMs: z.number().int().min(1).max(120000).optional(),
      },
    },
    async (
      { agentId: requestedAgentId, cwd, enrich = false, timeoutMs = 30000 },
      extra,
    ) => {
      const agentId = canonicalAgentId(requestedAgentId);
      const resolved = await resolveOperationConfig(cwd);
      const definition = resolved.agents[agentId];
      if (!definition) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "failed",
                stage: "acp_discovery",
              }),
            },
          ],
        };
      }
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([extra.mcpReq.signal, timeoutSignal]);
      let session: Awaited<ReturnType<typeof manager.start>> | undefined;
      let startPromise: ReturnType<typeof manager.start> | undefined;
      try {
        startPromise = manager.start(
          agentId,
          cwd,
          {},
          undefined,
          "read_only",
          launchOptions(definition),
        );
        session = await abortable(startPromise, signal);
        if (extra.mcpReq.signal.aborted) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "failed", stage: "cancelled" }),
              },
            ],
          };
        }
        let effectiveConfigOptions = session.configOptions;
        let liveModels = discoverAdvertisedModels(
          effectiveConfigOptions,
          definition,
        );
        if (!liveModels.length) {
          const updatedOptions = await abortable(
            manager.waitForConfigOptions(
              session.id,
              (options) =>
                discoverAdvertisedModels(options, definition).length > 0,
              Math.min(timeoutMs, DEFAULT_ASYNC_CONFIG_OPTION_TIMEOUT_MS),
              signal,
            ),
            signal,
          );
          effectiveConfigOptions = updatedOptions;
          liveModels = discoverAdvertisedModels(updatedOptions, definition);
        }
        const policy = definition.models ?? {};
        const models = filterModels(liveModels, policy);
        let defaultSelection: ReturnType<typeof resolveModelSelection>;
        try {
          defaultSelection = resolveModelSelection(
            policy.default ? liveModels : models,
            effectiveConfigOptions,
            policy,
            {},
          );
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "failed",
                  stage: "model_policy",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Configured model policy could not be resolved",
                }),
              },
            ],
          };
        }
        let enrichedModels = policyFilteredModels(models, policy);
        if (defaultSelection.model) {
          enrichedModels = enrichedModels.map((model) => ({
            ...model,
            ...(model.id === defaultSelection.model!.id
              ? { isDefault: true }
              : {}),
          }));
        }
        let enrichment: {
          source?: string;
          status: string;
          sourceUrls?: string[];
        };
        if (!enrich) {
          enrichment = { status: "not_requested" };
        } else if (definition.modelEnrichment !== "opencode_catalog") {
          enrichment = { status: "not_supported" };
        } else {
          try {
            const catalog = await loadOpenCodeCatalog(signal);
            enrichedModels = enrichAdvertisedModels(enrichedModels, catalog);
            enrichment = {
              source: "opencode_catalog",
              status: "available",
              sourceUrls: [
                "https://opencode.ai/docs/zen/",
                "https://opencode.ai/docs/go/",
              ],
            };
          } catch {
            if (extra.mcpReq.signal.aborted) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      status: "failed",
                      stage: "cancelled",
                    }),
                  },
                ],
              };
            }
            enrichedModels = policyFilteredModels(models, policy);
            enrichment = {
              source: "opencode_catalog",
              status: "unavailable",
              sourceUrls: [
                "https://opencode.ai/docs/zen/",
                "https://opencode.ai/docs/go/",
              ],
            };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "completed",
                availabilitySource: "acp",
                models: enrichedModels,
                enrichment,
              }),
            },
          ],
        };
      } catch {
        const timedOut = timeoutSignal.aborted && !extra.mcpReq.signal.aborted;
        if (!session && startPromise) {
          void startPromise
            .then((lateSession) => manager.close(lateSession.id))
            .catch(() => undefined);
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: timedOut ? "timed_out" : "failed",
                stage: "acp_discovery",
              }),
            },
          ],
        };
      } finally {
        if (session) {
          try {
            await manager.close(session.id);
          } catch {
            /* Session may have closed during request cancellation. */
          }
        }
      }
    },
  );
  server.registerTool(
    "load_session",
    {
      description:
        "Load an existing ACP session when the agent advertises session/load support",
      annotations: {
        title: "Load ACP session",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        agentId: z.string(),
        acpSessionId: z.string(),
        cwd: z.string(),
        permissionPolicy: z
          .enum(["read_only", "operator", "allow_all", "deny_all"])
          .optional(),
      },
    },
    async ({
      agentId: requestedAgentId,
      acpSessionId,
      cwd,
      permissionPolicy,
    }) => {
      const agentId = canonicalAgentId(requestedAgentId);
      let managedSessionId: string | undefined;
      try {
        const resolved = await resolveOperationConfig(cwd);
        const agent = resolved.agents[agentId];
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const session = await manager.load(
          agentId,
          acpSessionId,
          cwd,
          permissionPolicy,
          launchOptions(agent),
        );
        managedSessionId = session.id;
        let configOptions = session.configOptions;
        let models = discoverAdvertisedModels(configOptions, agent);
        if (
          !models.some((model) => model.selected) &&
          (agent.models?.allowedModels || agent.models?.deniedModels)
        ) {
          configOptions = await waitForModelCatalog(
            manager,
            session.id,
            agent,
            configOptions,
          );
          models = discoverAdvertisedModels(configOptions, agent);
        }
        const current = models.find((model) => model.selected);
        if (
          (agent.models?.allowedModels || agent.models?.deniedModels) &&
          (!current || !isModelAllowed(agent.models, current.id))
        ) {
          await manager.close(session.id);
          throw new Error(
            current
              ? `Resumed model '${current.id}' is denied by current model policy`
              : "Cannot verify resumed model against current model policy because ACP did not identify it",
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionId: session.id,
                acpSessionId: session.acpSessionId,
                agentId,
                acpProtocol: session.acpProtocol,
                configOptions,
                modes: session.modes,
              }),
            },
          ],
        };
      } catch (e) {
        if (managedSessionId) {
          try {
            await manager.close(managedSessionId);
          } catch {
            /* startup or policy validation already closed it */
          }
        }
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "prompt",
    {
      description:
        "Send a prompt to an active ACP session; wait=false returns a prompt ID for polling",
      annotations: {
        title: "Prompt ACP session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        sessionId: z.string(),
        text: z.string(),
        wait: z.boolean().optional(),
        waitMs: z.number().int().min(0).max(120000).optional(),
      },
    },
    async ({ sessionId, text, wait = true, waitMs = 60000 }) => {
      try {
        const prompt = manager.beginPrompt(sessionId, text);
        if (wait) await manager.waitPrompt(sessionId, prompt.id, waitMs);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                promptId: prompt.id,
                state: prompt.state,
                text: prompt.text,
                stopReason: prompt.stopReason,
                error: prompt.error,
              }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "get_events",
    {
      description:
        "Read buffered ACP session updates after a sequence cursor. Pass nextSequence as afterSequence to read the next page, even when hidden thoughts leave an empty page. An unchanged cursor means there are no newer buffered events. gap reports dropped events.",
      annotations: {
        title: "Get ACP events",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        sessionId: z.string(),
        afterSequence: z.number().int().min(0).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum journal events scanned before thought filtering"),
        waitMs: z.number().int().min(0).max(30000).optional(),
        includeRaw: z.boolean().optional(),
        includeThoughts: z.boolean().optional(),
      },
    },
    async ({
      sessionId,
      afterSequence = 0,
      limit = 100,
      waitMs = 0,
      includeRaw = false,
      includeThoughts = false,
    }) => {
      try {
        if (
          waitMs > 0 &&
          manager.getEvents(sessionId, afterSequence, limit).events.length === 0
        )
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        const result = manager.getEvents(sessionId, afterSequence, limit);
        const events = result.events
          .filter(
            (event) =>
              includeThoughts || !event.kind.toLowerCase().includes("thought"),
          )
          .map(({ raw, ...event }) => (includeRaw ? { ...event, raw } : event));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...result, events }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "cancel_prompt",
    {
      description: "Cancel a running prompt using ACP session/cancel",
      annotations: {
        title: "Cancel ACP prompt",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: { sessionId: z.string(), promptId: z.string() },
    },
    async ({ sessionId, promptId }) => {
      try {
        const p = await manager.cancelPrompt(sessionId, promptId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                promptId,
                state: p.state,
                stopReason: p.stopReason,
              }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "list_sessions",
    {
      description: "List managed ACP sessions",
      annotations: {
        title: "List ACP sessions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({}),
    },
    (): Promise<CallToolResult> =>
      Promise.resolve({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              manager
                .listSessionSnapshots()
                .map(
                  ({
                    id,
                    agentId,
                    cwd,
                    acpSessionId,
                    acpProtocol,
                    promptActive,
                  }) => ({
                    id,
                    agentId,
                    cwd,
                    acpSessionId,
                    acpProtocol,
                    promptActive,
                  }),
                ),
            ),
          },
        ],
      }),
  );
  server.registerTool(
    "get_session",
    {
      description: "Get capabilities and live configuration metadata",
      annotations: {
        title: "Get ACP session",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: { sessionId: z.string() },
    },
    ({ sessionId }) => {
      try {
        const s = manager.getSessionSnapshot(sessionId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: s.id,
                agentId: s.agentId,
                cwd: s.cwd,
                acpSessionId: s.acpSessionId,
                acpProtocol: s.acpProtocol,
                capabilities: s.capabilities,
                authMethods: s.authMethods,
                configOptions: s.configOptions,
                modes: s.modes,
                permissionPolicy: s.permissionPolicy,
                pendingPermissions: s.pendingPermissions,
                prompt: s.prompt
                  ? {
                      id: s.prompt.id,
                      state: s.prompt.state,
                      text: s.prompt.text,
                      stopReason: s.prompt.stopReason,
                    }
                  : undefined,
                nextSequence: s.nextSequence - 1,
              }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "set_config_option",
    {
      description: "Set an advertised ACP session configuration option",
      annotations: {
        title: "Set ACP config option",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        sessionId: z.string(),
        configId: z.string(),
        value: z.string(),
      },
    },
    async ({ sessionId, configId, value }) => {
      try {
        const session = manager.getSessionSnapshot(sessionId);
        const definition = {
          command: "",
          args: [],
          modelConfigId: session.modelConfigId,
        } satisfies AgentDefinition;
        const option = session.configOptions.find(
          (item) => item.id === configId,
        );
        if (option && isModelOption(option, definition)) {
          if (!isModelAllowed(session.models ?? {}, value)) {
            throw new Error(`Model '${value}' is denied by model policy`);
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                configOptions: await manager.setConfigOption(
                  sessionId,
                  configId,
                  value,
                ),
              }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "set_mode",
    {
      description: "Set an advertised ACP session mode",
      annotations: {
        title: "Set ACP session mode",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: { sessionId: z.string(), modeId: z.string() },
    },
    async ({ sessionId, modeId }) => {
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                modes: await manager.setMode(sessionId, modeId),
              }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "resolve_permission",
    {
      description:
        "Resolve an operator permission request using one of its advertised option IDs",
      annotations: {
        title: "Resolve ACP permission",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        sessionId: z.string(),
        permissionId: z.string(),
        optionId: z.string(),
      },
    },
    ({ sessionId, permissionId, optionId }) => {
      try {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                manager.resolvePermission(sessionId, permissionId, optionId),
              ),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  server.registerTool(
    "close_session",
    {
      description: "Close an ACP session",
      annotations: {
        title: "Close ACP session",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      try {
        await manager.close(sessionId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ closed: true, sessionId }),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: String(e) }] };
      }
    },
  );
  return server;
}
