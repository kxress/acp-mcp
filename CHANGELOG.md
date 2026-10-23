# Changelog

## 0.2.5 (unreleased)

### Added

- Add built-in launch profiles for every agent published in the [Agent Client
  Protocol registry](https://agentclientprotocol.com/get-started/registry)
  (Amp, Auggie, Bob, Cline, Copilot, Cursor, Devin, Gemini CLI, GLM Agent,
  goose, Grok Build, Junie, Kilo, Kimchi, Kimi CLI, MiniMax Code, Mistral Vibe,
  Nova, OpenCode V2, Poolside, Qoder CLI, Qwen Code, siGit Code, Stakpak, and
  more), mirroring each registry `agent.json` launch command so agents work by
  ID without extra configuration.
- Add a built-in `command-code` profile for [Command
  Code](https://commandcode.ai/docs/acp): `cmd acp` (`cmdc acp` on native
  Windows), with the Node.js 22+ prerequisite and headless/`cmd login`
  authentication routes in the install hint.
- Pin the `opencode-v2` profile to ACP v2 (`acpProtocol: "v2"`) so the v2-only
  registry agent no longer defaults to the v1 driver, and point the
  `mistral-vibe` install hint at the official Mistral Vibe release archives.
- Guarantee agent process teardown: `stopAgent` now escalates to a
  whole-process-tree SIGKILL (POSIX process groups; `taskkill /T /F` on
  Windows) when an agent ignores stdin EOF, live agent processes are tracked
  and force-terminated on server exit, and SIGTERM now shuts the server down
  like SIGINT so idle agents no longer survive host shutdown.

### Changed

- Migrate the runtime from Deno to Node.js following [Deno's announcement that
  its team is joining Cloudflare](https://deno.com/blog/cloudflare).

## 0.2.4 (released)

### Added

- Add first-class native macOS ARM64 support.
- Extend release validation to Windows x86_64, Linux x86_64, and macOS ARM64.

## 0.2.3 (released)

### Fixed

- Make the session-capacity regression test deterministic on constrained Windows
  CI without changing the production limit of eight sessions.
- Add pre-tag hosted release validation for Windows and Linux.

## 0.2.2 (tagged source; no binary release)

The v0.2.2 tag remains in Git history, but Windows hosted release validation
failed before publication. No GitHub Release or binary assets were published.

- Fix Windows hosted release validation portability while keeping Windows and
  Linux as first-class release targets.

## 0.2.1 (tagged source; no binary release)

The v0.2.1 tag remains in Git history, but Windows hosted release validation
failed before publication. No GitHub Release or binary assets were published.

The v0.2.1 changes follow below.

### Added

- Support native Linux x86_64 builds, local release bundles, and user-local
  installation alongside Windows x86_64.
- Package Windows and Linux releases with the project license, third-party
  notices, applicable dependency license texts, archive checksums, and
  manifests.
- Allow trusted configuration to register arbitrary stdio ACP agents through the
  existing generic runtime.
- Normalize thinking-effort requests across the ordered `off` through `ultra`
  scale using live advertised choices.

## 0.2.0

### Breaking changes

- Rename the one-shot `delegate` MCP tool to `run_task` and its `prompt` input
  to `task`.
- Rename the `discover_models` MCP tool to `list_models`. No deprecated aliases
  are provided; update MCP callers and per-tool approval settings.
- Rename `run_task.timeoutMs` to `idleTimeoutMs`; it now limits consecutive
  silence rather than total task duration. `permissionLeaseMs` configures the
  separate operator handoff lease.
- The disposable planning script no longer selects a default agent or model. Use
  its live `models` and `configs` views, then pass exact `--agent` and `--model`
  values to `run`; the privacy policy is required and optional cost filters are
  session-selected.

### Added

- Add an operator-run local release workflow that validates, builds,
  smoke-tests, packages, checksums, and installs the native executable without
  hosted release infrastructure.
- Require explicitly selected config files to exist and report invalid known
  agent fields with actionable, secret-safe errors.
- Bound ACP initialization, session creation, and startup configuration to 30
  seconds. Closing cancels active prompts and bounds the ACP close request
  before process cleanup continues.
- Add offline `acp-mcp doctor` diagnostics for local configuration, agent
  executable availability, declared runtime prerequisites, and stale disposable
  workspace state. It does not start agents or verify provider authentication.
- Establish a standalone `acp-mcp` executable as the product entrypoint. With no
  CLI option it starts the MCP stdio server; help, version, and explicit config
  selection are handled before server startup.
- Add MCP tools to inspect stale disposable planning workspaces and explicitly
  delete eligible workspaces through the shared ownership- and age-checked
  cleanup implementation. The tools report workspace IDs rather than accepting
  arbitrary paths.
- Add a concise live-validated agent compatibility matrix and an explicit
  PowerShell-friendly runner for the existing opt-in live compatibility tests.
  Add explicit ACP v2 compatibility invocations for Claude's experimental
  adapter mode.
- Add an ACP v2 protocol driver alongside ACP v1, with explicit per-agent
  protocol selection and no automatic cross-version retry. ACP v2 remains a
  draft; built-in agent support is reported only where confirmed.
- Validate Claude Agent ACP v2 prompt completion, permission denial, and session
  replay/resume through the existing user-configured provider route.
- Add an explicit helper for unique disposable planning snapshots. It copies
  tracked working-tree contents and non-ignored untracked files without Git
  metadata, and documents that the snapshot is mutation containment rather than
  an OS sandbox. Add a planning CLI that checks live model/privacy metadata,
  uses fresh clones from one canonical snapshot for each explicitly selected
  candidate, and only retries an allowed rate-limit classification.
- Add compact, filtered, paged live model summaries and selected-model config
  inspection to the planning script. Candidate summaries preserve ACP order and
  never rank or select a model.
- OpenCode Zen and Go enrichment now covers provider-qualified advertised
  models, distinguishes current per-token price from subscription access and
  limited-time free status, adds the documented Jev paid-counterpart tier, and
  exposes source-backed privacy facts. Planning fallback guidance is bounded and
  remains in the ACP usage skill; `run_task` never routes or retries.
- Built-in Codex ACP adapter and first-party Antigravity ACP server profiles.
  `list_agents` now reports whether each profile's executable is present.
- Add the built-in Claude Agent ACP profile for the maintained adapter. The
  launch profile stays provider-neutral; live validation uses a user-configured
  OpenRouter route and does not establish a default model.
- Live validation confirmed Antigravity reuses its persisted ACP authentication
  across fresh server processes. Documentation covers the separate ACP auth
  selector and a stable user-local executable configured by absolute path. The
  opt-in compatibility test checks launchability and child termination without
  requiring zero exit status after a completed task.
- `run_task` failures now include a compact generic error kind and stage, with a
  JSON-RPC code when the ACP agent provides one. Provider messages and raw
  diagnostics remain private; the bridge does not retry or switch models.
- Agent profiles may opt into compact semantic failure classification. The
  OpenCode classifier recognizes explicit rate-limit wording as a heuristic;
  generic ACP codes alone are never interpreted as provider conditions.

### Changed

- Clarify that normal model/config discovery uses the host-connected MCP
  service; repository planning scripts are deliberate source-checkout workflows,
  not substitutes when that connected service is unavailable.
- Declare explicit read-only, destructive, idempotency, and open-world hints for
  every public MCP tool; these annotations describe behavior but do not enforce
  security policy.
- Clarify that `read_only` governs only ACP permission requests and is not a
  filesystem sandbox; deterministic coverage demonstrates that a fake ACP
  process can write directly without requesting permission.
