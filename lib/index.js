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
import { z as zod } from 'zod';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { foldEvent, initReceiptState, MAX_RECEIPTS, } from "./receipt.js";
/** The plugin name, surfaced by the loader. */
export const name = 'dsh-veripipe';
/** Services this plugin requires from the host composition. */
export const inject = ['tools', 'sessionProjections'];
/** Default number of receipts the tool returns when `limit` is omitted. */
const DEFAULT_LIMIT = 1;
/** Wire/state schema fragment for {@link TodoCounts}. */
const todoCountsSchema = zod.object({
    total: zod.number(),
    completed: zod.number(),
    inProgress: zod.number(),
    pending: zod.number(),
});
/** Wire/state schema fragment for {@link GoalRef}. */
const goalRefSchema = zod.object({
    id: zod.string(),
    phase: zod.string(),
    revision: zod.number(),
});
/** Wire/state schema fragment for one {@link TurnReceipt}. */
const turnReceiptSchema = zod.object({
    turn: zod.number(),
    endReason: zod.string(),
    todos: zod.union([todoCountsSchema, zod.null()]),
    goal: zod.union([goalRefSchema, zod.null()]),
    verdict: zod.object({
        planComplete: zod.union([zod.literal('pass'), zod.literal('fail'), zod.literal('inconclusive')]),
    }),
});
/** The client wire value: the receipt array. */
const receiptListSchema = zod.array(turnReceiptSchema);
/** The host fold state: receipts plus the per-turn accumulators. */
const receiptStateSchema = zod.object({
    receipts: receiptListSchema,
    turnTodos: zod.union([todoCountsSchema, zod.null()]),
    goal: zod.union([goalRefSchema, zod.null()]),
});
/**
 * Clamp a model-supplied `limit` into `1..MAX_RECEIPTS`, defaulting a missing
 * or non-finite value to {@link DEFAULT_LIMIT}.
 * @param limit - the raw `limit` argument.
 * @returns a safe integer count.
 */
function clampLimit(limit) {
    if (typeof limit !== 'number' || !Number.isFinite(limit))
        return DEFAULT_LIMIT;
    const floored = Math.floor(limit);
    if (floored < 1)
        return 1;
    if (floored > MAX_RECEIPTS)
        return MAX_RECEIPTS;
    return floored;
}
const TOOL_DESCRIPTION = 'Read this session\'s turn-completion receipts (read-only; no side effects). '
    + 'Each receipt is minted at a turn\'s end and is never cleared by later turns, '
    + 'so it reports that turn\'s final todo counts, goal identity, end reason, and a '
    + 'fail-closed completion verdict (`pass` only when a non-empty todo list was all '
    + 'completed; `fail` when some remained; `inconclusive` when no list was written '
    + 'or it was unreadable). Returns the most recent receipts, newest last; pass '
    + '`limit` to read more than the latest one. Returns no receipts before the first '
    + 'turn ends.';
/**
 * Register the `veripipeReceipts` projection and the `veripipe_receipt` tool.
 * @param ctx - the registrant context carrying the tool and session-projection registries.
 */
export function apply(ctx) {
    ctx.sessionProjections.register({
        key: 'veripipeReceipts',
        stateSchema: receiptStateSchema,
        init: () => initReceiptState(),
        apply: (state, event) => foldEvent(state, event),
        wire: { viewSchema: receiptListSchema, view: state => state.receipts },
        stateVersion: 1,
    });
    ctx.tools.register(defineTool({
        name: 'veripipe_receipt',
        description: TOOL_DESCRIPTION,
        parameters: {
            limit: {
                type: 'integer',
                description: `How many of the most recent receipts to return, newest last. Default ${DEFAULT_LIMIT}; clamped to 1..${MAX_RECEIPTS}.`,
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    available: { type: 'integer', required: true, description: 'Total receipts kept for this session.' },
                    returned: { type: 'integer', required: true, description: 'How many receipts this call returned.' },
                    receipts: {
                        type: 'array',
                        required: true,
                        description: 'The returned receipts, oldest first.',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                turn: { type: 'integer', required: true },
                                endReason: { type: 'string', required: true },
                                todos: {
                                    required: true,
                                    oneOf: [
                                        {
                                            type: 'object',
                                            additionalProperties: false,
                                            properties: {
                                                total: { type: 'integer', required: true },
                                                completed: { type: 'integer', required: true },
                                                inProgress: { type: 'integer', required: true },
                                                pending: { type: 'integer', required: true },
                                            },
                                        },
                                        { type: 'null' },
                                    ],
                                },
                                goal: {
                                    required: true,
                                    oneOf: [
                                        {
                                            type: 'object',
                                            additionalProperties: false,
                                            properties: {
                                                id: { type: 'string', required: true },
                                                phase: { type: 'string', required: true },
                                                revision: { type: 'integer', required: true },
                                            },
                                        },
                                        { type: 'null' },
                                    ],
                                },
                                verdict: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: true,
                                    properties: {
                                        planComplete: { type: 'string', required: true, enum: ['pass', 'fail', 'inconclusive'] },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.returned === 0
                        ? 'No veripipe receipts yet (no turn has ended in this session).'
                        : `Returned ${value.returned} of ${value.available} receipt(s). Latest: turn ${value.receipts[value.receipts.length - 1]?.turn} → ${value.receipts[value.receipts.length - 1]?.verdict.planComplete}.`,
                }],
        },
        execute(args, exec) {
            if (!exec.agent) {
                // The receipts are per-agent-session state; a non-agent caller has no
                // owning session to read. Fail loud rather than return a false empty.
                throw new Error('veripipe_receipt requires an owning agent session');
            }
            const state = ctx.sessionProjections.stateOf(exec.agent.session, 'veripipeReceipts');
            const receipts = state?.receipts ?? [];
            const limit = clampLimit(args.limit);
            const slice = receipts.slice(Math.max(0, receipts.length - limit));
            return Promise.resolve({
                available: receipts.length,
                returned: slice.length,
                receipts: slice.map(receipt => ({
                    turn: receipt.turn,
                    endReason: receipt.endReason,
                    todos: receipt.todos === null ? null : { ...receipt.todos },
                    goal: receipt.goal === null ? null : { ...receipt.goal },
                    verdict: { planComplete: receipt.verdict.planComplete },
                })),
            });
        },
        presentCall: args => ({ card: 'generic', title: 'Read veripipe receipts', kind: 'other', rawInput: args }),
    }));
}
