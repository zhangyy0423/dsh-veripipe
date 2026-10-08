/**
 * `dsh-veripipe` — a turn-terminal receipt projection plus a read-only tool to
 * read it back.
 *
 * The plugin registers one session projection, `veripipeReceipts`, that folds
 * purely and deterministically from the session event log. At each `turn/end`
 * it mints one {@link TurnReceipt} and keeps the newest {@link MAX_RECEIPTS}.
 * Crucially, a receipt is NOT cleared by the next `turn/start` — the gap the
 * stock `todos` projection leaves, where a between-turns reader sees `null` and
 * cannot tell a finished plan from an abandoned one. It also registers
 * `veripipe_receipt`, a read-only tool returning the current session's most
 * recent receipts. No model call, no network, no writes.
 *
 * `@deepseek-ai/*` are peer dependencies provided by the host dsh installation;
 * declaring them as regular dependencies would double-load `dsh-tools` and
 * break every tool call. Only `zod` is a direct runtime dependency.
 *
 * @module @deepseek-ai/dsh-veripipe
 */
import type { Context } from '@deepseek-ai/cordis';
export type * from './types.ts';
export type { GoalRef, ReceiptState, TodoCounts, TurnReceipt, Verdict } from './receipt.ts';
/** The plugin name, surfaced by the loader. */
export declare const name = "dsh-veripipe";
/** Services this plugin requires from the host composition. */
export declare const inject: string[];
/**
 * Register the `veripipeReceipts` projection and the `veripipe_receipt` tool.
 * @param ctx - the registrant context carrying the tool and session-projection registries.
 */
export declare function apply(ctx: Context): void;
