/**
 * Pure, dependency-free fold for the `veripipeReceipts` session projection.
 *
 * This module holds the whole computation of the plugin: the receipt shape, the
 * fold over session events, and the fail-closed completion verdict. It imports
 * nothing from the harness or any runtime value package, so it folds
 * deterministically from plain event records and is unit-testable in isolation
 * (the compiled `lib/receipt.js` is what `tests/` exercises).
 *
 * The problem this solves: the stock `todos` projection resets to `null` on
 * every `turn/start`, so an external verifier that reads a session between
 * turns sees no todo list and cannot tell a finished plan from an abandoned
 * one. A receipt is minted at each `turn/end` and is NEVER cleared by a later
 * turn, so the terminal state of every turn stays readable.
 *
 * @module @deepseek-ai/dsh-veripipe/receipt
 */
/** Completion judgement for one turn's todo plan. `pass` requires certainty; anything else is fail-closed. */
export type Verdict = 'pass' | 'fail' | 'inconclusive';
/** Per-status tallies of the last whole todo list written in a turn. Counts only — never todo text. */
export interface TodoCounts {
    /** Number of items in the list. */
    total: number;
    /** Items with status `completed`. */
    completed: number;
    /** Items with status `in_progress`. */
    inProgress: number;
    /** Items with status `pending`. */
    pending: number;
}
/** Opaque goal identity at turn end. Identifiers and lifecycle only — never the objective text. */
export interface GoalRef {
    /** The goal's stable id. */
    id: string;
    /** Lifecycle phase (e.g. `active`, `paused`, `blocked`, `complete`); `unknown` if unreadable. */
    phase: string;
    /** The goal snapshot revision; `0` if unreadable. */
    revision: number;
}
/** One turn's terminal credential: what the turn ended as, minted at `turn/end` and never cleared afterward. */
export interface TurnReceipt {
    /** The turn number this receipt certifies (`-1` if the event omitted it). */
    turn: number;
    /** The `turn/end` reason kind (e.g. `completed`, `aborted`, `error`); `unknown` if unreadable. */
    endReason: string;
    /** Counts of the last todo list written this turn, or `null` if none was written. */
    todos: TodoCounts | null;
    /** Goal identity at turn end, or `null` if no goal was active. */
    goal: GoalRef | null;
    /** The fail-closed completion judgement. */
    verdict: {
        planComplete: Verdict;
    };
}
/** Host fold state: the kept receipts plus the running per-turn accumulators the next `turn/end` reads. */
export interface ReceiptState {
    /** Minted receipts, oldest first, capped at {@link MAX_RECEIPTS}. */
    receipts: TurnReceipt[];
    /** Counts of the last todo list written in the current turn, or `null` if none yet. */
    turnTodos: TodoCounts | null;
    /** Current goal identity, or `null`. Persists across turns (goals are not per-turn). */
    goal: GoalRef | null;
}
/** The newest N receipts kept per session. Bounds unbounded growth; older receipts drop off the front. */
export declare const MAX_RECEIPTS = 50;
/** The minimal event shape the fold reads: a `type` tag and an opaque `data` payload. */
export interface FoldEvent {
    /** The session event type tag. */
    type: string;
    /** The event payload, folded defensively (any unexpected shape yields a fail-closed receipt). */
    data?: unknown;
}
/** The empty projection state for a session before any event folds. */
export declare function initReceiptState(): ReceiptState;
/**
 * Tally a `todo/write` payload defensively. The whole-list snapshot semantics
 * match the stock `todos` projection: the latest write of a turn wins. Any
 * shape that is not a clean array of `{ status }` items with known statuses
 * returns `null`, which the verdict treats as inconclusive (fail-closed): a
 * verifier must never read a malformed write as a completed plan.
 * @param data - the raw `todo/write` event payload.
 * @returns per-status counts, or `null` when the payload is absent or malformed.
 */
export declare function countTodos(data: unknown): TodoCounts | null;
/**
 * The fail-closed completion verdict for a turn's todo counts. `pass` demands a
 * non-empty list in which every item is `completed`; a list with incomplete
 * items is `fail`; the absence of a list, an empty list, or an unreadable write
 * is `inconclusive`. Uncertainty is never `pass`.
 * @param todos - the turn's todo counts, or `null` when none were written or they were malformed.
 * @returns the completion verdict.
 */
export declare function computeVerdict(todos: TodoCounts | null): Verdict;
/**
 * The deterministic fold driving the `veripipeReceipts` projection. One event
 * in, the next state out. The contract that keeps the live drive quiet:
 *
 * - `turn/start` clears the per-turn todo accumulator ONLY — the receipt log is
 *   untouched, which is the whole point of this projection. Returns the same
 *   state reference when there is nothing to clear.
 * - `todo/write` records the whole-list counts for the current turn.
 * - `goal/change` updates the running goal identity (or clears it); it is not
 *   reset per turn because goals outlive turns.
 * - `turn/end` mints one receipt from the accumulators, caps the log at
 *   {@link MAX_RECEIPTS}, and resets the per-turn todo accumulator. The goal
 *   carries forward. Only this branch replaces the `receipts` array, so a
 *   `view` of `state.receipts` changes reference only when a receipt is minted.
 * - every other event returns the same state reference (no spurious change).
 *
 * @param state - the current fold state.
 * @param event - the committed session event.
 * @returns the next fold state (the same reference when the event changes nothing).
 */
export declare function foldEvent(state: ReceiptState, event: FoldEvent): ReceiptState;
