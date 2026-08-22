# pi-acp-subagent-bridge

A [pi](https://github.com/earendil-works/pi) extension that surfaces the
[pi-subagents](https://github.com/tintinweb/pi-subagents) fleet to the
[pi-acp](https://github.com/svkozak/pi-acp) ACP adapter as an ACP **plan** (task list).

## Why it exists

pi's RPC mode forwards the `AgentSession` event stream and `extension_ui_request`s, but **not**
the in-process `pi.events` bus. So an external ACP adapter (pi-acp) cannot see `subagents:*`
lifecycle events directly. This extension runs **inside** pi, subscribes to that bus, and
re-emits the whole fleet as a `setStatus("acp:subagents", …)` snapshot — which _does_ cross the
RPC boundary — so pi-acp can decode it into an ACP `plan` update.

```
pi-subagents  ──pi.events("subagents:*")──▶  this bridge  ──ctx.ui.setStatus("acp:subagents")──▶  pi RPC ──▶ pi-acp ──▶ ACP plan
```

## Install

```bash
pi install npm:pi-acp-subagent-bridge
```

## Activation

The bridge is **inert unless `PI_ACP_SUBAGENT_PLAN=true`** is in the environment. pi-acp sets that
on the pi process it spawns (when the same flag is enabled for pi-acp), so:

- Under pi-acp with the flag on → the bridge activates and pushes fleet snapshots.
- In a normal terminal `pi` session → the flag is absent → the bridge does nothing.

It also requires pi-subagents to be installed (otherwise no `subagents:*` events fire).

## Snapshot format

Each change pushes the complete fleet (replace-whole, matching ACP Plan semantics):

```json
{ "v": 1, "agents": [{ "id": "…", "type": "Explore", "description": "Find auth files", "status": "started" }] }
```

`status` is the raw pi-subagents lifecycle (`created` / `started` / `completed` / `failed` /
`steered` / `compacted`); pi-acp maps it to ACP `pending` / `in_progress` / `completed`.
