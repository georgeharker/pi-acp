import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import {
  translateMcpServers,
  writeMcpConfig,
  buildMcpNotice,
  loadMcpPolicy,
  cleanupStaleGeneratedConfig
} from '../../src/acp/mcp-config.js'

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

test('writeMcpConfig: writes a session-scoped temp file (NOT <cwd>/.pi) and cleanup removes it', () => {
  const cwd = tmpCwd()
  try {
    const servers: McpServer[] = [{ name: 'chrome', command: 'npx', args: [], env: [] }]
    const res = writeMcpConfig(servers)
    assert.ok(res.handle)
    const path = res.handle!.path
    // Not in the project's pi config namespace — a temp file.
    assert.equal(path.includes(join(cwd, '.pi')), false)
    assert.ok(existsSync(path))
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    assert.equal(parsed._generatedBy, 'pi-acp')
    assert.ok(parsed.mcpServers.chrome)
    // We never touch the project's .pi/mcp.json.
    assert.equal(existsSync(join(cwd, '.pi', 'mcp.json')), false)
    // Owner-only perms — the file can carry client-provided header/env secrets.
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600)
    }

    res.handle!.cleanup()
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeMcpConfig: no servers → nothing written', () => {
  const res = writeMcpConfig([])
  assert.equal(res.handle, null)
})

test('cleanupStaleGeneratedConfig: removes a pi-acp-generated <cwd>/.pi/mcp.json, leaves a hand-authored one', () => {
  const cwd = tmpCwd()
  try {
    const dir = join(cwd, '.pi')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'mcp.json')

    // pi-acp-generated (has the marker) → removed.
    writeFileSync(path, JSON.stringify({ mcpServers: {}, _generatedBy: 'pi-acp' }), 'utf-8')
    cleanupStaleGeneratedConfig(cwd)
    assert.equal(existsSync(path), false)

    // hand-authored (no marker) → left untouched.
    const handwritten = JSON.stringify({ mcpServers: { mine: { command: 'x', args: [] } } })
    writeFileSync(path, handwritten, 'utf-8')
    cleanupStaleGeneratedConfig(cwd)
    assert.equal(readFileSync(path, 'utf-8'), handwritten)
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
      preserved: []
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
    const notice = buildMcpNotice(cwd, { handle: null, skipped: [], preserved: [] })
    assert.equal(notice, null)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('policy: exclude → server is not generated (deferred to user config); others still generated', () => {
  const servers: McpServer[] = [
    {
      type: 'http',
      name: 'mcp-combiner',
      url: 'http://127.0.0.1:9741/mcp/tok',
      headers: [{ name: 'X-Session', value: 'tok' }]
    },
    { type: 'http', name: 'other', url: 'http://localhost:1/mcp', headers: [] }
  ]
  const { config, preserved } = translateMcpServers(servers, { exclude: ['mcp-combiner'] })
  assert.deepEqual(preserved, ['mcp-combiner'])
  assert.equal(config.mcpServers['mcp-combiner'], undefined) // not written — user's own entry stands
  assert.ok(config.mcpServers.other) // others still generated
})

test('policy: generate allowlist writes only named servers (rest preserved); case-insensitive', () => {
  const servers: McpServer[] = [
    { type: 'http', name: 'Keep', url: 'http://localhost:1/mcp', headers: [] },
    { type: 'http', name: 'Drop', url: 'http://localhost:2/mcp', headers: [] }
  ]
  const { config, preserved } = translateMcpServers(servers, { generate: ['keep'] })
  assert.ok(config.mcpServers.Keep)
  assert.equal(config.mcpServers.Drop, undefined)
  assert.deepEqual(preserved, ['Drop'])
})

test('policy: generate:false writes nothing (all preserved)', () => {
  const servers: McpServer[] = [{ type: 'http', name: 'a', url: 'http://localhost:1/mcp', headers: [] }]
  const { config, preserved } = translateMcpServers(servers, { generate: false })
  assert.deepEqual(config.mcpServers, {})
  assert.deepEqual(preserved, ['a'])
})

test('policy.auth: bearerTokenEnv → writes a $env: Authorization header (no secret on disk)', () => {
  const servers: McpServer[] = [
    { type: 'http', name: 'foo', url: 'http://localhost:1/mcp', headers: [{ name: 'X-Session', value: 'tok' }] }
  ]
  const { config } = translateMcpServers(servers, {
    auth: { foo: { bearerTokenEnv: 'FOO_TOKEN', headers: { 'X-Extra': 'e' } } }
  })
  const entry = config.mcpServers.foo as { url: string; headers: Record<string, string> }
  assert.equal(entry.headers['Authorization'], 'Bearer $env:FOO_TOKEN')
  assert.equal(entry.headers['X-Extra'], 'e')
  assert.equal(entry.headers['X-Session'], 'tok') // client header preserved
})

test('auth policy: preserved servers are surfaced in the notice', () => {
  const cwd = tmpCwd()
  try {
    const notice = buildMcpNotice(cwd, {
      handle: null,
      skipped: [],
      preserved: ['mcp-combiner']
    })
    assert.match(notice!, /deferred to your existing config/)
    assert.match(notice!, /mcp-combiner/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('loadMcpPolicy: parses generate/exclude/auth; missing file → {}', () => {
  const dir = tmpCwd()
  try {
    const p = join(dir, 'policy.json')
    writeFileSync(
      p,
      JSON.stringify({
        generate: ['keep'],
        exclude: ['mcp-combiner'],
        auth: { foo: { bearerTokenEnv: 'T', headers: { A: 'b' } } }
      })
    )
    const loaded = loadMcpPolicy(p)
    assert.deepEqual(loaded.generate, ['keep'])
    assert.deepEqual(loaded.exclude, ['mcp-combiner'])
    assert.equal(loaded.auth?.foo.bearerTokenEnv, 'T')
    assert.deepEqual(loaded.auth?.foo.headers, { A: 'b' })

    const star = join(dir, 'star.json')
    writeFileSync(star, JSON.stringify({ generate: '*' }))
    assert.equal(loadMcpPolicy(star).generate, '*')

    assert.deepEqual(loadMcpPolicy(join(dir, 'nope.json')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
