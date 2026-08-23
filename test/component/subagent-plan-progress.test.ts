import test from 'node:test'
import assert from 'node:assert/strict'
import type { PlanEntry } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Simulate exactly what pi forwards over RPC for a custom entry:
//   { type: 'entry_appended', entry: { type: 'custom', customType, data, ... } }
function customEntry(customType: string, data: unknown) {
  return {
    type: 'entry_appended',
    entry: { type: 'custom', customType, data, id: 'e' + Math.random().toString(36).slice(2), timestamp: '' }
  }
}

// session.emit() serializes updates on an internal promise chain, so flush the microtask queue.
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function planUpdates(conn: FakeAgentSideConnection): PlanEntry[][] {
  return conn.updates
    .map(u => u.update)
    .filter((u): u is { sessionUpdate: 'plan'; entries: PlanEntry[] } => (u as any).sessionUpdate === 'plan')
    .map(u => u.entries)
}

test('adapter emits pending -> in_progress -> completed for a background subagent lifecycle', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Our bundled pi extension appends one acp:subagents record per lifecycle event.
  proc.emit(
    customEntry('acp:subagents', { id: 'agent-1', type: 'explore', description: 'find auth', status: 'created' })
  )
  proc.emit(
    customEntry('acp:subagents', { id: 'agent-1', type: 'explore', description: 'find auth', status: 'started' })
  )
  proc.emit(
    customEntry('acp:subagents', { id: 'agent-1', type: 'explore', description: 'find auth', status: 'completed' })
  )
  await flush()

  const plans = planUpdates(conn)
  assert.equal(plans.length, 3, 'one plan update per lifecycle entry')
  assert.equal(plans[0][0].status, 'pending')
  assert.equal(plans[1][0].status, 'in_progress', 'started must surface as in_progress')
  assert.equal(plans[2][0].status, 'completed')
})

test('adapter is monotonic: pi emitting started BEFORE created must not flap back to pending', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Real pi RPC order for a background subagent (observed): started, then created, then completed.
  proc.emit(customEntry('acp:subagents', { id: 'agent-1', description: 'x', status: 'started' }))
  proc.emit(customEntry('acp:subagents', { id: 'agent-1', description: 'x', status: 'created' }))
  proc.emit(customEntry('acp:subagents', { id: 'agent-1', description: 'x', status: 'completed' }))
  await flush()

  const plans = planUpdates(conn)
  // started -> in_progress; the out-of-order created must NOT downgrade it back to pending.
  assert.equal(plans[0][0].status, 'in_progress')
  assert.equal(plans[1][0].status, 'in_progress', 'late `created` must not flap to pending')
  assert.equal(plans[2][0].status, 'completed')
})

test('adapter is monotonic: a late subagents:record does not downgrade a terminal status', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(customEntry('acp:subagents', { id: 'agent-1', description: 'x', status: 'completed' }))
  // A stale in_progress arriving afterwards must not revert the finished task to running.
  proc.emit(customEntry('acp:subagents', { id: 'agent-1', description: 'x', status: 'started' }))
  await flush()
  assert.equal(planUpdates(conn).at(-1)?.[0].status, 'completed')
})

test('adapter surfaces in_progress even if only started arrives (no created seen first)', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(customEntry('acp:subagents', { id: 'agent-1', description: 'x', status: 'started' }))
  await flush()
  const plans = planUpdates(conn)
  assert.equal(plans.at(-1)?.[0].status, 'in_progress')
})
