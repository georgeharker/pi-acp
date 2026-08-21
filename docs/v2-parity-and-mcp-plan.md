# Plan: ACP v2 (draft) adoption + pi-mcp-adapter auto-configuration

Status: proposal (plan only — no code yet).
Scope decisions: **MCP config-file auto-write now (v1)**; **v2 built behind the dual-version router but
held until v2 graduates from experimental to a published non-experimental SDK release**;
`session/request_permission` gating deferred (pi-blocked). MCP setup = **write config only** (assume
`pi-mcp-adapter` is installed; notice when it isn't).

## 0. The real versioning + SDK situation

**ACP v2 is a real, breaking wire protocol** (not doc versioning). Confirmed from the canonical repo
`agentclientprotocol/agent-client-protocol`: `schema/v2/meta.json` → `"version": 2`. Published as a
**Draft on 2026-07-20** ("beyond the turn"), schema line `v2.0.0-alphaX`. v1 (`"version": 1`) and v2
**coexist**; the announcement says gate v2 behind version negotiation — don't default it on yet.

**A v2 TypeScript SDK already exists — as experimental.** `@agentclientprotocol/sdk` (repo moved to
`agentclientprotocol/typescript-sdk`) latest **1.4.0**:

- Stable entry (`.`) is **v1**, `PROTOCOL_VERSION = 1` — unchanged for v1 clients.
- **v2 ships behind an explicit experimental import**: `@agentclientprotocol/sdk/experimental/v2`
  (`dist/v2/acp.js`, `v2.PROTOCOL_VERSION = 2`). README warns: _"ACP v2 is still a draft. Its wire
  protocol and this TypeScript API may change incompatibly in any SDK release."_
- Ships a **dual-version router**: build separate v1 + v2 agents and wire them with
  `agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream)` — the router negotiates by
  version, so v1-only peers keep working. (See the SDK's `examples/dual-version-agent`.)

This repo pins the old **`0.26.0`** (v1-only, no v2 entry). So: my earlier "no v2 SDK" note was wrong;
the path exists today. Per scope decision, we **build against `/experimental/v2` but hold shipping**
until v2 is published non-experimental (drop the `/experimental/` segment). `agent.ts`
`supportedVersion = 1` stays correct for the v1 agent; v2 is the router's second agent.

### v2 SDK API shape (from 1.4.0, confirmed)

`import * as v2 from "@agentclientprotocol/sdk/experimental/v2"` gives `v2.agent({...})`,
`v2.methods.agent.{initialize, auth.logout, session.{new,list,resume,close,prompt,cancel}}`,
`v2.methods.client.session.update`, `v2.PROTOCOL_VERSION`, `v2.RequestError`, `v2.agentProtocolRouter()`.

- `initialize` → `{ protocolVersion: v2.PROTOCOL_VERSION, info:{name,version}, capabilities:{ session:{} } }`.
- `session.prompt` handler returns **void**; the framework queues the `{}` acceptance response, and
  the turn runs asynchronously.
- The turn emits `client.session.update` notifications: `{sessionUpdate:"user_message", messageId, content}`,
  `{sessionUpdate:"agent_message", messageId, content}`, `{sessionUpdate:"state_update", state:"running"}`,
  then `{sessionUpdate:"state_update", state:"idle", stopReason:"end_turn"}` (or `state:"idle",
stopReason:"cancelled"` on abort). This is the "beyond the turn" model in concrete form.
- `session.resume` handler reads `params.replayFrom?.type === "start"` and replays `history`.

## 1. What v2 breaks (mapped to this adapter's code)

Source: `/protocol/v2/migration` + the SDK 1.4.0 v2 example. Ordered by blast radius here.

### 1a. Prompt lifecycle — "beyond the turn" (biggest change)

- v1: `session/prompt` pending for the whole turn; response carries `stopReason`.
- v2: `session/prompt` handler returns void → framework sends `{}` immediately (acceptance).
  Completion + `stopReason` move onto a **`state_update`** update (`running`/`requires_action`/`idle`);
  cancellation = idle `state_update` with `stopReason:"cancelled"`.
- This repo: `agent.ts` `prompt()` returns `{ stopReason }` and `session.ts` runs the turn to a
  resolved stop reason. The v2 agent inverts this — start the turn async, drive pi, and translate
  pi's completion into an idle `state_update`. Substantial, but isolated to the v2 agent.

### 1b. Session modes removed → config options ("works differently for modes")

- v1: dedicated modes API — `session/set_mode` (`setSessionMode`), `modes`/`availableModes`,
  `current_mode_update`, `SessionMode*`.
- v2: modes API **removed.** Mode-like state is a **config option** via `session/set_config_option`,
  `category` ∈ `{mode, model, model_config, thought_level}`, `configId` (was `id`), `type`,
  `currentValue`, `options`; agent-initiated changes → **`config_option_update`** (was
  `current_mode_update`).
- This repo: already implements `setSessionConfigOption` (categories `model` + `thought_level`) and
  emits `config_option_update` — **the v2 shape is largely already here.** The v2 agent simply drops
  `setSessionMode`/`current_mode_update`/the `modes` response block and routes thinking level through
  config options only. (v1 agent keeps its modes path for v1 clients.)

### 1c. session/load removed → session/resume + replayFrom

- v1: `session/load` (replay, gated by `loadSession`) **and** `session/resume` (no replay).
- v2: **`session/load` removed.** Only `session/resume` + optional `replayFrom` cursor;
  replay-from-start = `resume` with `"replayFrom":{"type":"start"}`. `session/list` and `session/close`
  become **required** (no capability marker). `new` and `resume` share env params (absolute `cwd`,
  optional `additionalDirectories`, optional `mcpServers`).
- This repo: `loadSession()` history-replay → the `replayFrom:{type:"start"}` branch of v2
  `resumeSession`; internal `restoreSession()` (no replay) is plain resume. Add `closeSession`.

### 1d. Uniform message updates with stable IDs

- v2: user/agent messages, tool calls, terminal output share one patch model (stable IDs;
  omitted=unchanged, null=clears, value=replaces, chunk=appends). User/agent messages carry an
  **agent-owned `messageId`** and use `user_message`/`agent_message` (not `*_chunk`) per the example.
- This repo: `session.ts` streaming + the replay loop emit `user_message_chunk`/`agent_message_chunk`
  without IDs. The v2 agent assigns/tracks `messageId`s and follows the unified semantics.

### 1e. Diffs: structured file changes replace oldText/newText

- v2: `oldText`/`newText` → structured changes (add/delete/modify/move/copy) + optional `git_patch`.
- This repo: mostly emits tool results as text (`translate/pi-tools.ts`, `translate/bash.ts`), so
  impact is small — but any diff rendering moves to the structured shape on the v2 path.

### 1f. Permission requests restructured

- v2: `session/request_permission` gains required `title`, optional `description`, and a `subject`
  union (`type:"tool_call"` upsert | `type:"command"` with `command`+absolute `cwd`).
- This repo: not implemented (pi runs tools locally). Still **Phase 2 / pi-blocked** regardless of v2.

### 1g. Forward-compatible enums

- v2: unknown enum variants accepted when prefixed `_`. Any exhaustive switches must tolerate them.

## 2. MCP auto-configuration (goal #1) — orthogonal to v1/v2, do first

`pi-mcp-adapter` is a **pi package** (pi `settings.json` `packages:["npm:..."]`) that reads MCP
servers from config files, precedence:

```
~/.config/mcp/mcp.json → ~/.agents/mcp.json → ~/.agents/mcp/mcp.json
→ <pi agent dir>/mcp.json → .mcp.json → .pi/mcp.json
```

Schema:

```json
{
  "mcpServers": { "<name>": { "command": "npx", "args": ["-y", "..."] } },
  "settings": { "toolPrefix": "server", "idleTimeout": 10 }
}
```

Design (write-config-only):

1. **Translate** ACP `McpServer[]` → `mcpServers` at `newSession`/`resume` (and current `loadSession`)
   before `PiRpcProcess.spawn`: stdio `{name,command,args,env}` → `{ "<name>":{command,args,env} }`;
   http `{type:"http",name,url,headers}` → `{ "<name>":{url} }` (+headers if supported); sse/acp →
   skip + notice.
2. **Write** `<cwd>/.pi/mcp.json` only when the client supplied servers; track the path on the session;
   delete on teardown (mirror `sessionFile` cleanup). Never overwrite a `.pi/mcp.json` we didn't
   author — merge or skip + notice.
3. **Presence check**: read pi `settings.json` `packages` (same files `buildStartupInfo` parses); if
   `pi-mcp-adapter` isn't present and servers were supplied, emit a one-time startup notice. No
   auto-install, no settings mutation.
4. **Advertise honestly**: keep `mcpCapabilities:{http:false,sse:false}` until translation lands, then
   `{http:true,sse:false}`.
5. Verify (light): whether newer pi has any **native** MCP path before committing to the file-write
   route.

## 3. Recommended tracks

### Track A — ship now, pure v1 (no protocol risk)

- A1. **MCP config auto-write** (§2) — highest user value, version-agnostic.
- A2. **Bump SDK `0.26.0` → `1.4.0`** (stable v1 wire, `PROTOCOL_VERSION=1`). This alone gets us onto
  the SDK that also carries v2 behind the experimental flag, plus v1 fixes. Verify the current method
  set/types still compile across `0.x → 1.x`.
- A3. Small v1 parity on the v1 agent: `resumeSession` (no-replay, cap `sessionCapabilities.resume`),
  `closeSession` (cap `sessionCapabilities.close`), `logout` — all have internal equivalents already.

### Track B — v2 draft agent behind the router (build now, ship on stabilization)

Per scope decision, target a **published non-experimental** v2, but prototype against
`/experimental/v2` so we're ready and can give feedback while it's a draft.

- B1. **Restructure the entrypoint** to the dual-version router:
  `agentProtocolRouter().withV1(v1Agent).withV2(v2Agent).connect(stream)`. v1 agent = today's
  `PiAcpAgent`; v2 agent = new, importing `@agentclientprotocol/sdk/experimental/v2`. Share the
  pi-RPC layer (`src/pi-rpc/*`) and translation helpers between them.
- B2. **v2 initialize/capabilities**: `{protocolVersion:v2.PROTOCOL_VERSION, info, capabilities:{session:{}}}`.
- B3. **Prompt lifecycle** (§1a): async turn, `state_update` running→idle with `stopReason`.
- B4. **Modes → config options** (§1b): reuse the existing config-option code; drop the modes API.
- B5. **resume/replayFrom + close** (§1c).
- B6. **Unified message IDs** (§1d) and **structured diffs** (§1e).
- B7. **Forward-compat enums** (§1g).
- Gate B behind an env flag (e.g. `PI_ACP_ENABLE_V2`) and/or hold merge until the SDK drops
  `/experimental/`. Defer permission gating (§1f) — pi-blocked.

## 4. Open questions before Track B lands

- When does v2 graduate to a non-experimental SDK entry? That's the merge trigger per scope decision.
- Which target clients (Zed — AGENTS.md) negotiate v2 yet? No point defaulting the v2 path on before a
  client exercises it; the draft says don't ship by default.
- Does pi RPC's event stream map cleanly onto v2's `running`/`requires_action`/`idle` `state_update`
  model, or must the adapter synthesize those states from pi's turn-completion signal?

## 5. Non-goals

Remote/SSH resource composition, ACP fs/terminal delegation, forking, elicitation, providers, NES,
document-sync. (Where `victor-software-house/pi-acp` diverges — heavier, remote-focused, older SDK
`0.22.1`. Not a base for this repo.)

## Sources

- ACP v2 draft announcement (2026-07-20): https://agentclientprotocol.com/announcements/acp-v2-draft
- Migration guide: https://agentclientprotocol.com/protocol/v2/migration
- Draft v2 protocol docs: https://agentclientprotocol.com/protocol/v2/draft/overview
- Schema repo (`schema/v2/meta.json` → version 2): https://github.com/agentclientprotocol/agent-client-protocol
- TypeScript SDK 1.4.0 (stable v1 + experimental v2 at `/experimental/v2`, dual-version router):
  https://github.com/agentclientprotocol/typescript-sdk
- pi-mcp-adapter: https://github.com/nicobailon/pi-mcp-adapter
