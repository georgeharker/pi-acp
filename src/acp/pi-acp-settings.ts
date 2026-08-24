import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from './pi-settings.js'

/**
 * pi-acp's own settings — deliberately NOT merged into pi's `settings.json`. The file lives in the
 * pi agent's `extensions/` dir (see {@link getPiAcpSettingsPath}) alongside other extensions'
 * settings, so it travels with a relocated pi config dir (`PI_CODING_AGENT_DIR`), but its schema
 * and precedence are owned entirely by pi-acp. The pre-0.2.2 location (agent root) is still read as
 * a fallback (see {@link getLegacyPiAcpSettingsPath}).
 *
 * This is the single source of configuration for the adapter: there are no environment-variable
 * overrides. Optional keys (`piCommand`, `dataDir`) fall back to a built-in default when absent.
 */
type PiAcpSettings = {
  /** Advertise ACP `promptCapabilities.embeddedContext` to the client. Default: on. */
  embeddedContext: boolean
  /** Per-request pi RPC timeout in milliseconds. */
  rpcTimeoutMs: number
  /** Emit adapter debug logging to stderr. */
  debug: boolean
  /** Override the pi executable. Absent = platform default (`pi`, or `pi.cmd` on Windows). */
  piCommand?: string
  /** Override pi-acp's data directory. Absent = `~/.pi/pi-acp`. */
  dataDir?: string
}

/** Defaults, also the exact object written by {@link ensurePiAcpSettingsFile}. */
const DEFAULT_PI_ACP_SETTINGS: PiAcpSettings = {
  embeddedContext: true,
  rpcTimeoutMs: 120_000,
  debug: false
}

/** pi-acp's own settings file, in pi's `extensions/` dir so it follows a relocated config dir. */
function getPiAcpSettingsPath(): string {
  return join(getAgentDir(), 'extensions', 'pi-acp.json')
}

/** Pre-0.2.2 location (agent root), still read when the current path is absent. */
function getLegacyPiAcpSettingsPath(): string {
  return join(getAgentDir(), 'pi-acp.json')
}

/** Prefer the current path; fall back to the legacy one when only it exists. */
function resolvePiAcpSettingsReadPath(): string {
  const current = getPiAcpSettingsPath()
  if (existsSync(current)) return current
  const legacy = getLegacyPiAcpSettingsPath()
  if (existsSync(legacy)) return legacy
  return current
}

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

/** Read pi-acp settings, falling back to defaults for a missing/invalid file or absent keys. */
function readPiAcpSettings(path: string = resolvePiAcpSettingsReadPath()): PiAcpSettings {
  try {
    if (!existsSync(path)) return { ...DEFAULT_PI_ACP_SETTINGS }
    const data: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isObject(data)) return { ...DEFAULT_PI_ACP_SETTINGS }

    const out: PiAcpSettings = {
      embeddedContext:
        typeof data.embeddedContext === 'boolean' ? data.embeddedContext : DEFAULT_PI_ACP_SETTINGS.embeddedContext,
      rpcTimeoutMs:
        typeof data.rpcTimeoutMs === 'number' && Number.isFinite(data.rpcTimeoutMs) && data.rpcTimeoutMs > 0
          ? data.rpcTimeoutMs
          : DEFAULT_PI_ACP_SETTINGS.rpcTimeoutMs,
      debug: typeof data.debug === 'boolean' ? data.debug : DEFAULT_PI_ACP_SETTINGS.debug
    }
    if (typeof data.piCommand === 'string' && data.piCommand.trim()) out.piCommand = data.piCommand
    if (typeof data.dataDir === 'string' && data.dataDir.trim()) out.dataDir = data.dataDir
    return out
  } catch {
    return { ...DEFAULT_PI_ACP_SETTINGS }
  }
}

export function getEmbeddedContext(): boolean {
  return readPiAcpSettings().embeddedContext
}

export function getRpcTimeoutMs(): number {
  return readPiAcpSettings().rpcTimeoutMs
}

export function getPiAcpDebug(): boolean {
  return readPiAcpSettings().debug
}

export function getPiCommandOverride(): string | undefined {
  return readPiAcpSettings().piCommand
}

export function getPiAcpDataDir(): string | undefined {
  return readPiAcpSettings().dataDir
}

/**
 * Write the default settings file if it does not exist, giving the user a discoverable file to edit.
 * Never overwrites an existing file. Best-effort: failures are ignored (in-memory defaults still apply).
 */
export function ensurePiAcpSettingsFile(path: string = getPiAcpSettingsPath()): void {
  try {
    if (existsSync(path)) return
    if (existsSync(getLegacyPiAcpSettingsPath())) return
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(DEFAULT_PI_ACP_SETTINGS, null, 2) + '\n', { encoding: 'utf-8' })
  } catch {
    // best effort; the in-memory defaults still apply
  }
}
