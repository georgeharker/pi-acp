import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSubagentStatus, toPlanEntries, SUBAGENT_PLAN_STATUS_KEY } from '../../src/acp/subagent-plan.js'

test('SUBAGENT_PLAN_STATUS_KEY is the agreed key', () => {
  assert.equal(SUBAGENT_PLAN_STATUS_KEY, 'acp:subagents')
})

test('parseSubagentStatus: snapshot form { v, agents }', () => {
  const agents = parseSubagentStatus(
    JSON.stringify({ v: 1, agents: [{ id: 'a', type: 'Explore', description: 'find', status: 'started' }] })
  )
  assert.deepEqual(agents, [{ id: 'a', type: 'Explore', description: 'find', status: 'started' }])
})

test('parseSubagentStatus: plain array form', () => {
  const agents = parseSubagentStatus(JSON.stringify([{ id: 'x', status: 'created' }]))
  assert.deepEqual(agents, [{ id: 'x', type: undefined, description: undefined, status: 'created' }])
})

test('parseSubagentStatus: empty / undefined → [] (cleared)', () => {
  assert.deepEqual(parseSubagentStatus(undefined), [])
  assert.deepEqual(parseSubagentStatus(''), [])
  assert.deepEqual(parseSubagentStatus('   '), [])
})

test('parseSubagentStatus: invalid JSON → null (leave plan untouched)', () => {
  assert.equal(parseSubagentStatus('{not json'), null)
})

test('parseSubagentStatus: non-array agents → null', () => {
  assert.equal(parseSubagentStatus(JSON.stringify({ v: 1, agents: 'nope' })), null)
})

test('parseSubagentStatus: drops entries without a string id', () => {
  const agents = parseSubagentStatus(JSON.stringify({ agents: [{ status: 'x' }, { id: 'keep', status: 'started' }] }))
  assert.deepEqual(agents, [{ id: 'keep', type: undefined, description: undefined, status: 'started' }])
})

test('toPlanEntries: status mapping', () => {
  const entries = toPlanEntries([
    { id: '1', description: 'a', status: 'created' },
    { id: '2', description: 'b', status: 'started' },
    { id: '3', description: 'c', status: 'running' },
    { id: '4', description: 'd', status: 'steered' },
    { id: '5', description: 'e', status: 'completed' },
    { id: '6', description: 'f', status: 'failed' },
    { id: '7', description: 'g', status: 'aborted' }
  ])
  assert.deepEqual(
    entries.map(e => e.status),
    ['pending', 'in_progress', 'in_progress', 'in_progress', 'completed', 'completed', 'completed']
  )
})

test('toPlanEntries: content formatting + failed annotation', () => {
  const [typed, untyped, failed, idOnly] = toPlanEntries([
    { id: '1', type: 'Explore', description: 'find auth', status: 'started' },
    { id: '2', description: 'no type', status: 'started' },
    { id: '3', type: 'Agent', description: 'broke', status: 'failed' },
    { id: 'agent-42', status: 'created' }
  ])
  assert.equal(typed.content, '[Explore] find auth')
  assert.equal(untyped.content, 'no type')
  assert.equal(failed.content, '[Agent] broke (failed)')
  assert.equal(idOnly.content, 'agent-42') // falls back to id when no description
  assert.equal(typed.priority, 'medium')
})
