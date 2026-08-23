# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Differences from upstream

This is a fork of [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp), published to npm as
**`@geohar/pi-acp`** (upstream is unscoped `pi-acp`).

**Why a fork.** It exists to carry capabilities upstream doesn't have — chiefly surfacing the
[pi-subagents](https://github.com/tintinweb/pi-subagents) fleet as ACP tasks, auto-configuring MCP
for pi, multi-root workspaces, and moving toward ACP v2 — and to iterate on them independently. It's
an independent fork published under the `@geohar` scope so it can be installed and depended on
directly; it does not track upstream on a schedule, and there's no commitment to contribute these
changes back (they may or may not be upstreamed later). If you want the original, use
[`svkozak/pi-acp`](https://github.com/svkozak/pi-acp).

On top of upstream it adds:

- **Subagents as ACP tasks** — a bundled pi extension bridges the
  [pi-subagents](https://github.com/tintinweb/pi-subagents) fleet into the ACP `plan` channel, so
  each subagent shows up as a task. See [Subagents as tasks](#subagents-as-tasks).
- **MCP auto-configuration** — ACP `mcpServers` are translated into a generated `<cwd>/.pi/mcp.json`
  for [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) to load. See
  [MCP servers](#mcp-servers).
- **Multi-root workspaces** — additional workspace roots on `session/new` / `session/load`
  (`sessionCapabilities.additionalDirectories`), communicated to pi via `--append-system-prompt`.
- **v2-oriented session capabilities** — advertises `session/resume`, `session/close`, and
  `mcpCapabilities.http` (steps toward ACP v2 parity; see `docs/v2-parity-and-mcp-plan.md`).
- **`PI_ACP_DATA_DIR`** — env override for the adapter's own data directory (see
  [Environment variables](#environment-variables)).

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Multi-workspace support (`sessionCapabilities.additionalDirectories`)
  - ACP clients can pass additional workspace roots on `session/new` / `session/load` (e.g. Zed multi-root workspaces)
  - `cwd` stays the primary working directory; the additional roots are communicated to pi via `--append-system-prompt`, since pi has no native multi-root workspace concept
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` v0.80.4+ installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@geohar/pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g @geohar/pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.
- `PI_ACP_DATA_DIR` overrides the default location for pi-acp's own data directory (default: `~/.pi/pi-acp`). This controls where the session-map file and any future adapter-owned data is stored. Separate from `PI_CODING_AGENT_DIR`, which rehomes pi's own agent directory.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - not implemented (use the model selector UI in Zed)
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

**Note**: Slash commands provided by pi extensions are not currently supported.

## Subagents as tasks

pi itself emits no ACP plans, so the ACP `plan` (task-list) channel is unused. When you use the
[pi-subagents](https://github.com/tintinweb/pi-subagents) extension, pi-acp can surface the running
subagent fleet as an ACP plan — each subagent becomes a task with `pending` / `in_progress` /
`completed` status.

Because pi's RPC mode does not forward pi's in-process event bus (`subagents:*`), the bridging is
done by a pi extension. The `pi-acp` package doubles as that extension (`src/pi-extension.ts`,
declared under `pi.extensions`): loaded inside pi, it subscribes to the bus and, for each change,
persists a **`CustomEntry`** via `pi.appendEntry("acp:subagents", <record>)`. Appending emits an
`entry_appended` event, which pi forwards over RPC (unlike the bus itself); the adapter decodes it
into a `plan` update. `CustomEntry` (not `CustomMessageEntry`) is used deliberately so the fleet
state is recorded without entering the model's context. `entry_appended` forwards while a turn is
active (subagents run inside turns), so plan updates track the fleet during a prompt.

No configuration — it just works once the two packages are installed:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:@geohar/pi-acp   # loads the pi.extensions entry (the bridge)
```

The adapter marks the pi process it spawns with `PI_ACP=1`, which activates the bundled extension
there; the extension stays inert in a normal terminal `pi` session (no marker), so it has no effect
outside the adapter.

ACP `PlanEntryStatus` has no `failed` value, so a failed subagent is shown as `completed` with a
`(failed)` annotation.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- No ACP permission gating (`session/request_permission`): pi executes tools locally and does not surface pre-execution tool intents over RPC, so the adapter cannot gate them yet.

## MCP servers

MCP servers passed by the ACP client (`session/new`, `session/load`, `session/resume`) are translated
into a **session-scoped temp file** and handed to [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter)
via `pi --mode rpc --mcp-config <tempfile>`. stdio and http servers are supported; sse/acp servers
cannot be expressed and are skipped with a notice. The temp file is removed when the session closes.
Install `pi-mcp-adapter` in your pi `packages` for the servers to actually load — the adapter emits a
startup notice when it is missing.

The temp file may hold secrets the client sent literally (an `Authorization` header value, or stdio
`env` values), so it is written in an owner-only (`0700`) temp dir with `0600` permissions. To keep a
bearer token off disk entirely, express it as `$env:VAR` (via the policy's `auth.bearerTokenEnv`, or a
`$env:`-valued header from the client) — pi-mcp-adapter resolves `$env:` at connect, so only the
placeholder is written.

pi-acp deliberately **does not** write `<cwd>/.pi/mcp.json`. That path is pi's own highest-precedence
project config namespace (settings, prompts, trust, mcp): writing there overrode the user's global
MCP config, persisted past the session, and leaked into unrelated (even non-ACP) pi sessions launched
from the same directory. `--mcp-config` overrides only pi-mcp-adapter's `pi-global` source, never pi's
config dir, so all of pi's own MCP config (global and project) still flows through. A stale
`<cwd>/.pi/mcp.json` left by an older pi-acp version (marked `_generatedBy: pi-acp`) is cleaned up
automatically.

### MCP generation policy

By default pi-acp generates every ACP-provided server into the temp overlay (additive — it never
overrides your own config). To control which servers it generates — same semantics pi uses for
subagent tool/extension inheritance — create `~/.pi/pi-acp/mcp-policy.json` (under `PI_ACP_DATA_DIR`):

```json
{
  "generate": "*",
  "exclude": ["mcp-combiner"],
  "auth": {
    "some-http-server": { "bearerTokenEnv": "MY_TOKEN", "headers": { "X-Extra": "v" } }
  }
}
```

- **`generate`** — which servers pi-acp may write: `true`/`"*"`/omitted = all (default) · `["a","b"]` =
  only those · `false` = none. Servers not generated are left to your own (lower-precedence) config.
- **`exclude`** — denylist (wins over `generate`): never generate these. Use it for a server you
  configure globally with its own auth (e.g. a bearer-auth'd combiner) so pi-acp doesn't override it.
- **`auth`** — for a server pi-acp _does_ generate, write `Authorization: Bearer $env:<VAR>` (+ extra
  headers). pi-mcp-adapter interpolates `$env:` at connect, so the token is never written to disk.

Names are case-insensitive. Note the ACP MCP shape has no dedicated auth field, so bearer auth can
only travel as an HTTP header — either provided by the client in the server's `headers`, or added via
this policy's `auth`.

- Additional workspace roots are not a hard filesystem boundary: pi can operate outside them. They are communicated to the model (workspace awareness), not enforced as a sandbox.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
