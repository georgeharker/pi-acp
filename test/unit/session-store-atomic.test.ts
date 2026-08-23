import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../src/acp/session-store.js'

test('SessionStore: round-trips entries and leaves no temp files (atomic write)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-store-'))
  const path = join(dir, 'session-map.json')
  try {
    const store = new SessionStore(path)
    store.upsert({ sessionId: 'a', cwd: '/x', sessionFile: '/x/a.jsonl' })
    store.upsert({ sessionId: 'b', cwd: '/y', sessionFile: '/y/b.jsonl' })

    assert.equal(store.get('a')?.sessionFile, '/x/a.jsonl')
    assert.equal(store.get('b')?.cwd, '/y')

    // No leftover *.tmp files from the temp-file+rename write path.
    const leftovers = readdirSync(dir).filter(f => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionStore: a corrupt map file is treated as empty, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-store-'))
  const path = join(dir, 'session-map.json')
  try {
    writeFileSync(path, '{ this is not valid json', 'utf-8')
    const store = new SessionStore(path)
    assert.equal(store.get('anything'), null)
    // A subsequent write recovers the file to a valid state.
    store.upsert({ sessionId: 'a', cwd: '/x', sessionFile: '/x/a.jsonl' })
    assert.equal(new SessionStore(path).get('a')?.sessionFile, '/x/a.jsonl')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
