import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSubagentEntry,
  parseSubagentRecord,
  mergeSubagent,
  toPlanEntries,
  SUBAGENT_PLAN_CUSTOM_TYPE,
  SUBAGENT_RECORD_CUSTOM_TYPE,
  type BridgeSubagent
} from '../../src/acp/subagent-plan.js'

test('SUBAGENT_PLAN_CUSTOM_TYPE is the agreed custom entry type', () => {
  assert.equal(SUBAGENT_PLAN_CUSTOM_TYPE, 'acp:subagents')
})

test('parseSubagentEntry: single agent record', () => {
  const parsed = parseSubagentEntry({ id: 'a', type: 'Explore', description: 'find', status: 'started' })
  assert.deepEqual(parsed, { agent: { id: 'a', type: 'Explore', description: 'find', status: 'started' } })
})

test('parseSubagentEntry: clear signal', () => {
  assert.deepEqual(parseSubagentEntry({ clear: true }), { clear: true })
})

test('parseSubagentEntry: missing/blank id → null', () => {
  assert.equal(parseSubagentEntry({ status: 'started' }), null)
  assert.equal(parseSubagentEntry({ id: '', status: 'started' }), null)
})

test('parseSubagentEntry: non-object → null', () => {
  assert.equal(parseSubagentEntry(undefined), null)
  assert.equal(parseSubagentEntry('nope'), null)
})

test('parseSubagentEntry: coerces non-string optional fields to undefined', () => {
  const parsed = parseSubagentEntry({ id: 'a', type: 5, description: null, status: 42 })
  assert.deepEqual(parsed, { agent: { id: 'a', type: undefined, description: undefined, status: undefined } })
})

test('toPlanEntries: status mapping', () => {
  const fleet: BridgeSubagent[] = [
    { id: '1', description: 'a', status: 'created' },
    { id: '2', description: 'b', status: 'started' },
    { id: '3', description: 'c', status: 'steered' },
    { id: '4', description: 'd', status: 'compacted' },
    { id: '5', description: 'e', status: 'completed' },
    { id: '6', description: 'f', status: 'failed' },
    { id: '7', description: 'g', status: 'aborted' }
  ]
  assert.deepEqual(
    toPlanEntries(fleet).map(e => e.status),
    ['pending', 'in_progress', 'in_progress', 'in_progress', 'completed', 'completed', 'completed']
  )
})

test('SUBAGENT_RECORD_CUSTOM_TYPE is pi-subagents own entry type', () => {
  assert.equal(SUBAGENT_RECORD_CUSTOM_TYPE, 'subagents:record')
})

test('parseSubagentRecord: final record with result + duration from timestamps', () => {
  const rec = parseSubagentRecord({
    id: 'a',
    type: 'Explore',
    description: 'find',
    status: 'completed',
    result: 'found 3 files',
    startedAt: 1000,
    completedAt: 4200
  })
  assert.deepEqual(rec, {
    id: 'a',
    type: 'Explore',
    description: 'find',
    status: 'completed',
    result: 'found 3 files',
    error: undefined,
    durationMs: 3200
  })
})

test('parseSubagentRecord: missing id → null', () => {
  assert.equal(parseSubagentRecord({ status: 'completed', result: 'x' }), null)
})

test('toPlanEntries: result/error/duration surface in entry _meta (truncated preview)', () => {
  const big = 'x'.repeat(5000)
  const entries = toPlanEntries([
    { id: '1', type: 'Explore', description: 'a', status: 'completed', result: big, durationMs: 1234 },
    { id: '2', description: 'b', status: 'error', error: 'boom' },
    { id: '3', description: 'c', status: 'started' }
  ] as BridgeSubagent[])

  const meta0 = entries[0]._meta as { piAcp: { subagent: { result: string; durationMs: number } } }
  assert.equal(meta0.piAcp.subagent.durationMs, 1234)
  assert.equal(meta0.piAcp.subagent.result.length, 2001) // 2000 + '…'
  assert.match(meta0.piAcp.subagent.result, /…$/)

  const meta1 = entries[1]._meta as { piAcp: { subagent: { error: string } } }
  assert.equal(meta1.piAcp.subagent.error, 'boom')

  assert.deepEqual(entries[2]._meta, { piAcp: { section: 'agents' } }) // no result/error → section only
})

test('toPlanEntries: content formatting + failed annotation + accepts a Map iterator', () => {
  const fleet = new Map<string, BridgeSubagent>()
  fleet.set('1', { id: '1', type: 'Explore', description: 'find auth', status: 'started' })
  fleet.set('2', { id: '2', description: 'no type', status: 'started' })
  fleet.set('3', { id: '3', type: 'Agent', description: 'broke', status: 'failed' })
  fleet.set('agent-42', { id: 'agent-42', status: 'created' })

  const [typed, untyped, failed, idOnly] = toPlanEntries(fleet.values())
  assert.equal(typed.content, '[Explore] find auth')
  assert.equal(untyped.content, 'no type')
  assert.equal(failed.content, '[Agent] broke (failed)')
  assert.equal(idOnly.content, 'agent-42') // falls back to id when no description
  assert.equal(typed.priority, 'medium')
})

test('toPlanEntries: terminal statuses map to completed but keep a distinct annotation', () => {
  const fleet = new Map<string, BridgeSubagent>()
  fleet.set('a', { id: 'a', description: 'x', status: 'aborted' })
  fleet.set('e', { id: 'e', description: 'x', status: 'error' })
  fleet.set('s', { id: 's', description: 'x', status: 'stopped' })

  const [aborted, errored, stopped] = toPlanEntries(fleet.values())
  // ACP has only pending/in_progress/completed, so all render as completed…
  assert.equal(aborted.status, 'completed')
  assert.equal(errored.status, 'completed')
  assert.equal(stopped.status, 'completed')
  // …but the raw terminal state is preserved in the content.
  assert.equal(aborted.content, 'x (aborted)')
  assert.equal(errored.content, 'x (errored)')
  assert.equal(stopped.content, 'x (stopped)')
})

test('mergeSubagent: a specific terminal reason is not clobbered by the generic `failed`', () => {
  // Specific record status arrives first, then the extension's generic `failed` event.
  let a = mergeSubagent(undefined, { id: '1', status: 'error' })
  a = mergeSubagent(a, { id: '1', status: 'failed' })
  assert.equal(a.status, 'error', 'generic failed must not overwrite the specific error')

  // And the reverse arrival order also keeps the specific reason.
  let b = mergeSubagent(undefined, { id: '2', status: 'failed' })
  b = mergeSubagent(b, { id: '2', status: 'aborted' })
  assert.equal(b.status, 'aborted')
})
