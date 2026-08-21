import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { getAgentDir } from './pi-settings.js'

// Marker written into generated configs so we only ever overwrite / clean up files
// that pi-acp authored, never a hand-written `.pi/mcp.json`.
const GENERATED_MARKER = 'pi-acp'

type PiMcpStdioEntry = { command: string; args?: string[]; env?: Record<string, string> }
type PiMcpHttpEntry = { url: string; headers?: Record<string, string> }
type PiMcpEntry = PiMcpStdioEntry | PiMcpHttpEntry

export type PiMcpConfig = {
  mcpServers: Record<string, PiMcpEntry>
  _generatedBy?: string
}

export type McpTranslation = {
  config: PiMcpConfig
  /** Names of servers we could not express in pi-mcp-adapter's schema (sse / acp). */
  skipped: string[]
}

type NameValue = { name: string; value: string }

function toRecord(pairs: readonly NameValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    if (p && typeof p.name === 'string') out[p.name] = String(p.value ?? '')
  }
  return out
}

/**
 * Translate ACP `McpServer[]` into the `mcpServers` map read by pi-mcp-adapter
 * (https://github.com/nicobailon/pi-mcp-adapter). stdio and http servers translate
 * cleanly; sse / acp variants are not expressible and are reported as `skipped`.
 */
export function translateMcpServers(servers: readonly McpServer[] | undefined | null): McpTranslation {
  const mcpServers: Record<string, PiMcpEntry> = {}
  const skipped: string[] = []

  for (const server of servers ?? []) {
    const name = String(server.name ?? '').trim()
    if (!name) continue

    const type = (server as { type?: string }).type

    if (!type || type === 'stdio') {
      const stdio = server as { command?: string; args?: string[]; env?: NameValue[] }
      const command = String(stdio.command ?? '').trim()
      if (!command) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpStdioEntry = {
        command,
        args: Array.isArray(stdio.args) ? stdio.args.map(String) : []
      }
      const env = toRecord(stdio.env)
      if (Object.keys(env).length) entry.env = env
      mcpServers[name] = entry
    } else if (type === 'http') {
      const http = server as { url?: string; headers?: NameValue[] }
      const url = String(http.url ?? '').trim()
      if (!url) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpHttpEntry = { url }
      const headers = toRecord(http.headers)
      if (Object.keys(headers).length) entry.headers = headers
      mcpServers[name] = entry
    } else {
      // sse / acp: not expressible in pi-mcp-adapter's config shape.
      skipped.push(name)
    }
  }

  return { config: { mcpServers, _generatedBy: GENERATED_MARKER }, skipped }
}

export type McpConfigHandle = {
  path: string
  /** Remove the generated file. No-op if the file was replaced by a non-generated one. */
  cleanup: () => void
}

export type WriteMcpConfigResult = {
  handle: McpConfigHandle | null
  skipped: string[]
  /** True when a hand-authored `.pi/mcp.json` already existed and we left it untouched. */
  preservedExisting: boolean
}

function isGeneratedConfig(path: string): boolean {
  try {
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as { _generatedBy?: unknown }
    return existing?._generatedBy === GENERATED_MARKER
  } catch {
    return false
  }
}

/**
 * Write a `<cwd>/.pi/mcp.json` from the ACP-provided MCP servers so pi-mcp-adapter
 * picks them up. Returns `handle: null` when there is nothing to write or when a
 * hand-authored config is present (which we never clobber).
 */
export function writeMcpConfig(cwd: string, servers: readonly McpServer[] | undefined | null): WriteMcpConfigResult {
  const { config, skipped } = translateMcpServers(servers)

  if (Object.keys(config.mcpServers).length === 0) {
    return { handle: null, skipped, preservedExisting: false }
  }

  const dir = join(cwd, '.pi')
  const path = join(dir, 'mcp.json')

  if (existsSync(path) && !isGeneratedConfig(path)) {
    // Respect a config the user (or another tool) wrote.
    return { handle: null, skipped, preservedExisting: true }
  }

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  } catch {
    return { handle: null, skipped, preservedExisting: false }
  }

  const cleanup = () => {
    try {
      if (existsSync(path) && isGeneratedConfig(path)) rmSync(path, { force: true })
    } catch {
      // best effort
    }
  }

  return { handle: { path, cleanup }, skipped, preservedExisting: false }
}

/** Best-effort check of pi settings for a `pi-mcp-adapter` package entry. */
export function piMcpAdapterInstalled(cwd: string): boolean {
  const settingsPaths = [join(getAgentDir(), 'settings.json'), join(cwd, '.pi', 'settings.json')]
  for (const p of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(p, 'utf-8')) as { packages?: unknown }
      const pkgs = Array.isArray(settings.packages) ? settings.packages : []
      if (pkgs.some(pkg => typeof pkg === 'string' && pkg.includes('pi-mcp-adapter'))) return true
    } catch {
      // ignore missing / invalid settings
    }
  }
  return false
}

/**
 * Build a one-time, human-readable notice about MCP wiring: which servers we could
 * not translate, and whether pi-mcp-adapter appears to be installed. Returns null
 * when there is nothing worth telling the user.
 */
export function buildMcpNotice(
  cwd: string,
  result: Pick<WriteMcpConfigResult, 'handle' | 'skipped' | 'preservedExisting'>
): string | null {
  const lines: string[] = []

  if (result.handle && !piMcpAdapterInstalled(cwd)) {
    lines.push(
      'MCP servers were provided, but `pi-mcp-adapter` does not appear to be installed. ' +
        'Add it to your pi settings `packages` (see https://github.com/nicobailon/pi-mcp-adapter) for the servers to load.'
    )
  }

  if (result.preservedExisting) {
    lines.push('An existing `.pi/mcp.json` was left untouched; MCP servers from the client were not written.')
  }

  if (result.skipped.length) {
    lines.push(`Skipped MCP servers not expressible for pi (sse/acp): ${result.skipped.join(', ')}.`)
  }

  return lines.length ? lines.join('\n') : null
}
