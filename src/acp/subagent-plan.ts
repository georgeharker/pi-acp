import type { PlanEntry } from '@agentclientprotocol/sdk'

/**
 * Maps the pi-subagents fleet into an ACP Plan. pi itself emits no ACP plans, so the plan channel
 * is used to surface the subagent fleet as a task list.
 *
 * The producer is a companion pi extension (shipped in this package, see `src/pi-extension.ts`)
 * that subscribes to the `subagents:*` event bus and, for each change, persists a custom session
 * entry via `pi.appendEntry("acp:subagents", <record>)`. That emits an `entry_appended` event which
 * pi forwards over RPC (unlike the in-process bus itself), so the adapter can read it. Using a
 * custom entry (rather than a transient UI `setStatus`) keeps the payload structured and persisted.
 *
 * Each entry is one agent's current record (self-contained), keyed by `id`; the adapter accumulates
 * them into the fleet. A `{ clear: true }` entry resets the fleet (e.g. on session shutdown).
 */
export const SUBAGENT_PLAN_CUSTOM_TYPE = 'acp:subagents'

/** Whether subagent→plan mapping is enabled (opt-in while experimental). */
export const SUBAGENT_PLAN_ENABLED = process.env.PI_ACP_SUBAGENT_PLAN === 'true'

/** A single subagent as reported by the bridge extension (from the `subagents:*` bus). */
export type BridgeSubagent = {
  id: string
  type?: string
  description?: string
  /** Raw pi-subagents lifecycle: created | started | completed | failed | steered | compacted */
  status?: string
}

export type SubagentEntry = { clear: true } | { agent: BridgeSubagent }

/**
 * Parse the `data` of an `acp:subagents` custom entry into either a single agent record or a
 * clear signal. Returns `null` when the payload is unusable (so the caller leaves the fleet as-is).
 */
export function parseSubagentEntry(data: unknown): SubagentEntry | null {
  if (data == null || typeof data !== 'object') return null
  const rec = data as { clear?: unknown; id?: unknown; type?: unknown; description?: unknown; status?: unknown }

  if (rec.clear === true) return { clear: true }

  if (typeof rec.id !== 'string' || rec.id === '') return null

  return {
    agent: {
      id: rec.id,
      type: typeof rec.type === 'string' ? rec.type : undefined,
      description: typeof rec.description === 'string' ? rec.description : undefined,
      status: typeof rec.status === 'string' ? rec.status : undefined
    }
  }
}

const IN_PROGRESS_STATUSES = new Set(['started', 'running', 'steered', 'compacted'])
const FAILED_STATUSES = new Set(['failed', 'stopped', 'aborted', 'error'])

/**
 * Map a bridge subagent to an ACP {@link PlanEntry}. ACP's `PlanEntryStatus` has no `failed`
 * value, so a failed subagent maps to `completed` with a `(failed)` annotation in `content`.
 */
function toPlanEntry(agent: BridgeSubagent): PlanEntry {
  const label = agent.description?.trim() || agent.id
  const content = agent.type ? `[${agent.type}] ${label}` : label

  const status = String(agent.status ?? '').toLowerCase()
  let planStatus: PlanEntry['status']
  let suffix = ''

  if (FAILED_STATUSES.has(status)) {
    planStatus = 'completed'
    suffix = ' (failed)'
  } else if (status === 'completed') {
    planStatus = 'completed'
  } else if (IN_PROGRESS_STATUSES.has(status)) {
    planStatus = 'in_progress'
  } else {
    // created, queued, unknown → not yet running
    planStatus = 'pending'
  }

  return { content: content + suffix, priority: 'medium', status: planStatus }
}

/** Build the ACP Plan `entries` list from the accumulated fleet. */
export function toPlanEntries(agents: Iterable<BridgeSubagent>): PlanEntry[] {
  return Array.from(agents, toPlanEntry)
}
