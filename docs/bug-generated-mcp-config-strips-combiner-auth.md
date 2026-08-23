# Bug: generated `.pi/mcp.json` silently disables bearer auth on an existing MCP server (→ 401)

**Status:** confirmed, root cause proven with a runtime trace.
**Component:** pi-acp `writeMcpConfig` / `translateMcpServers` (`src/**`, built into `dist/index.js`).
**Severity:** high — breaks a working, auth-protected MCP server for **all** pi sessions
launched from the affected cwd, including **non-ACP shell sessions**, and does so silently.

---

## Symptom

A user runs an MCP server (`mcp-combiner`) locally with **inbound bearer auth enabled**
(`MCP_COMBINER_AUTH_TOKEN`), wired through `pi-mcp-adapter` in the user's **global** config
`~/.config/mcp/mcp.json`:

```json
{ "mcpServers": { "mcp-combiner": {
  "url": "http://127.0.0.1:9741/mcp",
  "auth": "bearer",
  "bearerTokenEnv": "MCP_COMBINER_AUTH_TOKEN"
} } }
```

After using pi through an ACP client, the server starts returning **HTTP 401** on connect.
Agents narrate *"the mcp-combiner server isn't connected, let me connect to it…"* and MCP
tools are unusable. The failure then persists into **plain `pi` shell sessions that never
touched ACP.**

## What pi-acp generated

`~/.pi/mcp.json`:

```json
{
  "mcpServers": {
    "mcp-combiner": {
      "url": "http://127.0.0.1:9741/mcp/1a5ad7f1-22c8-4e2b-8737-63a79d824281",
      "headers": { "X-MCP-Combiner-Session": "1a5ad7f1-22c8-4e2b-8737-63a79d824281" }
    }
  },
  "_generatedBy": "pi-acp"
}
```

Note it carries **`url` + `headers` only** — no `auth`, no `bearerTokenEnv`. This is faithful
to what `translateMcpServers` can express (below); it is not a translation *mistake* so much
as a translation *gap* with a dangerous interaction downstream.

## Runtime proof

With `pi-mcp-adapter` tracing on, the combiner `initialize` fails **instantly** (not a
timeout — an auth reject):

```json
{"server":"mcp-combiner","transport":"streamable-http","kind":"request",
 "status":"error","method":"initialize","id":0,"durationMs":3.6}
```

(`~/.pi/mcp-traces/mcp-*.jsonl`)

---

## Root cause (the full chain)

### 1. pi-acp can only emit `url` + `headers` for an HTTP server

`translateMcpServers` (`dist/index.js` ~L1958-1969) maps an ACP HTTP MCP-server descriptor to:

```js
} else if (type === "http") {
  const entry = { url };
  const headers = toRecord(http.headers);
  if (Object.keys(headers).length) entry.headers = headers;
  mcpServers[name] = entry;
}
```

The ACP MCP-server shape has no `auth` / `bearerToken` / `bearerTokenEnv` concept, and the
ACP **client** did not place an `Authorization` header into `headers` (it sent only the
`X-MCP-Combiner-Session` grouping header). So the generated entry structurally cannot carry
the user's bearer wiring, **and it repoints the URL** to `/mcp/<session-token>`.

> **Upstream origin (since fixed):** the missing header traces to the nvim client's ACP spec
> builder — `mcp-companion`'s `lua/mcp_companion/cc/init.lua` `build_combiner_entry` — which
> emitted only `X-MCP-Combiner-Session`. It now adds a literal `Authorization: Bearer <token>`
> when `MCP_COMBINER_AUTH_TOKEN` is set. pi-acp still propagated whatever it was handed, so the
> hazards in steps 2-4 (persistent, highest-precedence file that overrides global auth) remain
> worth addressing defensively.

### 2. The generated file wins pi-mcp-adapter's config merge

`pi-mcp-adapter` discovers config from several sources and merges them **last-wins**
(`config.ts` `getConfigSources` → `loadMcpConfig`). The ordering is:

```
shared-global (~/.config/mcp/mcp.json)   ← the user's auth'd entry
agents-global (~/.agents/mcp.json …)
pi-global     (<agentDir>/mcp.json)
shared-project(<cwd>/.mcp.json)
pi-project    (<cwd>/.pi/mcp.json)        ← HIGHEST precedence
```

`getProjectPiConfigPath(cwd)` resolves to **`<cwd>/.pi/mcp.json`** using the literal default
config-dir name `.pi` (`getConfigDirName()`), independent of where pi's real config home is.
When a session's **cwd is `$HOME`**, that path is exactly `~/.pi/mcp.json` — so the generated
file becomes the **highest-precedence** source and overrides the user's global entry.

> This is why it affects non-ACP shell sessions: `~/.pi/mcp.json` is not tied to ACP. It is a
> normal project-pi override that **any** pi session launched from `$HOME` reads. The
> `_generatedBy: "pi-acp"` marker only gates whether pi-acp will *rewrite/clean* the file — it
> does nothing to stop pi-mcp-adapter from *reading* it.

### 3. The URL change triggers pi-mcp-adapter's (correct) credential-stripping

`mergeServerMaps` (`config.ts:481-534`) merges **per field**, and deliberately **binds auth
material to the URL that supplied it**. When a higher-precedence source repoints an existing
server at a *different* URL, it deletes the URL-bound fields from the inherited entry to avoid
shipping the original endpoint's credentials to a new URL:

```js
const URL_BOUND_AUTH_FIELDS =
  ["headers", "bearerToken", "bearerTokenEnv", "bearerTokenStore", "requestHeadersCommand"];
// … when definition.url !== existing.url: delete each URL_BOUND_AUTH_FIELD from baseEntry
```

So merging global (`/mcp`, with `bearerTokenEnv`) under the pi-acp override (`/mcp/<token>`)
produces:

| field           | source                    | in merged entry?                    |
|-----------------|---------------------------|-------------------------------------|
| `url`           | pi-acp                    | `…/mcp/<token>`                     |
| `headers`       | pi-acp                    | `{X-MCP-Combiner-Session: …}`       |
| `auth: "bearer"`| global (not URL-bound)    | **inherited — kept**                |
| `bearerTokenEnv`| global (URL-bound)        | **STRIPPED (url changed)**          |
| `trace: true`   | global (not URL-bound)    | **inherited — kept** (explains the traces) |

### 4. Connect: `auth:"bearer"` with no token → no header → 401

At connect (`server-manager.ts:862-874`):

```js
if (definition.auth === "bearer") {
  const token = … resolveBearerToken(definition) …;   // no bearerToken, no bearerTokenEnv → undefined
  if (token) headers["Authorization"] = `Bearer ${token}`;  // never runs
}
```

No `Authorization` header is sent. The combiner's stateless bearer check
(`hmac.compare_digest`, no `WWW-Authenticate`) returns a plain **401**. Because `auth:"bearer"`
survived, `supportsOAuth()` is false, so it's an honest 401 rather than an OAuth/DCR probe —
the adapter does not recover, and the failure is cached behind a 60s backoff, so retries within
the window just repeat *"not connected."*

**Net:** pi-acp's generated override, by repointing the URL and omitting the auth wiring, trips
pi-mcp-adapter's anti-credential-exfiltration stripping, which silently disables bearer auth on
a server the user had configured correctly — for every `$HOME`-cwd pi session, ACP or not.

---

## Scope / when it bites

- Requires the session **cwd == `$HOME`** (so `<cwd>/.pi/mcp.json` == `~/.pi/mcp.json`), OR any
  cwd where pi-acp wrote `.pi/mcp.json` and a later pi session runs from that same cwd.
- Requires the default config-dir name `.pi` (`getConfigDirName()`), which is the default.
  If a distribution renames the config dir, pi-acp's hard-coded `.pi` write and the adapter's
  `getConfigDirName()` read diverge and the file becomes inert (different failure, not this one).
- Requires the target server to have **auth that is URL-bound** (`bearerTokenEnv`/`headers`/…)
  and the generated override to **repoint the URL** — both true for the combiner grouping-token
  scheme.

## Why it's easy to miss

- Silent: no error at write time; the adapter's stripping is *by design*.
- Persistent: the file survives the ACP session and poisons unrelated shell sessions.
- Misattributed: surfaces first in a subagent's fresh connect, so it reads as a "subagents
  don't get MCP" problem when it is actually a global config-precedence + auth-stripping problem.

---

## Fix options (in pi-acp)

Ordered by preference:

1. **Carry the auth through as a header (the real root — fixed client-side).** The ACP client
   owns the combiner and its bearer; it must pass the credential in the HTTP server's `headers`,
   and pi-acp writes those verbatim. The upstream omission was located: the nvim client's ACP
   spec builder — `mcp-companion`'s `lua/mcp_companion/cc/init.lua` `build_combiner_entry`
   (the source of `codecompanion.mcp.transform_to_acp`) — set only `X-MCP-Combiner-Session` and
   no `Authorization`, even though the nvim host's *direct* combiner client already presents the
   bearer (`lua/mcp_companion/combiner/client.lua:311-313`). **Fixed** by adding a literal
   `{ name = "Authorization", value = "Bearer " .. MCP_COMBINER_AUTH_TOKEN }` to the HTTP
   entry's headers when `MCP_COMBINER_AUTH_TOKEN` is set (else no header — the combiner is open).
   Being the override's *own* header, it survives pi-mcp-adapter's URL-bound stripping and
   reaches the combiner.
   - *Disk-safe variant (not used):* `pi-mcp-adapter` interpolates `$env:` inside header values
     at connect (`utils.ts:74` `interpolateEnvVars` supports `${VAR}`, `$env:VAR`, `{env:VAR}`),
     so `"Bearer $env:MCP_COMBINER_AUTH_TOKEN"` would keep the token off disk — but it is
     pi-specific (other ACP agents forward the literal string), so the client sends the literal
     bearer for cross-agent correctness. The token therefore lands in the generated
     `~/.pi/mcp.json`, which makes fixes (3)/(4) below (don't persist a high-precedence file;
     guarantee cleanup) more important, not less.

2. **Don't clobber a server the user already configured.** Before writing an entry for `name`,
   check whether the same server is already defined in a lower-precedence source
   (`~/.config/mcp/mcp.json`, agent-dir, etc.). If so, either (a) skip generating it (let the
   user's config stand) or (b) merge and **preserve** its `auth`/`bearerTokenEnv`. pi-acp already
   has a "preserve existing" path (`preservedExisting`) for a non-generated `.pi/mcp.json`;
   extend that idea to a cross-source name check.

3. **Stop writing to a persistent, high-precedence, shared path.** Writing
   `<cwd>/.pi/mcp.json` — which doubles as pi-mcp-adapter's **highest-precedence** project
   override, and equals `~/.pi/mcp.json` when cwd is `$HOME` — is the structural hazard.
   Options: refuse to write when `cwd === homedir()`; write to a session-scoped/temp path passed
   to pi via an explicit override; or gate the whole thing behind an opt-in.

4. **Guarantee cleanup.** `writeMcpConfig` returns a `cleanup()` that `rmSync`s the file if it's
   still `_generatedBy: pi-acp` (`dist/index.js` ~L2000). Confirm it runs on **every** session
   end including crashes/SIGKILL of the ACP process; a leaked file is exactly what poisons later
   shell sessions. Consider also skipping the write entirely if `pi-mcp-adapter` isn't installed
   (the code already computes `piMcpAdapterInstalled`).

**Recommended:** (1) as the real fix (auth flows as a `$env:`-interpolated header, no secret on
disk, survives stripping), plus (3)/(4) to remove the persistence/precedence hazard so a stale
generated file can never silently override a user's global auth config again.

## Immediate workaround for a user hitting this

Delete `~/.pi/mcp.json` (or the offending `<cwd>/.pi/mcp.json`). Since it's `_generatedBy:
pi-acp`, hand-edits won't survive regeneration — the durable fix is above.

---

## References (pinned to installed versions at time of writing)

- pi-acp: `dist/index.js` `translateMcpServers` (~L1958-1974), `writeMcpConfig` (~L1986-2007),
  callers (~L2173, ~L2254).
- pi-mcp-adapter: `config.ts` `getConfigSources` (L394-460), `loadMcpConfig` (L294-315),
  `mergeServerMaps` + `URL_BOUND_AUTH_FIELDS` (L479-534); `server-manager.ts` connect/header
  (L855-885); `utils.ts` `resolveBearerToken` (L198-203), `interpolateEnvVars` (L74-79).
- combiner inbound auth: `inbound_auth.py` `BearerAuthMiddleware.dispatch` (stateless
  `hmac.compare_digest`, plain 401, no `WWW-Authenticate`).
