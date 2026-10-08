# dsh-veripipe

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that mints a **turn-terminal receipt** for every turn and keeps it readable after the turn ends — plus a read-only tool to read receipts back. It adds no model calls, no network, and no writes to your session.

## The problem it solves

dsh ships a `todos` session projection that an agent updates with `todo_write`. That projection is **cleared on every `turn/start`**: once the next turn begins, reading the `todos` projection returns `null`. An external verifier that inspects a session *between* turns therefore cannot tell a plan that finished (all todos `completed`) from one that was abandoned — both read as "no list".

`dsh-veripipe` folds the same event log into a parallel projection whose entries are **never cleared by a later turn**. At each `turn/end` it records one receipt capturing that turn's terminal state, so the completion status of every turn stays readable for the life of the session.

## What it registers

- **`veripipeReceipts` session projection** — a pure, deterministic fold over the session event log (`turn/start`, `todo/write`, `goal/change`, `turn/end`). It mints one receipt per `turn/end` and keeps the newest 50. It replays from the log like any other projection; it stores no state of its own outside the event stream.
- **`veripipe_receipt` tool** — read-only. Returns the current session's most recent receipts (default 1). It performs no model call, no network request, and no writes.

## Install

```sh
dsh plugin --profile <your-profile> add github:zhangyy0423/dsh-veripipe
```

The repository ships prebuilt output (`lib/`) and has no `prepare` script, so nothing is built on install. It is not published to npm. A local checkout or a packed tarball also works:

```sh
dsh plugin --profile <your-profile> add ./dsh-veripipe          # local checkout
dsh plugin --profile <your-profile> add ./dsh-veripipe-0.1.0.tgz # from `npm pack`
```

All `@deepseek-ai/*` packages are **peer dependencies** supplied by the host dsh installation; the plugin declares them as peers (not regular dependencies) on purpose. Declaring them as dependencies would load a second copy of `@deepseek-ai/dsh-tools` and break every tool call. `zod` is the only direct runtime dependency.

## Receipt fields

Each receipt is a small, JSON-plain record:

| Field | Type | Meaning |
| --- | --- | --- |
| `turn` | integer | The turn number this receipt certifies (`-1` if the event omitted it). |
| `endReason` | string | The `turn/end` reason kind (e.g. `completed`, `aborted`, `error`); `unknown` if unreadable. |
| `todos` | object \| null | Counts of the last todo list written in the turn: `{ total, completed, inProgress, pending }`, or `null` if none was written. |
| `goal` | object \| null | Goal identity at turn end: `{ id, phase, revision }`, or `null` if no goal was active. |
| `verdict.planComplete` | `pass` \| `fail` \| `inconclusive` | The fail-closed completion judgement (below). |

### Verdict semantics (fail-closed)

The verdict is deliberately conservative — uncertainty is never reported as `pass`:

- **`pass`** — a non-empty todo list was written this turn **and every item is `completed`**.
- **`fail`** — a non-empty todo list was written **and at least one item is not `completed`**.
- **`inconclusive`** — no todo list was written this turn, the list was empty, or the `todo/write` payload was unreadable.

## Tool usage

```jsonc
// veripipe_receipt (no required arguments)
{ "limit": 3 }   // optional; how many of the most recent receipts to return, newest last.
                 // Defaults to 1; clamped to 1..50.
```

Returns:

```jsonc
{
  "available": 7,            // total receipts kept for this session
  "returned": 3,             // how many this call returned
  "receipts": [              // oldest first
    {
      "turn": 5,
      "endReason": "completed",
      "todos": { "total": 3, "completed": 3, "inProgress": 0, "pending": 0 },
      "goal": { "id": "g_abc", "phase": "active", "revision": 2 },
      "verdict": { "planComplete": "pass" }
    }
    // ...
  ]
}
```

Before the first turn ends, the tool returns `{ "available": 0, "returned": 0, "receipts": [] }`.

## Privacy

Receipts store **counts and identifiers only**. The fold never records prompts, todo text, tool arguments, tool results, or a goal's objective text — only per-status todo counts, the goal's `id`/`phase`/`revision`, the turn number, and the end-reason kind. The `veripipe_receipt` tool returns exactly those fields and nothing more.

## Relation to veripipe

`veripipe` is an external verification pipeline that judges whether an agent actually completed the task it was given. Its dsh adapter reads a session's state after the run. Because the stock `todos` projection is cleared at the next `turn/start`, a between-turns read cannot distinguish a finished plan from an abandoned one. This plugin closes that gap on the dsh side: it exposes a durable, fail-closed, counts-only completion signal per turn that such a verifier can read without re-deriving history or touching private content. The plugin is independently useful without veripipe — it is a general turn-completion ledger — and is maintained separately from the harness.

## Development

```sh
DSH_HARNESS=/path/to/deepseek-harness bash scripts/link-harness.sh  # dev links for type-checking
npm run build   # tsc -p tsconfig.json -> lib/
npm test        # node --test over the pure fold (tests/*.test.mjs)
```

`lib/` is committed so installs need no build; rebuild and commit it after changing `src/`.

The whole computation lives in `src/receipt.ts`, which imports nothing from the harness and is unit-tested in isolation against the compiled `lib/receipt.js`.

## License

MIT © zhangyuyu03
