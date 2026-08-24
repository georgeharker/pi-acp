import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

function fakeBashSpawn() {
  return {
    onExit: () => () => {},
    onEvent: () => () => {},
    getMessages: async () => ({
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'bash',
          args: { command: 'echo hello' },
          content: [{ type: 'text', text: 'hello from bash' }],
          isError: false
        }
      ]
    }),
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' })
  } as any
}

test('PiAcpAgent: loadSession replays bash toolResult as a terminal when the client supports terminals', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => fakeBashSpawn()

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.initialize({ protocolVersion: 1, clientCapabilities: { terminal: true } } as any)
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd: '/tmp/project' } })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
    assert.equal(toolCallUpdate.rawOutput, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays bash toolResult as a content block when the client lacks terminals', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => fakeBashSpawn()

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    // No initialize (or a client without `terminal`) → terminal-less fallback.
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.equal(toolCall.status, 'completed')
    assert.deepEqual(toolCall.content, [{ type: 'content', content: { type: 'text', text: 'hello from bash' } }])
    assert.equal(toolCall._meta, undefined)

    // Terminal-less replay is a single completed tool_call; no terminal `_meta` update follows.
    const terminalUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u?._meta?.terminal_output)
    assert.equal(terminalUpdate, undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
