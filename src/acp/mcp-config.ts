import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { getAgentDir } from './pi-settings.js'
import { getPiAcpMcpPolicyPath } from './paths.js'

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
  /** Names skipped because a policy said to defer to the user's own (lower-precedence) config. */
  preserved: string[]
}

/**
 * Policy consulted when generating `.pi/mcp.json`, loaded from
 * `<pi-acp dataDir>/mcp-policy.json` (default `~/.pi/pi-acp/mcp-policy.json`).
 *
 * Why: the ACP `McpServer` shape can't express bearer auth, and pi-acp writing a server (repointing
 * its URL) trips pi-mcp-adapter's URL-bound credential stripping → 401 on an otherwise-configured
 * server; the generated `<cwd>/.pi/mcp.json` also outranks the user's global config. So the operator
 * controls which servers pi-acp may generate — **same semantics pi-subagents uses for tool/extension
 * inheritance** (`true | string[] | false` + an exclude denylist):
 *
 *  - `generate`: which servers pi-acp may write. `true`/`"*"`/omitted = all (default, current
 *    behavior), `string[]` = only those names, `false` = none. Servers NOT generated are
 *    **preserved** — pi-acp leaves the user's own (lower-precedence) `mcp.json` entry and its auth
 *    in place. (Names are case-insensitive.)
 *  - `exclude`: denylist applied after `generate` (exclude wins) — e.g. a globally-configured,
 *    bearer-auth'd server you never want pi-acp to override.
 *  - `auth`: for a server pi-acp DOES generate, write `Authorization: Bearer $env:<VAR>` (+ extra
 *    headers). pi-mcp-adapter interpolates `$env:` at connect, so the token is never on disk and,
 *    being the entry's own header, survives the URL-bound stripping.
 *
 * Shape: `{ "generate": true | "*" | ["a","b"] | false, "exclude": ["x"],
 *          "auth": { "<name>": { "bearerTokenEnv": "VAR", "headers": {…} } } }`
 */
export type McpServerAuth = { bearerTokenEnv?: string; headers?: Record<string, string> }
export type McpPolicy = {
  generate?: boolean | '*' | string[]
  exclude?: string[]
  auth?: Record<string, McpServerAuth>
}

type NameValue = { name: string; value: string }

/** Load the MCP generation policy. Missing/invalid file → `{}` (default: generate all). */
export function loadMcpPolicy(path: string = getPiAcpMcpPolicyPath()): McpPolicy {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object') return {}
    const obj = raw as { generate?: unknown; exclude?: unknown; auth?: unknown }
    const out: McpPolicy = {}

    if (typeof obj.generate === 'boolean' || obj.generate === '*') out.generate = obj.generate
    else if (Array.isArray(obj.generate)) out.generate = obj.generate.filter((x): x is string => typeof x === 'string')

    if (Array.isArray(obj.exclude)) out.exclude = obj.exclude.filter((x): x is string => typeof x === 'string')

    if (obj.auth && typeof obj.auth === 'object') {
      const auth: Record<string, McpServerAuth> = {}
      for (const [name, val] of Object.entries(obj.auth as Record<string, unknown>)) {
        if (!val || typeof val !== 'object') continue
        const v = val as { bearerTokenEnv?: unknown; headers?: unknown }
        const entry: McpServerAuth = {}
        if (typeof v.bearerTokenEnv === 'string' && v.bearerTokenEnv) entry.bearerTokenEnv = v.bearerTokenEnv
        if (v.headers && typeof v.headers === 'object') {
          const headers: Record<string, string> = {}
          for (const [k, hv] of Object.entries(v.headers as Record<string, unknown>)) headers[k] = String(hv)
          if (Object.keys(headers).length) entry.headers = headers
        }
        auth[name] = entry
      }
      out.auth = auth
    }

    return out
  } catch {
    return {}
  }
}

/** Whether pi-acp may generate an entry for `name` (exclude wins over generate). Default: yes. */
function shouldGenerate(name: string, policy: McpPolicy): boolean {
  const lc = name.toLowerCase()
  if ((policy.exclude ?? []).some(n => n.toLowerCase() === lc)) return false
  const gen = policy.generate
  if (gen === false) return false
  if (gen === undefined || gen === true || gen === '*') return true
  return gen.some(n => n.toLowerCase() === lc)
}

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
export function translateMcpServers(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = {}
): McpTranslation {
  const mcpServers: Record<string, PiMcpEntry> = {}
  const skipped: string[] = []
  const preserved: string[] = []

  for (const server of servers ?? []) {
    const name = String(server.name ?? '').trim()
    if (!name) continue

    if (!shouldGenerate(name, policy)) {
      // Not in the generate allowlist (or excluded) — leave the user's existing mcp.json entry
      // (and its auth) in place rather than overriding it.
      preserved.push(name)
      continue
    }

    const rule = policy.auth?.[name]
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
      // Client-sent headers, then policy headers, then a policy bearer — policy wins. The bearer is
      // written as `$env:VAR` so pi-mcp-adapter resolves it at connect (never stored on disk) and it
      // survives URL-bound stripping (it's this entry's own header, not inherited).
      const headers: Record<string, string> = { ...toRecord(http.headers), ...(rule?.headers ?? {}) }
      if (rule?.bearerTokenEnv) headers['Authorization'] = `Bearer $env:${rule.bearerTokenEnv}`
      if (Object.keys(headers).length) entry.headers = headers
      mcpServers[name] = entry
    } else {
      // sse / acp: not expressible in pi-mcp-adapter's config shape.
      skipped.push(name)
    }
  }

  return { config: { mcpServers, _generatedBy: GENERATED_MARKER }, skipped, preserved }
}

export type McpConfigHandle = {
  path: string
  /** Remove the generated file. No-op if the file was replaced by a non-generated one. */
  cleanup: () => void
}

export type WriteMcpConfigResult = {
  handle: McpConfigHandle | null
  skipped: string[]
  /** Server names not generated because the policy said to defer to the user's own config. */
  preserved: string[]
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
 * Write the ACP-provided MCP servers to a **session-scoped temp file** for pi-mcp-adapter, passed to
 * pi via `--mode rpc --mcp-config <path>` (see PiRpcProcess.spawn). This deliberately does NOT write
 * `<cwd>/.pi/mcp.json`: that path is pi's own highest-precedence *project config namespace*
 * (settings, prompts, trust, mcp), so writing there overrode the user's global config, persisted
 * past the session, and poisoned unrelated (even non-ACP) pi sessions launched from the same cwd.
 * `--mcp-config` overrides only pi-mcp-adapter's pi-global source, never pi's config dir; the temp
 * file is removed on session end (and a leaked one only shadows the rarely-used `<agentDir>/mcp.json`).
 * Returns `handle: null` when there is nothing to write.
 */
export function writeMcpConfig(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = loadMcpPolicy()
): WriteMcpConfigResult {
  const { config, skipped, preserved } = translateMcpServers(servers, policy)

  if (Object.keys(config.mcpServers).length === 0) {
    return { handle: null, skipped, preserved }
  }

  // The file may contain secrets the client sent literally (an Authorization header value, or stdio
  // `env` values like API keys). `mkdtempSync` gives a 0700 (owner-only) parent dir; write the file
  // 0600 too as defense-in-depth. The durable way to keep a bearer OFF disk is the policy's
  // `bearerTokenEnv`, which writes `Bearer $env:VAR` (interpolated by pi-mcp-adapter at connect).
  let dir: string
  let path: string
  try {
    dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
    path = join(dir, 'mcp.json')
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  } catch {
    return { handle: null, skipped, preserved }
  }

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort; the file lives in the OS temp dir
    }
  }

  return { handle: { path, cleanup }, skipped, preserved }
}

/**
 * Best-effort removal of a stale `<cwd>/.pi/mcp.json` that a PREVIOUS pi-acp version generated
 * (marked `_generatedBy: pi-acp`). Older builds wrote into pi's project config namespace; a leftover
 * one still wins at highest precedence and would re-introduce the override/persistence hazard. Only
 * ever removes a file pi-acp authored — never a hand-written config.
 */
export function cleanupStaleGeneratedConfig(cwd: string): void {
  const path = join(cwd, '.pi', 'mcp.json')
  try {
    if (existsSync(path) && isGeneratedConfig(path)) rmSync(path, { force: true })
  } catch {
    // best effort
  }
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
  result: Pick<WriteMcpConfigResult, 'handle' | 'skipped' | 'preserved'>
): string | null {
  const lines: string[] = []

  if (result.handle && !piMcpAdapterInstalled(cwd)) {
    lines.push(
      'MCP servers were provided, but `pi-mcp-adapter` does not appear to be installed. ' +
        'Add it to your pi settings `packages` (see https://github.com/nicobailon/pi-mcp-adapter) for the servers to load.'
    )
  }

  if (result.preserved?.length) {
    lines.push(`MCP servers deferred to your existing config (auth policy): ${result.preserved.join(', ')}.`)
  }

  if (result.skipped.length) {
    lines.push(`Skipped MCP servers not expressible for pi (sse/acp): ${result.skipped.join(', ')}.`)
  }

  return lines.length ? lines.join('\n') : null
}
