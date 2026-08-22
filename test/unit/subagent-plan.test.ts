import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSubagentEntry,
  toPlanEntries,
  SUBAGENT_PLAN_CUSTOM_TYPE,
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
