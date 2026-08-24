import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

let dir: string
let prevAgentDir: string | undefined

beforeEach(() => {
  prevAgentDir = process.env.PI_CODING_AGENT_DIR
  dir = mkdtempSync(join(tmpdir(), 'pi-acp-settings-'))
  process.env.PI_CODING_AGENT_DIR = dir
})

afterEach(() => {
  if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  rmSync(dir, { recursive: true, force: true })
})

async function initEmbeddedContext() {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)
  assert.ok(res.agentCapabilities)
  assert.ok(res.agentCapabilities.promptCapabilities)
  return res.agentCapabilities.promptCapabilities.embeddedContext
}

const settingsPath = () => join(dir, 'extensions', 'pi-acp.json')
const legacyPath = () => join(dir, 'pi-acp.json')

test('embeddedContext defaults to true when no pi-acp.json exists', async () => {
  assert.equal(await initEmbeddedContext(), true)
})

test('initialize writes a default pi-acp.json in the extensions dir when absent', async () => {
  await initEmbeddedContext()
  const p = settingsPath()
  assert.ok(existsSync(p))
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), {
    embeddedContext: true,
    rpcTimeoutMs: 120000,
    debug: false
  })
})

test('embeddedContext honors pi-acp.json = false', async () => {
  mkdirSync(join(dir, 'extensions'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify({ embeddedContext: false }))
  assert.equal(await initEmbeddedContext(), false)
})

test('a pre-existing pi-acp.json is never overwritten', async () => {
  mkdirSync(join(dir, 'extensions'), { recursive: true })
  const p = settingsPath()
  writeFileSync(p, JSON.stringify({ embeddedContext: false }))
  await initEmbeddedContext()
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { embeddedContext: false })
})

test('legacy agent-root pi-acp.json is read as a fallback', async () => {
  writeFileSync(legacyPath(), JSON.stringify({ embeddedContext: false }))
  assert.equal(await initEmbeddedContext(), false)
})

test('a legacy agent-root pi-acp.json is not duplicated into extensions', async () => {
  writeFileSync(legacyPath(), JSON.stringify({ embeddedContext: false }))
  await initEmbeddedContext()
  assert.ok(!existsSync(settingsPath()))
})
