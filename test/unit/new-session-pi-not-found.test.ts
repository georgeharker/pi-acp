import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: newSession returns a helpful Internal error when pi is not installed', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-agentdir-'))
  process.env.PI_CODING_AGENT_DIR = agentDir
  // Point pi-acp's own settings at a non-existent binary so spawn fails deterministically.
  writeFileSync(join(agentDir, 'pi-acp.json'), JSON.stringify({ piCommand: 'pi-does-not-exist-12345' }))

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) =>
        e?.code === -32603 &&
        String(e?.message ?? '')
          .toLowerCase()
          .includes('executable not found')
    )
  } finally {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})
