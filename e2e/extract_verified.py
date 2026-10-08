#!/usr/bin/env python3
"""Curate REDACTED per-scenario evidence from dsh's authoritative on-disk
projection cache (the server-folded `veripipeReceipts.val`), plus the one
`veripipe_receipt` return line the agent saw (from the `turnOutline` row).

Reads the gitignored .e2e-home cache; writes e2e/e2e-verified.json. Emits ONLY
receipt metadata (counts/verdicts/turns), goal ids/phase/revision, and the tool
summary line matching 'Returned N of M receipt(s). Latest: turn K -> verdict'.
NO prompts, todo text, model prose, goal objective text, tokens, or cookies.
"""
import json, re, pathlib
HOME = pathlib.Path(__file__).resolve().parent.parent / ".e2e-home"
CACHE = HOME / "storages/session_projcache/sessions"
OUT = pathlib.Path(__file__).resolve().parent / "e2e-verified.json"
RET = re.compile(r"Returned \d+ of \d+ receipt\(s\)\. Latest: turn \d+ \S+ \w+")

def receipts(rows):
    vr = (rows.get("veripipeReceipts") or {}).get("val") or {}
    out = []
    for r in (vr.get("receipts") or []):
        t, g = r.get("todos"), r.get("goal")
        out.append({"turn": r.get("turn"), "endReason": r.get("endReason"),
                    "todos": (None if t is None else {k: t[k] for k in ("total","completed","inProgress","pending")}),
                    "goal": (None if g is None else {"id": g.get("id"), "phase": g.get("phase"), "revision": g.get("revision")}),
                    "verdict": r.get("verdict")})
    return out, (vr.get("turnTodos") is not None)

def tool_lines(rows):
    outline = (rows.get("turnOutline") or {}).get("val")
    blob = json.dumps(outline, ensure_ascii=False) if outline else ""
    return sorted(set(RET.findall(blob)))

def load(name):
    d = json.load(open(CACHE / name))
    rows = d["record"]["rows"]
    stats = (rows.get("sessionStats") or {}).get("val") or {}
    recs, tt_set = receipts(rows)
    return {"turns_started": stats.get("turns"), "last_turn": stats.get("lastTurn"),
            "turnTodos_set": tt_set, "receipts": recs, "veripipe_receipt_returns": tool_lines(rows)}

def verdict_of(r):
    return (r.get("verdict") or {}).get("planComplete")

def conclusions(sessions):
    c = {}
    for name, s in sessions.items():
        recs = s["receipts"]
        # (a) a turn whose last todo write was all-completed -> pass
        if any(verdict_of(r) == "pass" and (r["todos"] or {}).get("total") == (r["todos"] or {}).get("completed") for r in recs if r["todos"]):
            c.setdefault("a_all_completed_pass", name)
        # (b) a turn that left an item incomplete -> fail
        if any(verdict_of(r) == "fail" and (r["todos"] or {}).get("completed") < (r["todos"] or {}).get("total") for r in recs if r["todos"]):
            c.setdefault("b_incomplete_fail", name)
        # (c1) create_goal + one completed todo -> pass with goal attached
        if any(verdict_of(r) == "pass" and r["goal"] and (r["todos"] or {}).get("completed") == 1 and (r["todos"] or {}).get("total") == 1 for r in recs):
            c.setdefault("c1_goal_plus_completed_pass", name)
        # (c2) turn-1 receipt survives subsequent turn/start(s): >1 receipt and
        # the oldest kept its terminal verdict (not cleared like stock `todos`).
        if len(recs) >= 2 and recs[0].get("turn") == 1 and verdict_of(recs[0]) in ("pass", "fail"):
            c.setdefault("c2_receipt_survives_next_turn_start", name)
        # (c2b) receipt also survives WHILE the next turn is mid-flight
        if s["turnTodos_set"] and recs and recs[0].get("turn") == 1:
            c.setdefault("c2b_survives_during_live_next_turn", name)
        # (d) the agent called veripipe_receipt and saw a correct summary line
        if s["veripipe_receipt_returns"]:
            c.setdefault("d_agent_tool_call_correct", {"session": name, "returns": s["veripipe_receipt_returns"]})
        # before the first turn ends, no receipts
        if s["turns_started"] in (0, None) and not recs:
            c.setdefault("e_empty_before_first_turn_end", name)
    return c

def main():
    sessions = {p.name: load(p.name) for p in sorted(CACHE.glob("session-*.json"))}
    concl = conclusions(sessions)
    OUT.write_text(json.dumps({"source": "server-folded veripipeReceipts.val (durable projcache)",
                               "redaction": "counts/verdicts/turns + goal id/phase/revision + tool summary line only",
                               "conclusions": concl,
                               "sessions": sessions}, ensure_ascii=False, indent=2))
    print(json.dumps(concl, ensure_ascii=False, indent=2))
    print("->", OUT)

if __name__ == "__main__":
    main()
