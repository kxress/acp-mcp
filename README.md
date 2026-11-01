# acp-mcp

**Control ACP coding agents programmatically through MCP.**

`acp-mcp` lets any MCP-capable host launch and control ACP-compatible coding
agents as stateful workers.

Use it to:

- discover available agents, models, modes, and configuration
- delegate one-shot tasks
- keep multi-turn agent sessions alive
- inspect structured events
- change session configuration and modes
- resolve permission requests
- cancel active work
- resume supported downstream sessions
- coordinate multiple independent agents in parallel

```text
MCP host
   |
   v
acp-mcp
   |
   +--> ACP agent session --> model/provider
   |
   +--> ACP agent session --> model/provider
   |
   +--> ACP agent session --> model/provider
```

Each downstream agent talks to its own model or provider. `acp-mcp` is the
control layer. It does not provide models, accounts, credentials, or
orchestration policy.

> `acp-mcp` is a control plane, not a scheduler. The parent host decides what to
> delegate, when to run it, and whether work should run concurrently.

## Why use it?

A shell command is enough for simple delegation, but it usually reduces an agent
to a one-shot subprocess.

Headless CLI modes can also differ from the agent's interactive or ACP
interface. They may expose fewer models, use different defaults, flatten
structured events into stdout, or make multi-turn continuation awkward.

ACP provides a structured session protocol for coding agents. MCP provides a
structured tool interface for hosts. `acp-mcp` bridges the two.

That gives the parent agent a long-lived, inspectable, controllable worker
instead of only a command to execute.

## Quick start

### 1. Install `acp-mcp`

Published builds are available from
[GitHub Releases](https://github.com/kxress/acp-mcp/releases).

Release packages are built for:

| Platform | Target                |
| -------- | --------------------- |
| Windows  | x86_64                |
| Linux    | x86_64                |
| macOS    | ARM64 / Apple Silicon |

Each release package contains the native executable, the `acp-mcp` WTFPL
license, third-party notices and applicable license texts, and an embedded
manifest. GitHub Releases also publish a SHA-256 sidecar for each archive and a
manifest containing the archive and executable hashes.

The release workflow publishes only when the tag version matches
`src/version.ts` and all native builds and smoke tests pass.

A platform-neutral Node package is also attached as `acp-mcp-<version>-node.zip`. It contains the JavaScript bundle and licenses and requires Node.js 24.12.0 or newer.

<details>
<summary><strong>Windows x86_64</strong></summary>

Download the ZIP, checksum, and manifest. Verify the archive, then extract it to
a stable application directory:

```powershell
$version = "0.2.5"
$archive = ".\acp-mcp-$version-windows-x86_64.zip"

$expected = (Get-Content "${archive}.sha256").Split()[0]
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()

if ($actual -ne $expected) {
    throw "SHA-256 mismatch"
}

$install = Join-Path $env:LOCALAPPDATA "Programs\acp-mcp"
Expand-Archive -LiteralPath $archive -DestinationPath $install -Force

& (Join-Path $install "acp-mcp.exe") --version
```

An absolute executable path is the most predictable choice when you register the
server with an MCP host.

</details>

<details>
<summary><strong>Linux x86_64</strong></summary>

Download the tarball, checksum, and manifest. Verify and extract the package,
then install the executable in your user-local bin directory:

```sh
version=0.2.5
archive="acp-mcp-$version-linux-x86_64.tar.gz"

sha256sum -c "$archive.sha256"

mkdir -p "$HOME/.local/share/acp-mcp/$version" "$HOME/.local/bin"
tar -xzf "$archive" -C "$HOME/.local/share/acp-mcp/$version"

install -m 0755 \
  "$HOME/.local/share/acp-mcp/$version/acp-mcp" \
  "$HOME/.local/bin/acp-mcp"

"$HOME/.local/bin/acp-mcp" --version
```

</details>

<details>
<summary><strong>macOS ARM64</strong></summary>

Download the tarball, checksum, and manifest. Verify and extract the package,
then install the executable in your user-local bin directory:

```sh
version=0.2.5
archive="acp-mcp-$version-macos-arm64.tar.gz"

shasum -a 256 -c "$archive.sha256"

mkdir -p "$HOME/.local/share/acp-mcp/$version" "$HOME/.local/bin"
tar -xzf "$archive" -C "$HOME/.local/share/acp-mcp/$version"

install -m 0755 \
  "$HOME/.local/share/acp-mcp/$version/acp-mcp" \
  "$HOME/.local/bin/acp-mcp"

"$HOME/.local/bin/acp-mcp" --version
```

The macOS binary is unsigned and not notarized.

</details>

The repository installer can also install from a directory that contains the
release archive, checksum, and target manifest:

```sh
npm run install-release -- --release-dir ./acp-mcp-release-assets
```

It verifies the archive and embedded executable before it replaces the installed
binary.

Default install locations:

| Platform | Default                           |
| -------- | --------------------------------- |
| Windows  | `%LOCALAPPDATA%\Programs\acp-mcp` |
| Linux    | `$HOME/.local/bin/acp-mcp`        |
| macOS    | `$HOME/.local/bin/acp-mcp`        |

On Linux and macOS, the installer reports when `$HOME/.local/bin` is not on
`PATH`. It does not modify shell configuration.

The installed executable is native and includes the Node.js runtime. The Node ZIP runs with the Node.js version installed on the host.

To run the Node package, verify and extract `acp-mcp-<version>-node.zip`, then start `acp-mcp.mjs` with Node.js 24.12.0 or newer:

```sh
node acp-mcp.mjs --version
```

> SHA-256 verifies downloaded bytes against a known hash. It does not
> authenticate the publisher.

### 2. Register it with your MCP host

Running `acp-mcp` without arguments starts the MCP stdio server.

For Codex:

```toml
[mcp_servers.acp_mcp]
command = 'C:\Tools\acp-mcp\acp-mcp.exe'
args = []
```

Process hierarchy:

```text
host
  |
  +--> acp-mcp
         |
         +--> ACP agent
         |
         +--> ACP agent
```

The MCP host decides which environment variables are inherited by `acp-mcp`.

Install and authenticate each downstream agent separately.

### 3. Discover what is available

Use:

```text
list_agents
list_models
```

`list_agents` reports the effective agent definitions.

`list_models` asks a live ACP implementation what it currently advertises,
including its available models and configuration.

This is important because an agent's interactive UI, CLI mode, headless mode,
and ACP interface can expose different model catalogs or configuration options.

The live ACP advertisement is the source of truth. `acp-mcp` cannot invent a
model or bypass restrictions imposed by the downstream implementation.

### 4. Delegate work

For one request and one compact result, use `run_task`:

```json
{
  "agentId": "antigravity",
  "task": "Review the failing test and propose the smallest correct fix.",
  "modelSize": "large",
  "thinkingEffort": "max",
  "cwd": "C:\\work\\my-project"
}
```

Good `run_task` jobs include:

- investigating a flaky test
- reviewing a diff
- implementing an isolated module
- comparing technical approaches
- researching an integration failure
- analyzing a test suite

Typical flow:

```text
parent agent
  |
  +--> list_agents
  |
  +--> list_models
  |
  +--> run_task
  |
  +--> use result
```

`run_task` uses the requested agent and model selection. If that request fails,
it does not silently switch implementations, models, or ACP protocol versions.

## Managed sessions

Use a managed session when the interaction itself matters or when work needs
more than one turn.

```text
start_session
  |
  +--> prompt
  |
  +--> get_events
  |
  +--> prompt
  |
  +--> get_events
  |
  +--> close_session
```

A managed session lets the parent:

- send follow-up prompts
- inspect intermediate events
- change advertised configuration
- change modes
- resolve permission requests
- cancel an active prompt
- resume supported downstream sessions
- close the session explicitly

Use `run_task` when one request and one result are enough. Use a managed session
when you need session control.

`acp-mcp` keeps up to eight managed sessions per server process.

Bridge session state and event journals are process-local. A downstream session
may still be resumable after `acp-mcp` restarts when that ACP implementation
supports session resume.

### Parallel agents

Managed sessions are independent. A parent can coordinate several specialists at
once:

```text
Codex
  |
  +--> OpenCode: implement backend change
  |
  +--> Claude: review API design
  |
  +--> Antigravity: investigate integration failure
```

This works best when delegated tasks are independent enough to run concurrently.

`acp-mcp` does not schedule, sequence, merge, or reconcile their work
automatically. The parent orchestrator owns that logic.

## Supported agents

An agent is an ACP implementation that `acp-mcp` can launch. The model selected
inside that agent is a separate choice.

| Agent ID      | ACP implementation                      | Notes                                                         |
| ------------- | --------------------------------------- | ------------------------------------------------------------- |
| `opencode`    | OpenCode `opencode acp`                 | ACP v1                                                        |
| `codex`       | `@agentclientprotocol/codex-acp`        | ACP v1                                                        |
| `claude`      | Claude Agent ACP                        | ACP v1 by default; experimental v2 can be selected explicitly |
| `antigravity` | Selected Antigravity ACP implementation | Official Google implementation by default                     |

The built-in profiles are convenience presets, not a closed integration list.

### Agent Client Protocol registry agents

Every agent published in the
[ACP registry](https://agentclientprotocol.com/get-started/registry) also has
a built-in launch profile, so it can be used by agent ID without any
configuration. Each profile mirrors the registry's documented launch command
for its distribution channel (npm package binary, Python entry point, or
standalone release binary):

| Agent ID               | Launch command            | Distribution                  |
| ---------------------- | ------------------------- | ----------------------------- |
| `agoragentic`          | `agoragentic-mcp --acp`   | npm `agoragentic-mcp`         |
| `amp`                 | `amp-acp`                 | registry binary               |
| `auggie`               | `auggie --acp`            | npm `@augmentcode/auggie`     |
| `autohand`             | `autohand-acp`            | npm `@autohandai/autohand-acp`|
| `bob`                 | `bob acp`                 | npm `@ibm/bob`                |
| `cline`               | `cline --acp`             | npm `cline`                   |
| `codebuddy`            | `codebuddy --acp`          | npm `@tencent-ai/codebuddy-code` |
| `command-code`          | `cmd acp` (`cmdc acp` on native Windows) | npm `command-code` |
| `cortex`              | `cortex acp serve`        | registry binary               |
| `corust`              | `corust-agent-acp`         | registry binary               |
| `crow-cli`            | `crow-cli acp`             | registry binary               |
| `cursor`              | `cursor-agent acp`         | Cursor agent package          |
| `deepagents`          | `deepagents-acp`           | npm `deepagents-acp`          |
| `devin`               | `devin acp`               | registry binary               |
| `dimcode`             | `dimcode acp`             | npm `dimcode`                 |
| `dirac`               | `dirac --acp`              | npm `dirac-cli`               |
| `factory-droid`        | `droid exec --output-format acp-daemon` | npm `droid` |
| `fast-agent`          | `fast-agent -x`            | Python `fast-agent-acp`       |
| `gemini`              | `gemini --acp`             | npm `@google/gemini-cli`      |
| `github-copilot`       | `copilot-language-server --acp` | npm `@github/copilot-language-server` |
| `github-copilot-cli`   | `copilot --acp`            | npm `@github/copilot`         |
| `glm`                 | `glm-acp-agent`            | npm `glm-acp-agent`           |
| `goose`               | `goose acp`                | binary from goose releases    |
| `grok-build`          | `grok agent stdio`         | npm `@xai-official/grok`      |
| `harn`                | `harn serve acp`           | registry binary               |
| `junie`               | `junie --acp=true`          | JetBrains Junie package       |
| `kilo`                | `kilo acp`                 | npm `@kilocode/cli`           |
| `kimchi`              | `kimchi --mode acp`        | registry binary               |
| `kimi`                | `kimi acp`                 | registry binary               |
| `minimax`             | `mcode acp`                | npm `@minimax-ai/code`        |
| `minion-code`         | `minion-code acp`          | Python `minion-code`          |
| `mistral-vibe`        | `vibe-acp`                 | binary from Mistral Vibe releases |
| `nova`                | `nova acp`                 | npm `@compass-ai/nova`       |
| `opencode-v2`         | `opencode acp`             | ACP v2                        |
| `pi`                  | `pi-acp`                   | npm `pi-acp`                  |
| `poolside`            | `pool acp`                 | registry binary               |
| `qoder`               | `qodercli --acp`           | npm `@qoder-ai/qodercli`      |
| `qwen`                | `qwen --acp --experimental-skills` | npm `@qwen-code/qwen-code` |
| `sigit`              | `sigit`                    | npm `@smbcloud/sigit`         |
| `stakpak`             | `stakpak acp`              | registry binary               |
| `vtcode`              | `vtcode acp`               | registry binary               |

These profiles describe how to launch each registry agent; protocol
conformance, models, and authentication remain owned by the downstream agent.
Install and authenticate the agent using its own instructions (the profile's
install hint names the package or release archive), then select it by agent
ID. Any profile can be overridden per agent in trusted configuration.

## Bring your own ACP agent

Any compatible stdio ACP server can be registered in trusted configuration:

```json
{
  "agents": {
    "my-agent": {
      "command": "my-acp-server",
      "args": ["--stdio"],
      "acpProtocol": "v1"
    }
  }
}
```

The custom agent then uses the same generic runtime path as the built-in
profiles:

```text
list_agents
list_models
run_task
start_session
...
```

Defaults:

- `args`: `[]`
- `acpProtocol`: `"v1"`

Custom executable definitions belong in trusted home configuration or in an
explicit `--config` file.

Repository configuration cannot introduce arbitrary executable commands,
arguments, environment variables, or ACP protocol definitions.

## Antigravity implementations

The built-in `antigravity` profile supports three explicit implementations:

| Selector   | Implementation                      | Use when                                                 |
| ---------- | ----------------------------------- | -------------------------------------------------------- |
| `official` | Google's `agy_acp_server`           | You want the official and default ACP path               |
| `refined`  | `simonepri/refined-antigravity-acp` | You want the refined wrapper around the official backend |
| `agy`      | `shubzkothekar/antigravity-acp`     | You want the richer dynamic `agy` CLI model catalog      |

The default is `official`.

<details>
<summary><strong>official</strong></summary>

```json
{
  "agents": {
    "antigravity": {
      "implementation": "official"
    }
  }
}
```

</details>

<details>
<summary><strong>refined</strong></summary>

```json
{
  "agents": {
    "antigravity": {
      "implementation": "refined"
    }
  }
}
```

</details>

<details>
<summary><strong>agy</strong></summary>

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy"
    }
  }
}
```

The tested `agy` path exposed a richer live model catalog, including Opus on the
tested account. Actual availability depends on the installed CLI, adapter
version, account, and entitlements.

The pinned `agy` adapter invokes the CLI with:

```text
--dangerously-skip-permissions
```

ACP permission mediation therefore does not protect those operations. The `agy`
implementation is intentionally opt-in.

</details>

## MCP tool reference

`acp-mcp` exposes 16 MCP tools.

| Area                      | Tools                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Discovery                 | `list_agents`, `list_models`                                                                             |
| One-shot delegation       | `run_task`                                                                                               |
| Sessions                  | `start_session`, `load_session`, `prompt`, `get_events`, `list_sessions`, `get_session`, `close_session` |
| Configuration and control | `set_config_option`, `set_mode`, `cancel_prompt`, `resolve_permission`                                   |
| Workspace recovery        | `list_stale_workspaces`, `cleanup_stale_workspaces`                                                      |

Capabilities vary between downstream ACP implementations. Discover what the
selected agent advertises instead of assuming that every tool, mode, or
configuration option maps to every agent.

## Configuration

Configuration files are named:

```text
.acp-mcp.json
```

Without `--config`, `acp-mcp` discovers configuration from the operation's
working directory and merges it from less specific to more specific locations.

Conceptually:

```text
~/.acp-mcp.json
      |
      v
outer/.acp-mcp.json
      |
      v
repo/.acp-mcp.json
      |
      v
repo/subproject/.acp-mcp.json
```

More specific files override less specific files where they provide a value.

Merge behavior:

- objects merge recursively
- scalars replace earlier values
- arrays replace earlier arrays
- the nearest project configuration wins for values that it provides

Home configuration:

```text
Windows: %USERPROFILE%\.acp-mcp.json
POSIX:   $HOME/.acp-mcp.json
```

A session captures its effective configuration when it starts or loads. Editing
`.acp-mcp.json` changes new operations and new sessions, not a session that is
already running.

### Exact config mode

Use:

```text
acp-mcp --config <path>
```

When `--config` is supplied, only that file is loaded. Home configuration and
project discovery are skipped.

The legacy location:

```text
%APPDATA%\acp-mcp\config.json
```

is not loaded implicitly. A current-schema file at that location can still be
selected explicitly with `--config`.

## Project configuration trust boundary

Repository `.acp-mcp.json` files can define project-level policy such as:

- default model selection
- model allow and deny rules
- model-size mappings
- built-in Antigravity implementation selection

Repository configuration cannot introduce or replace:

```text
command
args
env
acpProtocol
```

Executable launch configuration belongs in trusted home configuration or an
explicit `--config` file.

This prevents entering a repository from implicitly trusting executable
definitions stored inside that repository.

## Model policy

Different agents expose unrelated model IDs. `acp-mcp` lets an orchestration
layer request normalized model sizes and thinking effort instead of hardcoding
provider-specific IDs everywhere.

Configuration follows the operation's working directory, so one MCP server can
use different defaults and restrictions for different repositories or
subprojects.

### Model size

Normalized sizes:

```text
small
medium
large
xlarge
```

These values represent configured positions within a model family. They are not
universal capability rankings.

For example:

```text
small  -> Haiku / Luna position
medium -> Sonnet / Terra position
large  -> Opus / Sol position
xlarge -> Fable / Astra position
```

`acp-mcp` does not infer these relationships from model names. You configure
them explicitly.

### Thinking effort

Normalized effort values:

```text
off
low
medium
high
xhigh
max
ultra
```

The requested effort is projected onto the effort levels actually available for
the selected model.

Resolution rules:

1. If the exact requested level exists, use it.
2. Otherwise, use the highest available level that does not exceed the request.
3. If no available level is that low, use the model's lowest available level.
4. `off` means zero effort when the model supports it. Otherwise it resolves to
   the lowest available level.

Examples:

```text
Codex exposes through max:       ultra  -> max
OpenCode exposes through high:   xhigh  -> high
only medium, high available:     off    -> medium
only medium, high available:     low    -> medium
only medium, high available:     xhigh  -> high
only low, high available:        medium -> low
model has no off:                off    -> lowest available
available low, high:             medium -> low
```

Configured effort mappings are intersected with model choices advertised by the
live ACP implementation.

`max` and `ultra` use the same ordered projection rules as every other level.

### Example: map Opus to `large`

```json
{
  "agents": {
    "antigravity": {
      "implementation": "agy",
      "models": {
        "allowedModels": ["claude-*", "gemini-*"],
        "deniedModels": ["gpt-oss-*"],
        "default": {
          "modelSize": "large",
          "thinkingEffort": "max"
        },
        "modelSizes": {
          "medium": {
            "modelsByThinkingEffort": {
              "low": "claude-sonnet-5-5-low",
              "medium": "claude-sonnet-5-5-medium",
              "high": "claude-sonnet-5-5-high"
            }
          },
          "large": {
            "modelsByThinkingEffort": {
              "low": "claude-opus-5-5-low",
              "medium": "claude-opus-5-5-medium",
              "high": "claude-opus-5-5-high"
            }
          }
        }
      }
    }
  }
}
```

If `claude-opus-5-5-high` is the highest configured `large` variant currently
advertised by the ACP implementation, `large + max` resolves to it.

If a mapped model is not advertised or is denied by policy, selection fails.

There is no hidden fallback to another model or size.

### Selection precedence

```text
explicit tool selection
        |
        v
configured default
        |
        v
downstream default
```

Allow and deny policy applies at every level.

## ACP versions

ACP v1 is the default and mature path.

ACP v2 is experimental and must be selected explicitly in trusted agent
configuration:

```json
{
  "agents": {
    "claude": {
      "acpProtocol": "v2"
    }
  }
}
```

There is no automatic v1/v2 retry.

## Doctor

Run:

```text
acp-mcp doctor
acp-mcp doctor --json
```

`doctor` checks:

- local configuration
- effective configuration sources
- agent definitions
- command and runtime prerequisites
- ACP protocol selection
- stale workspace state

`doctor` runs locally and offline.

It does not:

- authenticate to providers
- inspect provider credentials
- prove model entitlement
- contact providers only to perform a health check

## Claude Agent ACP through Codex

When Claude Agent ACP uses an externally configured Anthropic-compatible route,
Codex must explicitly forward the relevant environment variable names to the MCP
subprocess:

```toml
[mcp_servers.acp_mcp]
command = 'C:\Tools\acp-mcp\acp-mcp.exe'
args = []
env_vars = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
```

Do not put the secret values themselves in Codex configuration.

## Security and operational boundaries

Keep these boundaries in mind:

- `acp-mcp` is a bridge, not a model provider.
- The live ACP advertisement is the source of truth for models and
  configuration.
- ACP child processes run with the launching user's OS privileges.
- `permissionPolicy: "read_only"` controls how `acp-mcp` answers ACP permission
  requests. It is not a filesystem or OS sandbox.
- Some downstream agents or adapters can perform operations without requesting
  ACP permission.
- Session events can contain prompts, filesystem paths, tool data, provider
  content, and other sensitive information.
- Provider credentials belong to the downstream agent or provider.
- There is no automatic fallback between models, implementations, or ACP
  protocol versions.
- SHA-256 can verify an artifact against a known hash. It does not authenticate
  the publisher.

Treat downstream ACP agents with the same care as any local process running
under your account.

## Development

The repository pins Node.js 24 in `mise.toml`. Development requires Node.js 24.12.0 or newer; Node.js 26 is used to build native standalone executables.

Mise is development tooling only. It is not a runtime dependency of the
installed executable.

Common commands:

```powershell
npm ci
npm run check
npm test
npm run lint
npm run format:check
npm run build
npm run release
```

Live compatibility checks are also available:

```text
npm run compat -- <agent>
```

Compatibility tasks may consume provider quota.

## Platform support

Packaged release targets:

- Windows x86_64
- Linux x86_64
- macOS ARM64 / Apple Silicon

Each target uses a native executable and a self-contained release package.

Intel macOS is not included.

## License

Licensed under the [WTFPL, Version 2](LICENSE).
