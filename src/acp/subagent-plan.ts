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

/**
 * pi-subagents' own custom entry, appended on (background) completion. Unlike our bridge's live
 * lifecycle records, it carries the final `result`/`error` + timing — so we fold it into the fleet
 * to enrich completed tasks. It already crosses RPC as `entry_appended` (no bridge needed).
 */
export const SUBAGENT_RECORD_CUSTOM_TYPE = 'subagents:record'

/** Max characters of `result`/`error` carried in a plan entry's `_meta` (a preview, not the full text). */
const RESULT_PREVIEW_MAX = 2000

/** A single subagent, merged from the live bridge records and pi-subagents' final `subagents:record`. */
export type BridgeSubagent = {
  id: string
  type?: string
  description?: string
  /** Raw pi-subagents lifecycle: created | started | completed | failed | steered | compacted | error | aborted | stopped */
  status?: string
  /** Final output (from `subagents:record`). */
  result?: string
  /** Failure detail (from `subagents:record`). */
  error?: string
  durationMs?: number
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

/**
 * Parse pi-subagents' `subagents:record` payload
 * (`{id,type,description,status,result,error,startedAt,completedAt}`) into a fleet record carrying
 * the final status + result/error + duration. Returns null when there's no usable id.
 */
export function parseSubagentRecord(data: unknown): BridgeSubagent | null {
  if (data == null || typeof data !== 'object') return null
  const rec = data as {
    id?: unknown
    type?: unknown
    description?: unknown
    status?: unknown
    result?: unknown
    error?: unknown
    startedAt?: unknown
    completedAt?: unknown
  }
  if (typeof rec.id !== 'string' || rec.id === '') return null

  const started = typeof rec.startedAt === 'number' ? rec.startedAt : undefined
  const completed = typeof rec.completedAt === 'number' ? rec.completedAt : undefined
  const durationMs = started != null && completed != null && completed >= started ? completed - started : undefined

  return {
    id: rec.id,
    type: typeof rec.type === 'string' ? rec.type : undefined,
    description: typeof rec.description === 'string' ? rec.description : undefined,
    status: typeof rec.status === 'string' ? rec.status : undefined,
    result: typeof rec.result === 'string' ? rec.result : undefined,
    error: typeof rec.error === 'string' ? rec.error : undefined,
    durationMs
  }
}

const IN_PROGRESS_STATUSES = new Set(['started', 'running', 'steered', 'compacted'])
const FAILED_STATUSES = new Set(['failed', 'stopped', 'aborted', 'error'])

// ACP PlanEntryStatus has no failed/aborted/errored, so these terminal statuses all render as
// `completed` — but we keep the distinction in the content suffix instead of flattening to "failed".
const TERMINAL_LABELS: Record<string, string> = {
  failed: 'failed',
  error: 'errored',
  stopped: 'stopped',
  aborted: 'aborted'
}

/**
 * Lifecycle rank for a raw subagent status: `pending(0) < in_progress(1) < terminal(2)`.
 * pi-subagents can emit lifecycle events out of order over RPC (observed: `started` arriving
 * before `created`), so the adapter merges fleet status monotonically — never downgrading to an
 * earlier stage — using this rank.
 */
export function statusRank(status: string | undefined): number {
  const s = String(status ?? '').toLowerCase()
  if (s === 'completed' || FAILED_STATUSES.has(s)) return 2
  if (IN_PROGRESS_STATUSES.has(s)) return 1
  return 0
}

/**
 * Merge one incoming subagent record into the accumulated fleet entry for its id. Single source
 * of truth for both the live `acp:subagents` lifecycle records and the final `subagents:record`:
 *  - preserves `type`/`description` when the incoming record omits them,
 *  - is lifecycle-monotonic on `status` — never downgrades to an earlier stage, since pi can emit
 *    events out of order (e.g. `started` before `created`).
 * `result`/`error`/`durationMs` come through from whichever record carries them (records without
 * those keys don't clobber a prior value).
 */
export function mergeSubagent(prev: BridgeSubagent | undefined, incoming: BridgeSubagent): BridgeSubagent {
  const merged: BridgeSubagent = { ...prev, ...incoming }
  if (prev?.type && !incoming.type) merged.type = prev.type
  if (prev?.description && !incoming.description) merged.description = prev.description
  if (prev) {
    const prevStatus = String(prev.status ?? '').toLowerCase()
    const incomingStatus = String(incoming.status ?? '').toLowerCase()
    const prevRank = statusRank(prevStatus)
    const incomingRank = statusRank(incomingStatus)
    if (prevRank > incomingRank) {
      // Never downgrade to an earlier lifecycle stage (pi can emit `started` before `created`).
      merged.status = prev.status
    } else if (prevRank === 2 && incomingRank === 2 && incomingStatus === 'failed' && prevStatus !== 'failed') {
      // Both terminal: keep the specific reason (error/stopped/aborted/completed) over the generic
      // `failed` the extension emits from the `subagents:failed` event, regardless of arrival order.
      merged.status = prev.status
    }
  }
  return merged
}

function preview(text: string): string {
  return text.length > RESULT_PREVIEW_MAX ? text.slice(0, RESULT_PREVIEW_MAX) + '…' : text
}

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
    suffix = ` (${TERMINAL_LABELS[status] ?? 'failed'})`
  } else if (status === 'completed') {
    planStatus = 'completed'
  } else if (IN_PROGRESS_STATUSES.has(status)) {
    planStatus = 'in_progress'
  } else {
    // created, queued, unknown → not yet running
    planStatus = 'pending'
  }

  const entry: PlanEntry = { content: content + suffix, priority: 'medium', status: planStatus }

  // Tag the section (so a client can group the fleet apart from the cribsheet plan) and carry the
  // subagent's result/error/timing (from `subagents:record`) as a preview — without polluting
  // the plan `content`.
  const piAcp: Record<string, unknown> = { section: 'agents' }
  const subagent: Record<string, unknown> = {}
  if (agent.result) subagent.result = preview(agent.result)
  if (agent.error) subagent.error = preview(agent.error)
  if (agent.durationMs != null) subagent.durationMs = agent.durationMs
  if (Object.keys(subagent).length) piAcp.subagent = subagent
  entry._meta = { piAcp }

  return entry
}

/** Build the ACP Plan `entries` list from the accumulated fleet. */
export function toPlanEntries(agents: Iterable<BridgeSubagent>): PlanEntry[] {
  return Array.from(agents, toPlanEntry)
}
