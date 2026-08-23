import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: settles the in-flight turn with error when pi exits mid-turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const turn = session.prompt('do something')
  proc.emit({ type: 'agent_start' })

  // pi dies before ever emitting `agent_settled`.
  proc.emitExit({ code: 1, signal: null })

  // The ACP request resolves (as error) instead of hanging forever.
  assert.equal(await turn, 'error')
})

test('PiAcpSession: settles queued turns when pi exits mid-turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')

  proc.emitExit({ code: null, signal: 'SIGKILL' })

  assert.equal(await first, 'error')
  assert.equal(await second, 'error')
})
