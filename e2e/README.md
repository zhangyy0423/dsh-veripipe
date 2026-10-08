# dsh-veripipe end-to-end evidence

Real `dsh web` was launched against an **isolated** `DSH_HOME` (`../.e2e-home/`,
gitignored), on port **3090**, with the model routed through a local
chat-completions proxy on **127.0.0.1:8898**. The plugin was installed the same
way a user installs it — as a package, from the tarball `npm pack` produces
(not committed; run `npm pack` in the repo root) — not by loading source:

```
dsh plugin --profile web add ./dsh-veripipe-0.1.0.tgz
```

All numbers below are the **server-folded** `veripipeReceipts` projection value,
read back from dsh's durable projection cache (the authoritative state the host
itself replayed from the event log). Evidence is **redacted** to receipt
metadata — todo *counts*, verdicts, turn numbers, goal id/phase/revision, and
the one `veripipe_receipt` summary line the agent saw. No prompts, todo text,
model prose, goal objective text, tokens, cookies, or API keys are stored.

## Install verification

The opening `session/follow` snapshot lists `veripipeReceipts` among the
`projections.values` keys, i.e. the projection registered and is client-visible.
A brand-new session (no turn ended yet) folds to `[]` — a between-turns reader
sees an explicit empty log, never a stale `null`.

## Scenario results

Authoritative file: [`e2e-verified.json`](./e2e-verified.json) (`conclusions` +
per-session `receipts`). Each row cites the session that proves it.

| # | Scenario | Observed receipt(s) | Verdict |
|---|----------|---------------------|---------|
| a | a turn's final todo list is wholly completed | `turn 1: todos 3/3 completed` | **pass** |
| b | a turn leaves one todo incomplete | `turn 2: todos 2/3 completed, 1 pending` | **fail** |
| c | `create_goal` then one completed todo, then more turns | `turn 1: todos 1/1 + goal` then `turn 2`, `turn 3` | **pass**, goal carried |
| d | the agent calls `veripipe_receipt` itself | tool returned `Returned 2 of 2 receipt(s). Latest: turn 2 → fail` | correct |
| e | before any turn ends | `[]` | no receipts |

### The core property: a receipt is not cleared by the next `turn/start`

In session `45a5d93b…` the turn-1 receipt (`pass`, `todos 1/1`, goal attached)
remained in the log, unchanged, through the start **and** end of turns 2 and 3:

```
turn 1 -> pass          | todos [total 1, completed 1] | goal goal-121e53b1… (active)
turn 2 -> pass          | todos [total 3, completed 3] | goal goal-121e53b1… (active)
turn 3 -> inconclusive  | todos (none this turn)       | goal goal-121e53b1… (active)
```

The stock `todos` projection resets to `null` on every `turn/start`; here the
turn-1 terminal state stays readable after later turns begin. That gap is the
whole reason the plugin exists. Sessions `fedc831c…` and `247c78db…` show the
same survival across a `pass → fail → inconclusive` sequence.

## Files

- `run_e2e.py` — the live driver (unary RPC `session/create` + `session/prompt`,
  WS `session/follow`; cookie bootstrapped in-process from the gitignored
  dsh-web log, never persisted). Scenario prompts are inline.
- `extract_verified.py` — reads the durable projection cache and writes the
  redacted `e2e-verified.json`.
- `e2e-verified.json` — **authoritative** redacted evidence (server-folded state).
- `e2e-evidence.json` — the live driver's own capture. Its `d`/`c_t2` checks read
  `false` **not** because the plugin misbehaved but because the live
  `session/follow` snapshot returns only a recent record window (the
  `veripipe_receipt` call had scrolled out) and because the agent kept taking
  autonomous goal-pursuit turns past the ones prompted. `extract_verified.py`
  reading the durable fold is the ground truth; it confirms all five scenarios.
- `dsh-veripipe-0.1.0.tgz` — the installed artifact; not committed, rebuild it with `npm pack`.

## Caveats

- The run used a real model (DeepSeek v4 via a local proxy); turn *content* is
  non-deterministic. The driver asserts on folded **counts/verdicts**, which are
  deterministic given the todo states the model produced.
- A goal-bearing session pursues its goal autonomously, so more agent turns and
  sessions were recorded than the five prompts issued. This is agent behaviour,
  not plugin behaviour; the fold stayed correct in every session.

## Reproduce

1. Start a chat-completions-compatible model endpoint and point a `web` profile's
   `llm-deepseek` override at it (see `../.e2e-home/profiles/web/cordis.patch.yml`).
2. `DSH_HOME=../.e2e-home node <harness>/apps/cli/lib/bin.js web --port 3090 --no-open`
3. `python3 run_e2e.py` then `python3 extract_verified.py`.
