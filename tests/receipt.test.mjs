/**
 * Unit tests for the pure receipt fold (compiled `lib/receipt.js`).
 *
 * These exercise the fold's determinism, the fail-closed verdict, the
 * "survives the next turn/start" guarantee that is the whole point of the
 * projection, the per-turn accumulator reset, goal carry-forward, the
 * MAX_RECEIPTS cap, and the reference-stability contract the live drive relies
 * on. No harness, no network — just plain event records in, state out.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initReceiptState,
  foldEvent,
  countTodos,
  computeVerdict,
  MAX_RECEIPTS,
} from '../lib/receipt.js'

/** A todo item of the given status (content text is irrelevant to the fold). */
const item = status => ({ content: 'x', status })
/** A `todo/write` event carrying the given item statuses. */
const todoWrite = (...statuses) => ({ type: 'todo/write', data: { todos: statuses.map(item) } })
/** A `turn/start` event. */
const turnStart = turn => ({ type: 'turn/start', data: { turn } })
/** A `turn/end` event with the given reason kind. */
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
/** Fold a sequence of events from the initial state. */
const run = events => events.reduce(foldEvent, initReceiptState())

test('all todos completed -> pass', () => {
  const state = run([turnStart(1), todoWrite('completed', 'completed', 'completed'), turnEnd(1)])
  assert.equal(state.receipts.length, 1)
  const r = state.receipts[0]
  assert.deepEqual(r.todos, { total: 3, completed: 3, inProgress: 0, pending: 0 })
  assert.equal(r.verdict.planComplete, 'pass')
  assert.equal(r.turn, 1)
  assert.equal(r.endReason, 'completed')
})

test('one todo incomplete -> fail', () => {
  const state = run([turnStart(1), todoWrite('completed', 'in_progress', 'pending'), turnEnd(1)])
  const r = state.receipts[0]
  assert.deepEqual(r.todos, { total: 3, completed: 1, inProgress: 1, pending: 1 })
  assert.equal(r.verdict.planComplete, 'fail')
})

test('no todo written in the turn -> inconclusive, todos null', () => {
  const state = run([turnStart(1), turnEnd(1)])
  const r = state.receipts[0]
  assert.equal(r.todos, null)
  assert.equal(r.verdict.planComplete, 'inconclusive')
})

test("a prior turn's receipt survives the next turn/start", () => {
  // The core guarantee: an external verifier reading between turns still sees
  // turn 1's terminal receipt, unlike the stock `todos` projection (null here).
  const afterEnd = run([turnStart(1), todoWrite('completed'), turnEnd(1)])
  const afterNextStart = foldEvent(afterEnd, turnStart(2))
  assert.equal(afterNextStart.receipts.length, 1)
  assert.deepEqual(afterNextStart.receipts[0].todos, { total: 1, completed: 1, inProgress: 0, pending: 0 })
  assert.equal(afterNextStart.receipts[0].verdict.planComplete, 'pass')
  // And the per-turn accumulator was reset for the new turn.
  assert.equal(afterNextStart.turnTodos, null)
})

test('multi-turn: receipts accumulate oldest-first, each judged independently', () => {
  const state = run([
    turnStart(1), todoWrite('completed', 'completed'), turnEnd(1),
    turnStart(2), todoWrite('completed', 'pending'), turnEnd(2),
    turnStart(3), turnEnd(3, 'aborted'),
  ])
  assert.equal(state.receipts.length, 3)
  assert.deepEqual(state.receipts.map(r => r.verdict.planComplete), ['pass', 'fail', 'inconclusive'])
  assert.deepEqual(state.receipts.map(r => r.turn), [1, 2, 3])
  assert.equal(state.receipts[2].endReason, 'aborted')
})

test('malformed todo payloads -> inconclusive (fail-closed)', () => {
  for (const bad of [
    { type: 'todo/write', data: null },
    { type: 'todo/write', data: {} },
    { type: 'todo/write', data: { todos: 'nope' } },
    { type: 'todo/write', data: { todos: [null] } },
    { type: 'todo/write', data: { todos: [{ status: 'bogus' }] } },
    { type: 'todo/write', data: { todos: [42] } },
  ]) {
    const state = run([turnStart(1), bad, turnEnd(1)])
    assert.equal(state.receipts[0].todos, null, JSON.stringify(bad))
    assert.equal(state.receipts[0].verdict.planComplete, 'inconclusive', JSON.stringify(bad))
  }
})

test('latest todo/write of a turn wins (whole-list replacement)', () => {
  const state = run([
    turnStart(1),
    todoWrite('pending', 'pending'),
    todoWrite('completed'),
    turnEnd(1),
  ])
  assert.deepEqual(state.receipts[0].todos, { total: 1, completed: 1, inProgress: 0, pending: 0 })
  assert.equal(state.receipts[0].verdict.planComplete, 'pass')
})

test('empty todo list -> inconclusive, not pass', () => {
  const state = run([turnStart(1), { type: 'todo/write', data: { todos: [] } }, turnEnd(1)])
  assert.deepEqual(state.receipts[0].todos, { total: 0, completed: 0, inProgress: 0, pending: 0 })
  assert.equal(state.receipts[0].verdict.planComplete, 'inconclusive')
})

test('goal/change carries forward across turns; clear nulls it', () => {
  const created = { type: 'goal/change', data: { operation: 'create', goal: { id: 'g1', phase: 'active', revision: 1 } } }
  const state = run([
    created,
    turnStart(1), todoWrite('completed'), turnEnd(1),
    turnStart(2), todoWrite('completed'), turnEnd(2),
  ])
  assert.deepEqual(state.receipts[0].goal, { id: 'g1', phase: 'active', revision: 1 })
  // Goal persists onto turn 2's receipt without being re-emitted.
  assert.deepEqual(state.receipts[1].goal, { id: 'g1', phase: 'active', revision: 1 })

  const cleared = foldEvent(state, { type: 'goal/change', data: { operation: 'clear', cleared: { id: 'g1' } } })
  const afterClear = foldEvent(foldEvent(cleared, turnStart(3)), turnEnd(3))
  assert.equal(afterClear.receipts[2].goal, null)
})

test('malformed goal payload reads as no goal (fail-closed on identity)', () => {
  const state = run([
    { type: 'goal/change', data: { operation: 'create', goal: { phase: 'active' } } }, // no id
    turnStart(1), turnEnd(1),
  ])
  assert.equal(state.receipts[0].goal, null)
})

test('turn number and end reason default safely when absent', () => {
  const state = run([{ type: 'turn/start' }, { type: 'turn/end' }])
  assert.equal(state.receipts[0].turn, -1)
  assert.equal(state.receipts[0].endReason, 'unknown')
})

test('MAX_RECEIPTS cap: keeps the newest N, drops the oldest', () => {
  let state = initReceiptState()
  const total = MAX_RECEIPTS + 10
  for (let t = 1; t <= total; t++) {
    state = foldEvent(state, turnStart(t))
    state = foldEvent(state, todoWrite('completed'))
    state = foldEvent(state, turnEnd(t))
  }
  assert.equal(state.receipts.length, MAX_RECEIPTS)
  // Oldest kept is turn 11; newest is the last turn.
  assert.equal(state.receipts[0].turn, total - MAX_RECEIPTS + 1)
  assert.equal(state.receipts[state.receipts.length - 1].turn, total)
})

test('reference stability: no-op events return the same state reference', () => {
  const base = run([turnStart(1), todoWrite('completed'), turnEnd(1)])
  // Unknown/ignored event -> same ref.
  assert.equal(foldEvent(base, { type: 'message/append', data: {} }), base)
  // turn/start when the accumulator is already null -> same ref.
  assert.equal(base.turnTodos, null)
  assert.equal(foldEvent(base, turnStart(2)), base)
})

test('reference stability: only turn/end replaces the receipts array', () => {
  const start = foldEvent(initReceiptState(), turnStart(1))
  const written = foldEvent(start, todoWrite('completed'))
  // todo/write must not churn the receipts array (wire view would misfire).
  assert.equal(written.receipts, start.receipts)
  const ended = foldEvent(written, turnEnd(1))
  assert.notEqual(ended.receipts, written.receipts)
})

test('countTodos and computeVerdict are usable directly', () => {
  assert.equal(computeVerdict(null), 'inconclusive')
  assert.equal(computeVerdict({ total: 0, completed: 0, inProgress: 0, pending: 0 }), 'inconclusive')
  assert.equal(computeVerdict({ total: 2, completed: 2, inProgress: 0, pending: 0 }), 'pass')
  assert.equal(computeVerdict({ total: 2, completed: 1, inProgress: 0, pending: 1 }), 'fail')
  assert.equal(countTodos({ todos: [{ status: 'completed' }] }).completed, 1)
  assert.equal(countTodos('nope'), null)
})
