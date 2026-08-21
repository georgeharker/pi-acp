import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { translateMcpServers, writeMcpConfig, buildMcpNotice } from '../../src/acp/mcp-config.js'

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
}

test('translateMcpServers: stdio server → command/args/env', () => {
  const servers: McpServer[] = [
    { name: 'chrome', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.6.0'], env: [{ name: 'KEY', value: 'v' }] }
  ]
  const { config, skipped } = translateMcpServers(servers)
  assert.deepEqual(skipped, [])
  assert.deepEqual(config.mcpServers.chrome, {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.6.0'],
    env: { KEY: 'v' }
  })
  assert.equal(config._generatedBy, 'pi-acp')
})

test('translateMcpServers: http server → url/headers', () => {
  const servers: McpServer[] = [
    {
      type: 'http',
      name: 'remote',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }]
    }
  ]
  const { config, skipped } = translateMcpServers(servers)
  assert.deepEqual(skipped, [])
  assert.deepEqual(config.mcpServers.remote, {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer x' }
  })
})

test('translateMcpServers: sse/acp are skipped, not translated', () => {
  const servers: McpServer[] = [
    { type: 'sse', name: 'streamy', url: 'https://example.com/sse', headers: [] } as unknown as McpServer
  ]
  const { config, skipped } = translateMcpServers(servers)
  assert.deepEqual(skipped, ['streamy'])
  assert.deepEqual(config.mcpServers, {})
})

test('writeMcpConfig: writes .pi/mcp.json and cleanup removes it', () => {
  const cwd = tmpCwd()
  try {
    const servers: McpServer[] = [{ name: 'chrome', command: 'npx', args: [], env: [] }]
    const res = writeMcpConfig(cwd, servers)
    assert.ok(res.handle)
    const path = join(cwd, '.pi', 'mcp.json')
    assert.equal(res.handle!.path, path)
    assert.ok(existsSync(path))
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    assert.equal(parsed._generatedBy, 'pi-acp')
    assert.ok(parsed.mcpServers.chrome)

    res.handle!.cleanup()
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeMcpConfig: no servers → nothing written', () => {
  const cwd = tmpCwd()
  try {
    const res = writeMcpConfig(cwd, [])
    assert.equal(res.handle, null)
    assert.equal(existsSync(join(cwd, '.pi', 'mcp.json')), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeMcpConfig: preserves a hand-authored config and does not clean it up', () => {
  const cwd = tmpCwd()
  try {
    const dir = join(cwd, '.pi')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')
    const handwritten = JSON.stringify({ mcpServers: { mine: { command: 'x', args: [] } } }, null, 2)
    writeFileSync(path, handwritten, 'utf-8')

    const servers: McpServer[] = [{ name: 'chrome', command: 'npx', args: [], env: [] }]
    const res = writeMcpConfig(cwd, servers)

    assert.equal(res.handle, null)
    assert.equal(res.preservedExisting, true)
    // Untouched.
    assert.equal(readFileSync(path, 'utf-8'), handwritten)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeMcpConfig: overwrites a previously-generated config', () => {
  const cwd = tmpCwd()
  try {
    const first = writeMcpConfig(cwd, [{ name: 'a', command: 'a', args: [], env: [] }])
    assert.ok(first.handle)
    const second = writeMcpConfig(cwd, [{ name: 'b', command: 'b', args: [], env: [] }])
    assert.ok(second.handle)
    const parsed = JSON.parse(readFileSync(join(cwd, '.pi', 'mcp.json'), 'utf-8'))
    assert.ok(parsed.mcpServers.b)
    assert.equal(parsed.mcpServers.a, undefined)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('buildMcpNotice: warns when adapter missing and lists skipped servers', () => {
  const cwd = tmpCwd()
  // Isolate the global agent dir so the machine's real pi settings don't affect the check.
  const agentDir = tmpCwd()
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  try {
    const notice = buildMcpNotice(cwd, {
      handle: { path: join(cwd, '.pi', 'mcp.json'), cleanup: () => {} },
      skipped: ['streamy'],
      preservedExisting: false
    })
    assert.ok(notice)
    assert.match(notice!, /pi-mcp-adapter/)
    assert.match(notice!, /streamy/)
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
    rmSync(cwd, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('buildMcpNotice: silent when nothing to report', () => {
  const cwd = tmpCwd()
  try {
    const notice = buildMcpNotice(cwd, { handle: null, skipped: [], preservedExisting: false })
    assert.equal(notice, null)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
