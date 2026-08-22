import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * pi-acp-subagent-bridge
 *
 * A pi extension that surfaces the pi-subagents fleet to the pi-acp ACP adapter.
 *
 * pi's RPC mode forwards the AgentSession event stream + `extension_ui_request`, but NOT the
 * in-process `pi.events` bus — so pi-acp (an external RPC client) can't see `subagents:*`
 * events directly. This extension runs inside pi, subscribes to that bus, and re-emits the
 * whole fleet as a `setStatus("acp:subagents", …)` snapshot, which DOES cross the RPC boundary.
 * pi-acp decodes it into an ACP `plan` update.
 *
 * Install it like any pi package (e.g. `pi install npm:pi-acp-subagent-bridge`). It activates
 * only when `PI_ACP_SUBAGENT_PLAN=true` is present in the environment — pi-acp sets that on the
 * pi process it spawns, so the bridge stays inert in a normal terminal pi session.
 */

const STATUS_KEY = 'acp:subagents'

type Agent = { id: string; type?: string; description?: string; status: string }
type LifecyclePayload = { id?: unknown; type?: unknown; description?: unknown }
type UiContext = { ui?: { setStatus?: (key: string, text: string | undefined) => void } }

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_ACP_SUBAGENT_PLAN !== 'true') return

  const agents = new Map<string, Agent>()
  let ui: UiContext['ui'] | null = null

  // ctx.ui isn't handed to bus handlers, so capture it from hooks that carry it.
  const capture = (_event: unknown, ctx: unknown): void => {
    const candidate = (ctx as UiContext)?.ui
    if (candidate?.setStatus) ui = candidate
  }
  pi.on('session_start', capture)
  pi.on('tool_execution_start', capture)

  const push = (): void => {
    try {
      ui?.setStatus?.(STATUS_KEY, JSON.stringify({ v: 1, agents: [...agents.values()] }))
    } catch {
      // best effort; a dropped snapshot self-heals on the next event
    }
  }

  const record =
    (status: string) =>
    (data: unknown): void => {
      const p = data as LifecyclePayload
      const id = str(p?.id)
      if (!id) return
      agents.set(id, { id, type: str(p.type), description: str(p.description), status })
      push()
    }

  pi.events.on('subagents:created', record('created'))
  pi.events.on('subagents:started', record('started'))
  pi.events.on('subagents:completed', record('completed'))
  pi.events.on('subagents:failed', record('failed'))
  pi.events.on('subagents:steered', record('steered'))
  pi.events.on('subagents:compacted', record('compacted'))

  // Clear the plan when the session ends so a stale fleet doesn't linger.
  pi.on('session_shutdown', () => {
    agents.clear()
    push()
  })
}
