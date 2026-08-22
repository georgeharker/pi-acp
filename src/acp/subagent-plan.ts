import type { PlanEntry } from '@agentclientprotocol/sdk'

/**
 * Maps pi-subagents lifecycle (delivered out-of-band over the extension UI channel as a
 * `setStatus` payload) into an ACP Plan. pi itself emits no ACP plans, so the plan channel
 * is used to surface the subagent fleet as a task list.
 *
 * The producer is a companion pi extension (loaded via `pi -e`) that subscribes to the
 * `subagents:*` event bus and pushes a full snapshot on each change:
 *
 *   ctx.ui.setStatus("acp:subagents", JSON.stringify({ v: 1, agents: [...] }))
 *
 * `setStatus` is a keyed, fire-and-forget replace, which mirrors ACP Plan's replace-whole
 * semantics: each snapshot is the complete current fleet.
 */
export const SUBAGENT_PLAN_STATUS_KEY = 'acp:subagents'

/** Whether subagent→plan mapping is enabled (opt-in while experimental). */
export const SUBAGENT_PLAN_ENABLED = process.env.PI_ACP_SUBAGENT_PLAN === 'true'

/** A single subagent as reported by the bridge extension (from the `subagents:*` bus). */
export type BridgeSubagent = {
  id: string
  type?: string
  description?: string
  /** Raw pi-subagents status: created | started | running | completed | failed | stopped | aborted | steered | compacted */
  status?: string
}

type BridgeSnapshot = {
  v?: number
  agents?: unknown
}

/**
 * Parse the `statusText` payload from a `setStatus` event into a subagent list.
 * Returns `[]` when the status was cleared (empty/undefined), or `null` when the payload
 * is present but unparseable (so the caller can leave the current plan untouched).
 */
export function parseSubagentStatus(statusText: string | undefined | null): BridgeSubagent[] | null {
  if (statusText == null || statusText.trim() === '') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(statusText)
  } catch {
    return null
  }

  const rawAgents = Array.isArray(parsed) ? parsed : (parsed as BridgeSnapshot)?.agents

  if (!Array.isArray(rawAgents)) return null

  const agents: BridgeSubagent[] = []
  for (const entry of rawAgents) {
    const rec = entry as { id?: unknown; type?: unknown; description?: unknown; status?: unknown } | null
    const id = typeof rec?.id === 'string' ? rec.id : ''
    if (!id) continue
    agents.push({
      id,
      type: typeof rec?.type === 'string' ? rec.type : undefined,
      description: typeof rec?.description === 'string' ? rec.description : undefined,
      status: typeof rec?.status === 'string' ? rec.status : undefined
    })
  }

  return agents
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

/** Build the ACP Plan `entries` list from a subagent snapshot. */
export function toPlanEntries(agents: readonly BridgeSubagent[]): PlanEntry[] {
  return agents.map(toPlanEntry)
}
