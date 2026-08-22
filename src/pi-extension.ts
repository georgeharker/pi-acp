/**
 * pi extension entry for the `pi-acp` package.
 *
 * pi-acp is primarily an external ACP adapter (the `pi-acp` binary). This file is the *other*
 * role of the same package: a pi extension, loaded when you `pi install npm:pi-acp`, that
 * surfaces the pi-subagents fleet to the adapter as an ACP plan.
 *
 * pi's RPC mode forwards the AgentSession event stream + `extension_ui_request`, but NOT the
 * in-process `pi.events` bus — so the adapter (an external RPC client) can't see `subagents:*`
 * events directly. This extension runs inside pi, subscribes to that bus, and re-emits the whole
 * fleet as a `setStatus("acp:subagents", …)` snapshot, which DOES cross the RPC boundary. The
 * adapter (src/acp/subagent-plan.ts) decodes it into an ACP `plan` update.
 *
 * Activates only when `PI_ACP_SUBAGENT_PLAN=true` — the adapter sets that on the pi process it
 * spawns, so this stays inert in a normal terminal `pi` session.
 *
 * Types are declared locally on purpose: pi-acp does not depend on `@earendil-works/pi-coding-agent`
 * (it drives pi over RPC). pi injects the real API at load time.
 */

const STATUS_KEY = 'acp:subagents'

type BusHandler = (data: unknown) => void
type HookHandler = (event: unknown, ctx: unknown) => void

interface PiExtensionApi {
  on(event: string, handler: HookHandler): void
  events: { on(channel: string, handler: BusHandler): () => void }
}

type Agent = { id: string; type?: string; description?: string; status: string }
type LifecyclePayload = { id?: unknown; type?: unknown; description?: unknown }
type UiContext = { ui?: { setStatus?: (key: string, text: string | undefined) => void } }

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export default function (pi: PiExtensionApi): void {
  if (process.env.PI_ACP_SUBAGENT_PLAN !== 'true') return

  const agents = new Map<string, Agent>()
  let ui: UiContext['ui'] | null = null

  // ctx.ui isn't handed to bus handlers, so capture it from hooks that carry it.
  const capture: HookHandler = (_event, ctx) => {
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
    (status: string): BusHandler =>
    data => {
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
