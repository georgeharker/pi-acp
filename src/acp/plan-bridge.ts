import type { PlanEntry } from '@agentclientprotocol/sdk'

/**
 * Maps a cribsheet-style plan (surfaced on pi's in-process bus) into an ACP Plan.
 *
 * The producer is a plan SOURCE extension (e.g. pi-cribsheet) that emits full snapshots on the
 * `plan:snapshot` channel and part-by-part patches on `plan:update`. Those live on pi's in-process
 * `pi.events` bus, which is NOT forwarded over RPC — so, exactly as with the subagent fleet, our
 * bundled pi extension (see `src/pi-extension.ts`) subscribes to both channels and re-emits each as
 * a persisted custom entry via `pi.appendEntry('acp:plan', <payload>)`. That crosses RPC as
 * `entry_appended`, which the adapter decodes here into a {@link PlanState}.
 *
 * Two operations arrive, discriminated by `op`:
 *  - `snapshot` — replace a namespace's whole item set,
 *  - `update`   — upsert/remove items by id within a namespace,
 *  - `clear`    — drop all plan state (e.g. on session shutdown).
 *
 * State is kept per-namespace (`ns`) so multiple plan sources can coexist; `seq` (per ns) guards
 * against out-of-order delivery. The accumulated state is flattened to ACP `PlanEntry[]` on egress
 * (ACP plans are a flat list with no ids or dependencies).
 */
export const PLAN_CUSTOM_TYPE = 'acp:plan'

/** One plan item. Rich fields (`kind`, `tainted`, `deps`) are optional — a simple source omits them. */
export type PlanItem = {
  id: string
  title: string
  status?: string
  deps?: string[]
  kind?: string
  tainted?: boolean
}

type PlanOp =
  | { op: 'clear' }
  | { op: 'snapshot'; ns: string; seq?: number; items: PlanItem[] }
  | { op: 'update'; ns: string; seq?: number; upsert?: PlanItem[]; remove?: string[] }

/** Accumulated plan state: per-namespace item maps plus the last-seen seq for out-of-order guarding. */
export type PlanState = {
  byNs: Map<string, Map<string, PlanItem>>
  lastSeq: Map<string, number>
}

export function newPlanState(): PlanState {
  return { byNs: new Map(), lastSeq: new Map() }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

function toItem(v: unknown): PlanItem | null {
  if (v == null || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  // `title` is the wire field; tolerate `name` from sources that haven't renamed yet.
  const title = str(r.title) ?? str(r.name) ?? id
  const deps = Array.isArray(r.deps) ? r.deps.filter((d): d is string => typeof d === 'string') : undefined
  return {
    id,
    title,
    status: str(r.status),
    deps: deps && deps.length ? deps : undefined,
    kind: str(r.kind),
    tainted: typeof r.tainted === 'boolean' ? r.tainted : undefined
  }
}

/** Parse an `acp:plan` custom-entry payload into a discriminated op, or null when unusable. */
export function parsePlanEntry(data: unknown): PlanOp | null {
  if (data == null || typeof data !== 'object') return null
  const r = data as Record<string, unknown>
  const op = str(r.op)
  if (op === 'clear') return { op: 'clear' }

  const ns = str(r.ns) ?? 'default'
  const seq = typeof r.seq === 'number' ? r.seq : undefined

  if (op === 'snapshot') {
    const items = Array.isArray(r.items) ? (r.items.map(toItem).filter(Boolean) as PlanItem[]) : []
    return { op: 'snapshot', ns, seq, items }
  }
  if (op === 'update') {
    const upsert = Array.isArray(r.upsert) ? (r.upsert.map(toItem).filter(Boolean) as PlanItem[]) : undefined
    const remove = Array.isArray(r.remove) ? r.remove.filter((d): d is string => typeof d === 'string') : undefined
    return { op: 'update', ns, seq, upsert, remove }
  }
  return null
}

/**
 * Apply one parsed op to the state, in place. Returns true when the state changed (so the caller
 * only re-emits the ACP plan on a real change). Out-of-order messages (a `seq` not greater than the
 * last seen for that ns) are dropped.
 */
export function applyPlanEntry(state: PlanState, op: PlanOp): boolean {
  if (op.op === 'clear') {
    if (state.byNs.size === 0) return false
    state.byNs.clear()
    state.lastSeq.clear()
    return true
  }

  if (op.seq != null) {
    const last = state.lastSeq.get(op.ns)
    if (last != null && op.seq <= last) return false
    state.lastSeq.set(op.ns, op.seq)
  }

  if (op.op === 'snapshot') {
    const next = new Map<string, PlanItem>()
    for (const it of op.items) next.set(it.id, it)
    state.byNs.set(op.ns, next)
    return true
  }

  // update: patch the ns's map in place.
  const map = state.byNs.get(op.ns) ?? new Map<string, PlanItem>()
  let changed = false
  for (const it of op.upsert ?? []) {
    map.set(it.id, it)
    changed = true
  }
  for (const id of op.remove ?? []) {
    changed = map.delete(id) || changed
  }
  if (changed) state.byNs.set(op.ns, map)
  return changed
}

const DONE_STATUSES = new Set(['done', 'completed', 'complete'])
const IN_PROGRESS_STATUSES = new Set(['in-progress', 'in_progress', 'active', 'running', 'started'])

/** Map a plan item's status to ACP's `PlanEntryStatus` (pending | in_progress | completed). */
function planStatus(item: PlanItem): PlanEntry['status'] {
  const s = String(item.status ?? '').toLowerCase()
  if (DONE_STATUSES.has(s)) return 'completed'
  if (IN_PROGRESS_STATUSES.has(s)) return 'in_progress'
  return 'pending'
}

function toPlanEntry(item: PlanItem): PlanEntry {
  const kindPrefix = item.kind && item.kind !== 'plan' ? `(${item.kind}) ` : ''
  const taintSuffix = item.tainted ? ' (tainted)' : ''
  return {
    content: `${kindPrefix}${item.title}${taintSuffix}`,
    priority: 'medium',
    status: planStatus(item),
    // Tag the section so a client can group the cribsheet plan apart from the subagent fleet
    // (ACP plans are a flat list with no native sections).
    _meta: { piAcp: { section: 'plan' } }
  }
}

/** Flatten accumulated plan state to ACP `PlanEntry[]`, in namespace-then-insertion order. */
export function toPlanEntries(state: PlanState): PlanEntry[] {
  const entries: PlanEntry[] = []
  for (const map of state.byNs.values()) {
    for (const item of map.values()) entries.push(toPlanEntry(item))
  }
  return entries
}
