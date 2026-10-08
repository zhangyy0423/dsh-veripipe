/**
 * The one declaration home of the `veripipeReceipts` projection key. It merges
 * the key into the session-projection type tables so a host registrant and any
 * client aggregate that reads the snapshot both see the receipt types, with no
 * runtime value imports here (only the pure receipt types from `./receipt`).
 *
 * The host fold state ({@link ReceiptState}) carries the kept receipts plus the
 * running per-turn accumulators; the client wire value is the receipt array
 * alone — the accumulators are host-internal and never leave the host.
 *
 * @module @deepseek-ai/dsh-veripipe/types
 */

import type { ReceiptState, TurnReceipt } from './receipt.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host fold state for the receipt log: kept receipts plus per-turn accumulators. */
    veripipeReceipts: ReceiptState
  }
  interface SessionProjectionMap {
    /**
     * The session's turn-terminal receipts, oldest first. Unlike the stock
     * `todos` projection, this value is never reset by a new turn, so an
     * external verifier reads the terminal state of every past turn.
     */
    veripipeReceipts: TurnReceipt[]
  }
}
