import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getPiAcpDataDir } from './pi-acp-settings.js'

/**
 * Storage owned by the ACP adapter.
 *
 * Set `dataDir` in pi-acp.json to override the default location (defaults to ~/.pi/pi-acp).
 * This is separate from pi's own ~/.pi/agent/* directory, which is controlled
 * via PI_CODING_AGENT_DIR.
 */
export function getPiAcpDir(): string {
  const configured = getPiAcpDataDir()
  return configured ? resolve(configured) : join(homedir(), '.pi', 'pi-acp')
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}

/**
 * Per-server MCP auth policy consulted when generating `.pi/mcp.json`
 * (see src/acp/mcp-config.ts). Defaults to `<pi-acp dataDir>/mcp-policy.json`.
 */
export function getPiAcpMcpPolicyPath(): string {
  return join(getPiAcpDir(), 'mcp-policy.json')
}
