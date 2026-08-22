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
 * Activates only under the pi-acp adapter — which sets `PI_ACP=1` on the pi process it spawns — so
 * this stays inert in a normal terminal `pi` session. No user configuration; it just works.
 *
 * Types are declared locally on purpose: pi-acp does not depend on `@earendil-works/pi-coding-agent`
 * (it drives pi over RPC). pi injects the real API at load time.
 */

const CUSTOM_TYPE = 'acp:subagents'

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
  if (process.env.PI_ACP !== '1') return

  // Keep each agent's merged record so every appended entry is self-contained (later lifecycle
  // events like `steered` carry only an id).
  const agents = new Map<string, Agent>()

  const append = (data: unknown): void => {
    try {
      pi.appendEntry(CUSTOM_TYPE, data)
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
      append(agent)
    }

  pi.events.on('subagents:created', record('created'))
  pi.events.on('subagents:started', record('started'))
  pi.events.on('subagents:completed', record('completed'))
  pi.events.on('subagents:failed', record('failed'))
  pi.events.on('subagents:steered', record('steered'))
  pi.events.on('subagents:compacted', record('compacted'))

  // Reset the plan when the session ends so a stale fleet doesn't linger.
  pi.on('session_shutdown', () => {
    agents.clear()
    append({ clear: true })
  })
}
