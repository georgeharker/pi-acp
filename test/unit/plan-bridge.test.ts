import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_CUSTOM_TYPE,
  parsePlanEntry,
  applyPlanEntry,
  newPlanState,
  toPlanEntries
} from '../../src/acp/plan-bridge.js'

test('PLAN_CUSTOM_TYPE is the agreed custom entry type', () => {
  assert.equal(PLAN_CUSTOM_TYPE, 'acp:plan')
})

test('parsePlanEntry: snapshot with rich + simple items', () => {
  const op = parsePlanEntry({
    op: 'snapshot',
    ns: 'cribsheet',
    seq: 1,
    items: [
      { id: 'plan:a', title: 'A', status: 'todo', kind: 'plan', deps: ['plan:b'] },
      { id: 'x', title: 'X' }
    ]
  })
  assert.deepEqual(op, {
    op: 'snapshot',
    ns: 'cribsheet',
    seq: 1,
    items: [
      { id: 'plan:a', title: 'A', status: 'todo', kind: 'plan', deps: ['plan:b'], tainted: undefined },
      { id: 'x', title: 'X', status: undefined, deps: undefined, kind: undefined, tainted: undefined }
    ]
  })
})

test('parsePlanEntry: tolerates `name` when `title` is absent', () => {
  const op = parsePlanEntry({ op: 'snapshot', ns: 'c', items: [{ id: 'a', name: 'Legacy' }] })
  assert.equal(op?.op === 'snapshot' && op.items[0].title, 'Legacy')
})

test('parsePlanEntry: item without id is dropped', () => {
  const op = parsePlanEntry({ op: 'snapshot', ns: 'c', items: [{ title: 'no id' }, { id: 'ok', title: 'ok' }] })
  assert.equal(op?.op === 'snapshot' && op.items.length, 1)
})

test('parsePlanEntry: update + clear + unusable', () => {
  assert.deepEqual(parsePlanEntry({ op: 'update', ns: 'c', upsert: [{ id: 'a', title: 'A' }], remove: ['b'] }), {
    op: 'update',
    ns: 'c',
    seq: undefined,
    upsert: [{ id: 'a', title: 'A', status: undefined, deps: undefined, kind: undefined, tainted: undefined }],
    remove: ['b']
  })
  assert.deepEqual(parsePlanEntry({ op: 'clear' }), { op: 'clear' })
  assert.equal(parsePlanEntry({ op: 'bogus' }), null)
  assert.equal(parsePlanEntry(null), null)
})

test('parsePlanEntry: missing ns defaults to "default"', () => {
  const op = parsePlanEntry({ op: 'snapshot', items: [] })
  assert.equal(op?.op === 'snapshot' && op.ns, 'default')
})

test('applyPlanEntry: snapshot replaces the ns set', () => {
  const s = newPlanState()
  applyPlanEntry(s, {
    op: 'snapshot',
    ns: 'c',
    items: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ]
  })
  const changed = applyPlanEntry(s, { op: 'snapshot', ns: 'c', items: [{ id: 'b', title: 'B2' }] })
  assert.equal(changed, true)
  assert.deepEqual(
    toPlanEntries(s).map(e => e.content),
    ['B2']
  )
})

test('applyPlanEntry: update upserts and removes by id', () => {
  const s = newPlanState()
  applyPlanEntry(s, {
    op: 'snapshot',
    ns: 'c',
    items: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ]
  })
  applyPlanEntry(s, {
    op: 'update',
    ns: 'c',
    upsert: [
      { id: 'a', title: 'A2' },
      { id: 'z', title: 'Z' }
    ],
    remove: ['b']
  })
  assert.deepEqual(
    toPlanEntries(s)
      .map(e => e.content)
      .sort(),
    ['A2', 'Z']
  )
})

test('applyPlanEntry: out-of-order seq is dropped', () => {
  const s = newPlanState()
  applyPlanEntry(s, { op: 'snapshot', ns: 'c', seq: 5, items: [{ id: 'a', title: 'A' }] })
  const stale = applyPlanEntry(s, { op: 'snapshot', ns: 'c', seq: 4, items: [{ id: 'b', title: 'B' }] })
  assert.equal(stale, false)
  assert.deepEqual(
    toPlanEntries(s).map(e => e.content),
    ['A']
  )
})

test('applyPlanEntry: clear wipes all namespaces', () => {
  const s = newPlanState()
  applyPlanEntry(s, { op: 'snapshot', ns: 'c', items: [{ id: 'a', title: 'A' }] })
  assert.equal(applyPlanEntry(s, { op: 'clear' }), true)
  assert.deepEqual(toPlanEntries(s), [])
  assert.equal(applyPlanEntry(s, { op: 'clear' }), false)
})

test('toPlanEntries: status + kind + tainted rendering', () => {
  const s = newPlanState()
  applyPlanEntry(s, {
    op: 'snapshot',
    ns: 'c',
    items: [
      { id: '1', title: 'done one', status: 'done' },
      { id: '2', title: 'active one', status: 'in-progress' },
      { id: '3', title: 'todo one', status: 'todo' },
      { id: '4', title: 'a design', kind: 'design', tainted: true },
      { id: '5', title: 'a note', kind: 'note' }
    ]
  })
  const meta = { piAcp: { section: 'plan' } }
  assert.deepEqual(toPlanEntries(s), [
    { content: 'done one', priority: 'medium', status: 'completed', _meta: meta },
    { content: 'active one', priority: 'medium', status: 'in_progress', _meta: meta },
    { content: 'todo one', priority: 'medium', status: 'pending', _meta: meta },
    { content: '(design) a design (tainted)', priority: 'medium', status: 'pending', _meta: meta },
    { content: '(note) a note', priority: 'medium', status: 'pending', _meta: meta }
  ])
})
