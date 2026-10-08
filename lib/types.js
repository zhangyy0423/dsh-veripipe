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
export {};
