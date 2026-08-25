/**
 * pi extension entry for the `pi-acp` package.
 *
 * pi-acp is primarily an external ACP adapter (the `pi-acp` binary). This file is the *other*
 * role of the same package: a pi extension, loaded when you `pi install npm:pi-acp`, that
 * surfaces the pi-subagents fleet to the adapter as an ACP plan.
 *
 * pi's RPC mode forwards the AgentSession event stream but NOT the in-process `pi.events` bus, so
 * the adapter (an external RPC client) can't see `subagents:*` events directly. This extension runs
 * inside pi, subscribes to that bus, and for each change persists a custom session entry via
 * `pi.appendEntry("acp:subagents", <record>)`. Appending an entry emits `entry_appended`, which pi
 * DOES forward over RPC — so the adapter (src/acp/subagent-plan.ts) can decode it into an ACP
 * `plan` update. A custom entry (vs a transient UI `setStatus`) keeps the payload structured and
 * persisted, and needs no UI context.
 *
 * Activates when pi runs headless over RPC (`ctx.mode === 'rpc'`) — which is exactly how an ACP
 * adapter drives it — so this stays inert in a normal terminal (`tui`) `pi` session with no env
 * var required. `PI_ACP=1` is still honored as an explicit override. No user configuration; it just
 * works.
 *
 * Types are declared locally on purpose: pi-acp does not depend on `@earendil-works/pi-coding-agent`
 * (it drives pi over RPC). pi injects the real API at load time.
 */

const CUSTOM_TYPE = 'acp:subagents'
const PLAN_CUSTOM_TYPE = 'acp:plan'

type BusHandler = (data: unknown) => void
type HookHandler = (event: unknown, ctx: unknown) => void

interface PiExtensionApi {
  on(event: string, handler: HookHandler): void
  events: { on(channel: string, handler: BusHandler): () => void }
  appendEntry(customType: string, data?: unknown): string
}

type Agent = { id: string; type?: string; description?: string; status: string }
type LifecyclePayload = { id?: unknown; type?: unknown; description?: unknown }

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export default function (pi: PiExtensionApi): void {
  // Bridge only when driven headless over RPC (an ACP adapter), not in the interactive TUI, where
  // these entries would be pointless clutter. `mode` is read from the session_start context (the
  // extension's own load runs before mode is set). `PI_ACP=1` remains an explicit override.
  let active = process.env.PI_ACP === '1'

  // Keep each agent's merged record so every appended entry is self-contained (later lifecycle
  // events like `steered` carry only an id).
  const agents = new Map<string, Agent>()

  const append = (customType: string, data: unknown): void => {
    if (!active) return
    try {
      pi.appendEntry(customType, data)
    } catch {
      // best effort; a dropped record self-heals on the next event
    }
  }

  const record =
    (status: string): BusHandler =>
    data => {
      const p = data as LifecyclePayload
      const id = str(p?.id)
      if (!id) return
      const prev = agents.get(id)
      const agent: Agent = {
        id,
        type: str(p.type) ?? prev?.type,
        description: str(p.description) ?? prev?.description,
        status
      }
      agents.set(id, agent)
      append(CUSTOM_TYPE, agent)
    }

  // Plan bus (e.g. pi-cribsheet): forward full snapshots and part-by-part updates over RPC. The
  // in-process `pi.events` bus is not RPC-forwarded, so — exactly as with `subagents:*` above — we
  // re-emit each as a persisted `acp:plan` custom entry, tagged with its operation.
  const forwardPlan =
    (op: 'snapshot' | 'update'): BusHandler =>
    data => {
      if (data == null || typeof data !== 'object') return
      append(PLAN_CUSTOM_TYPE, { op, ...(data as Record<string, unknown>) })
    }

  // Activate only when pi is driven headless over RPC (any ACP adapter). session_start fires
  // before any subagent event and re-evaluates on new/switch/resume. `PI_ACP=1` stays an override.
  pi.on('session_start', (_event, ctx) => {
    const mode = (ctx as { mode?: unknown } | null)?.mode
    active = mode === 'rpc' || process.env.PI_ACP === '1'
  })

  pi.events.on('subagents:created', record('created'))
  pi.events.on('subagents:started', record('started'))
  pi.events.on('subagents:completed', record('completed'))
  pi.events.on('subagents:failed', record('failed'))
  pi.events.on('subagents:steered', record('steered'))
  pi.events.on('subagents:compacted', record('compacted'))

  pi.events.on('plan:snapshot', forwardPlan('snapshot'))
  pi.events.on('plan:update', forwardPlan('update'))

  // Reset the plan when the session ends so a stale fleet doesn't linger.
  pi.on('session_shutdown', () => {
    agents.clear()
    append(CUSTOM_TYPE, { clear: true })
    append(PLAN_CUSTOM_TYPE, { op: 'clear' })
  })
}
