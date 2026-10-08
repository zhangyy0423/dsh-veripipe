#!/usr/bin/env python3
"""End-to-end verification for dsh-veripipe against a REAL local dsh web.

Drives real agent turns through dsh's unary RPC + WS follow transports (the same
wire the browser client uses) and asserts the `veripipeReceipts` projection and
the `veripipe_receipt` tool behave as designed. NO secret is ever printed or
persisted: the access token is read from a gitignored dsh-web log under the
isolated DSH_HOME, exchanged in-process for the HttpOnly cookie, and kept only
in memory. Evidence written to e2e/ is REDACTED to receipt metadata
(counts/verdicts/turns/goal-ids) and the veripipe_receipt call/result text only
-- never prompts, todo text, model prose, tokens, cookies, or keys.

Scenarios (<=6 real turns, 2 sessions):
  S1 t1: three todos, all completed            -> verdict pass
  S1 t2: three todos, one left incomplete       -> verdict fail
  S1 t3: agent calls veripipe_receipt(limit=2)  -> tool returns the two receipts
  S2 t1: create_goal + one completed todo        -> verdict pass, goal attached
  S2 t2: a trivial turn (auto-starts turn 2)     -> t1 receipt SURVIVES unchanged

Transports grounded in dsh source (see the sibling case-study helpers):
  unary : POST /api/<ns>/<m>  body {type:'client-request',rpcId,method,payload:{args}}
  follow: WS  /api/remote.mux open 'session/follow' -> snapshot{records,projections}
"""
from __future__ import annotations
import http.client, json, os, re, select, sys, time, uuid, pathlib

HOST, PORT = "127.0.0.1", 3090
BASE = f"http://{HOST}:{PORT}"
WS_URL = f"ws://{HOST}:{PORT}/api/remote.mux"
HOME = pathlib.Path(__file__).resolve().parent.parent / ".e2e-home"
WEB_LOG = HOME / "dsh-web.out.log"            # gitignored; holds the ?token=
EVIDENCE = pathlib.Path(__file__).resolve().parent / "e2e-evidence.json"
TURN_DEADLINE = float(os.environ.get("E2E_TURN_DEADLINE", "240"))

_COOKIE: str | None = None


def _read_token() -> str:
    """Parse the one-time access token from the gitignored dsh-web log."""
    text = WEB_LOG.read_text(errors="replace")
    m = re.search(r"token=([A-Za-z0-9_\-]+)", text)
    if not m:
        raise RuntimeError(f"no ?token= in {WEB_LOG} (is dsh web up on {PORT}?)")
    return m.group(1)


def _cookie() -> str:
    """Exchange the token for the HttpOnly dsh-auth cookie (in-memory only)."""
    global _COOKIE
    if _COOKIE:
        return _COOKIE
    token = _read_token()
    conn = http.client.HTTPConnection(HOST, PORT, timeout=8)
    try:
        conn.request("GET", "/?token=" + token, headers={"Accept": "text/html"})
        resp = conn.getresponse(); resp.read()
        setc = resp.getheader("Set-Cookie")
        if resp.status != 303 or not setc:
            raise RuntimeError(f"token exchange failed: status={resp.status}")
        _COOKIE = setc.split(";", 1)[0].strip()
        return _COOKIE
    finally:
        conn.close()


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


def rpc(endpoint: str, args: dict, *, timeout: float = 60.0):
    """Unary call. endpoint='<ns>/<method>'. Returns the business value."""
    import urllib.request, urllib.error
    body = json.dumps({"type": "client-request", "rpcId": str(uuid.uuid4()),
                       "method": endpoint, "payload": {"args": args}}).encode()
    req = urllib.request.Request(BASE + "/api/" + endpoint, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Cookie", _cookie())
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise RpcError("http/" + str(e.code), e.read().decode("replace")[:200])
    result = payload.get("result") or {}
    if result.get("ok"):
        return result.get("value")
    err = result.get("error") or {}
    raise RpcError(err.get("code", "unknown"), err.get("message", ""))


def create_session() -> str:
    return rpc("session/create", {"request": {}})["sessionId"]


def prompt(session_id: str, text: str, *, mode: str = "queue") -> dict:
    return rpc("session/prompt", {"request": {
        "requestId": "req-" + uuid.uuid4().hex,
        "sessionId": session_id, "mode": mode,
        "content": [{"type": "text", "text": text}],
    }})


def goal_get(session_id: str):
    try:
        return rpc("goals/get", {"agentId": session_id})
    except RpcError as e:
        return {"_rpc_error": {"code": e.code}}


def follow(session_id: str, *, idle: float = 4.0, wall: float = 20.0) -> dict:
    """Open session/follow, capture the opening snapshot, then stop (live stream)."""
    import websocket
    conn = websocket.create_connection(WS_URL, timeout=8.0, cookie=_cookie())
    sid = "s-" + uuid.uuid4().hex
    request = {"address": {"kind": "session", "sessionId": session_id}}
    snapshot = None
    deadline = time.time() + wall
    try:
        conn.send(json.dumps({"type": "open", "streamId": sid,
                              "endpoint": "session/follow",
                              "payload": {"args": {"request": request}}}))
        sock = conn.sock
        while time.time() < deadline:
            if not select.select([sock], [], [], min(idle, deadline - time.time()))[0]:
                break
            try:
                raw = conn.recv()
            except Exception:
                break
            if not raw:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") in ("end", "error"):
                break
            if msg.get("type") != "item":
                continue
            value = msg.get("value")
            if isinstance(value, dict) and value.get("type") == "snapshot":
                snapshot = value
                break
    finally:
        try:
            conn.send(json.dumps({"type": "cancel", "streamId": sid}))
        except Exception:
            pass
        conn.close()
    return snapshot or {}


def receipts_of(snapshot: dict) -> list:
    """The server-folded `veripipeReceipts` wire view (TurnReceipt[]), or []."""
    proj = snapshot.get("projections")
    values = proj.get("values") if isinstance(proj, dict) else None
    got = values.get("veripipeReceipts") if isinstance(values, dict) else None
    return got if isinstance(got, list) else []


def wait_for_receipts(session_id: str, want: int) -> list:
    """Poll follow until the receipt log reaches `want` entries (turn-end mints one)."""
    deadline = time.time() + TURN_DEADLINE
    seen = []
    while time.time() < deadline:
        seen = receipts_of(follow(session_id))
        if len(seen) >= want:
            return seen
        time.sleep(4.0)
    return seen


def veripipe_tool_events(snapshot: dict) -> list:
    """Extract only the veripipe_receipt tool call/result pairs (safe metadata)."""
    records = snapshot.get("records") or []
    calls = {}
    for r in records:
        if not isinstance(r, dict):
            continue
        data = r.get("data") if isinstance(r.get("data"), dict) else {}
        if r.get("type") == "tool/call" and data.get("name") == "veripipe_receipt":
            calls[data.get("callId")] = {"turn": data.get("turn"),
                                         "arguments": data.get("arguments")}
    pairs = []
    for r in records:
        if not isinstance(r, dict) or r.get("type") != "tool/result":
            continue
        data = r.get("data") if isinstance(r.get("data"), dict) else {}
        msg = data.get("message") if isinstance(data.get("message"), dict) else {}
        blocks = msg.get("content") if isinstance(msg.get("content"), list) else []
        cid = None
        texts = []
        for b in blocks:
            if not isinstance(b, dict):
                continue
            cid = cid or b.get("toolCallId")
            if isinstance(b.get("text"), str):
                texts.append(b["text"])
        if cid in calls:
            pairs.append({"call": calls[cid], "result_text": " ".join(texts)[:400],
                          "isError": bool(data.get("error"))})
    return pairs


# Prompts constrain the agent to exercise one scenario each. They ask only for
# trivial, in-turn-completable bookkeeping so the FINAL todo_write of the turn
# has a deterministic status mix; no external work is implied.
P_S1_T1 = ("Use your todo list tool to track exactly three steps, then actually "
           "do each trivial step and mark it completed: (1) say the word alpha, "
           "(2) say the word beta, (3) say the word gamma. End the turn only once "
           "all three todo items are marked completed.")
P_S1_T2 = ("Start a fresh todo list with exactly three steps: (1) say red, "
           "(2) say green, (3) say blue. Do steps 1 and 2 and mark those two "
           "completed, but leave step 3 as pending (do not complete it). End the "
           "turn with one item still pending.")
P_S1_T3 = ("Call the veripipe_receipt tool with limit set to 2, then tell me in "
           "one sentence the verdict of each receipt it returns.")
P_S2_T1 = ("First call create_goal to set the objective to the literal string "
           "'veripipe live e2e'. Then use your todo list tool to track exactly one "
           "step: 'confirm the goal is set'. Do it and mark that single todo "
           "completed before ending the turn.")
P_S2_T2 = ("Reply with just the word done. Do not touch the todo list or the goal.")


def run_session1(ev: dict) -> None:
    sid = create_session()
    ev["session1"] = {"turns": []}
    prompt(sid, P_S1_T1)
    r1 = wait_for_receipts(sid, 1)
    ev["session1"]["turns"].append({"scenario": "a all-completed->pass",
                                    "receipts": r1})
    prompt(sid, P_S1_T2)
    r2 = wait_for_receipts(sid, 2)
    ev["session1"]["turns"].append({"scenario": "b one-incomplete->fail",
                                    "receipts": r2})
    prompt(sid, P_S1_T3)
    r3 = wait_for_receipts(sid, 3)
    snap = follow(sid)
    ev["session1"]["turns"].append({"scenario": "d agent-calls-tool",
                                    "receipts": receipts_of(snap),
                                    "veripipe_tool_events": veripipe_tool_events(snap)})


def run_session2(ev: dict) -> None:
    sid = create_session()
    ev["session2"] = {"turns": []}
    prompt(sid, P_S2_T1)
    r1 = wait_for_receipts(sid, 1)
    g1 = goal_get(sid)
    ev["session2"]["turns"].append({"scenario": "c-t1 goal+1-completed->pass",
                                    "receipts": r1,
                                    "goal_readback_id": (g1 or {}).get("id")})
    prompt(sid, P_S2_T2)
    r2 = wait_for_receipts(sid, 2)
    ev["session2"]["turns"].append({"scenario": "c-t2 survives-next-turn/start",
                                    "receipts": r2,
                                    "turn1_receipt_after_turn2": r2[0] if r2 else None})


def _verdict(receipt) -> str:
    if not isinstance(receipt, dict):
        return "?"
    v = receipt.get("verdict")
    return v.get("planComplete") if isinstance(v, dict) else "?"


def assess(ev: dict) -> dict:
    """Derive pass/fail checks from the collected receipts (no mutation)."""
    checks = {}
    s1 = ev.get("session1", {}).get("turns", [])
    s2 = ev.get("session2", {}).get("turns", [])
    if len(s1) >= 1 and s1[0]["receipts"]:
        r = s1[0]["receipts"][0]
        t = r.get("todos") or {}
        checks["a_pass"] = (_verdict(r) == "pass" and t.get("total") == t.get("completed") and (t.get("total") or 0) >= 1)
    if len(s1) >= 2 and len(s1[1]["receipts"]) >= 2:
        r = s1[1]["receipts"][1]
        t = r.get("todos") or {}
        checks["b_fail"] = (_verdict(r) == "fail" and (t.get("completed") or 0) < (t.get("total") or 0))
    if len(s1) >= 3:
        evs = s1[2].get("veripipe_tool_events") or []
        checks["d_tool_called"] = any(not e.get("isError") and e.get("result_text") for e in evs)
        checks["d_three_receipts"] = len(s1[2]["receipts"]) >= 3
    if len(s2) >= 1 and s2[0]["receipts"]:
        r = s2[0]["receipts"][0]
        t = r.get("todos") or {}
        checks["c_t1_pass_goal"] = (_verdict(r) == "pass" and (t.get("completed") == t.get("total") == 1) and r.get("goal") is not None)
    if len(s2) >= 2 and len(s2[1]["receipts"]) >= 1:
        r1_after = s2[1]["receipts"][0]
        t = r1_after.get("todos") or {}
        checks["c_t2_survives"] = (_verdict(r1_after) == "pass" and (t.get("completed") == 1) and r1_after.get("goal") is not None and len(s2[1]["receipts"]) >= 2)
    return checks


def main() -> int:
    ev = {"when": time.strftime("%Y-%m-%dT%H:%M:%S"), "base": BASE,
          "note": "redacted: receipt metadata + veripipe_receipt call/result text only"}
    try:
        run_session1(ev)
        run_session2(ev)
    finally:
        ev["checks"] = assess(ev)
        EVIDENCE.write_text(json.dumps(ev, ensure_ascii=False, indent=2))
    checks = ev["checks"]
    ok = checks and all(checks.values())
    print(json.dumps({"checks": checks, "all_pass": bool(ok)}, ensure_ascii=False, indent=2))
    print("evidence ->", EVIDENCE)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
