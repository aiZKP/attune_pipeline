#!/usr/bin/env python3
"""Crown and level watch (public facts only).

Reads kings.json of robotensor/vector-kings, the vector-orchestrator spec, the heads of the repos the
pipeline pins, and everything that announces the NEXT level before it goes live:
  - every branch of the three repositories (level 3's spec sat on `spec/level-3` before its switch);
  - the benchmark's level gate, envs/_levels.py (MAX_LEVEL and the factors), and its level config files;
  - the spec.json of every vector-orchestrator branch;
  - the public docs' "Vector is at level N" and the ladder's "Next" step;
  - the organisation's list of public repositories.
Writes crown.json and crown-history.json into the data checkout. Stdlib only.

Usage: crown_watch.py <data-dir>         (the GitHub Action; a slow backup, GitHub runs it every few hours)
The fast watch is attune-lab/tools/scripts/level_watch.py, which calls `step()` every few minutes.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HF = "https://huggingface.co"
API = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"
KINGS_REPO = "robotensor/vector-kings"
ORG = "robotensor"
HEADS = {
    "vector-orchestrator": ("robotensor/vector-orchestrator", "main"),
    "RoboTwin-Vector": ("robotensor/RoboTwin-Vector", "vector"),
    "attune-subnet": ("robotensor/attune-subnet", "main"),
}
BENCH = "robotensor/RoboTwin-Vector"
ORCH = "robotensor/vector-orchestrator"
DOCS_URL = "https://vector.robotensor.ai/docs/guide/the-tasks"
HEARTBEAT_MIN = 55
#: Event kinds that can mean a new level is coming or has come. They are raised as alerts.
ALERT_KINDS = ("level", "spec", "gate", "gate-factors", "level-config", "spec-branch", "branch", "docs", "repo")
ALERT_HEADS = ("vector-orchestrator", "RoboTwin-Vector")
KEEP_ALERTS = 30


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch(url: str, github: bool = False) -> bytes:
    headers = {"User-Agent": "attune-crown-watch"}
    token = os.environ.get("GITHUB_TOKEN")
    if github and token:
        headers["Authorization"] = f"Bearer {token}"
        headers["Accept"] = "application/vnd.github+json"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        return r.read()


def get(url: str, github: bool = False):
    return json.loads(fetch(url, github))


def spec_summary(spec: dict, sha: str | None = None) -> dict:
    tasks = spec.get("tasks") or []
    out = {
        "version": spec.get("version"),
        "level": spec.get("level"),
        "margin": (spec.get("crown") or {}).get("margin"),
        "max_void": (spec.get("crown") or {}).get("max_void"),
        "runs_per_task": spec.get("runs_per_task"),
        "step_ratio": spec.get("step_ratio"),
        "tasks": len(tasks),
        "architecture": (spec.get("model") or {}).get("architecture"),
    }
    if sha:
        out["sha"] = sha
    return out


def snapshot() -> dict:
    kings = get(f"{HF}/{KINGS_REPO}/resolve/main/kings.json")
    info = get(f"{HF}/api/models/{KINGS_REPO}")
    heads = {}
    for name, (repo, branch) in HEADS.items():
        d = get(f"{API}/repos/{repo}/commits/{branch}", github=True)
        heads[name] = {"sha": d["sha"], "date": d["commit"]["committer"]["date"],
                       "message": d["commit"]["message"].splitlines()[0][:120], "branch": branch}
    orch = heads["vector-orchestrator"]["sha"]
    spec = get(f"{RAW}/{ORCH}/{orch}/spec.json")
    ks = sorted(kings.get("kings", []), key=lambda k: k.get("place", 99))
    return {
        "king": ks[0] if ks else None,
        "kings": ks,
        "kings_commit": info.get("sha"),
        "level": spec.get("level"),
        "spec": spec_summary(spec, orch),
        "heads": heads,
    }


# ------------------------------------------------------------------------------------------ the level watch
def _branches(repo: str) -> dict:
    return {b["name"]: b["commit"]["sha"] for b in get(f"{API}/repos/{repo}/branches?per_page=100", github=True)}


def _gate(branch: str) -> dict:
    try:
        src = fetch(f"{RAW}/{BENCH}/{branch}/envs/_levels.py").decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:  # a branch without the level gate (upstream's `main` today)
            return {"max_level": None, "factors": {}, "levels_sha": None, "level_configs": []}
        raise
    m = re.search(r"MIN_LEVEL\s*,\s*MAX_LEVEL\s*=\s*(\d+)\s*,\s*(\d+)", src)
    block = re.search(r"FACTOR_LEVEL\s*=\s*\{(.*?)\}", src, re.S)
    factors = {k: int(v) for k, v in re.findall(r'"(\w+)"\s*:\s*(\d+)', block.group(1))} if block else {}
    try:
        files = get(f"{API}/repos/{BENCH}/contents/env_cfg/task_config?ref={branch}", github=True)
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
        files = []
    configs = sorted(f["name"] for f in files if re.fullmatch(r"level\d+\.yml", f.get("name", "")))
    return {"max_level": int(m.group(2)) if m else None, "factors": factors,
            "levels_sha": hashlib.sha256(src.encode()).hexdigest()[:12], "level_configs": configs}


def _docs() -> dict:
    page = fetch(DOCS_URL).decode("utf-8", "replace")
    t = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", page)
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))
    level = re.search(r"Vector is at level (\d+)", t)
    nxt = re.search(r"\bNext ([A-Z][a-z]+)\b", t[t.find("Vector is at level"):] if level else t)
    i, j = t.find("Vector is at level"), t.find("Growing the task set")
    para = t[i:j] if 0 <= i < j else ""
    return {"level": int(level.group(1)) if level else None, "next": nxt.group(1) if nxt else None,
            "ladder_sha": hashlib.sha256(para.encode()).hexdigest()[:12] if para else None}


def watch(old: dict | None) -> dict:
    """What announces a level change. A part that cannot be read keeps its last value: a network error must
    not look like a change."""
    old = old or {}
    out: dict = {"errors": []}

    def part(key, fn):
        try:
            out[key] = fn()
        except Exception as exc:  # noqa: BLE001 - reported in the snapshot, the next run tries again
            out[key] = old.get(key)
            out["errors"].append(f"{key}: {type(exc).__name__}")

    part("branches", lambda: {name: _branches(repo) for name, (repo, _) in HEADS.items()})
    part("gate", lambda: {b: _gate(b) for b in ("vector", "main")})

    def spec_branches():
        names = ((out.get("branches") or {}).get("vector-orchestrator") or {})
        return {b: spec_summary(get(f"{RAW}/{ORCH}/{sha}/spec.json"), sha) for b, sha in sorted(names.items())}

    part("spec_branches", spec_branches)
    part("docs", _docs)
    part("org_repos", lambda: sorted(r["name"] for r in get(f"{API}/orgs/{ORG}/repos?per_page=100", github=True)))
    return out


def watch_events(old: dict | None, new: dict, at: str) -> list[dict]:
    if not old:
        return []  # the first snapshot is the baseline
    evs: list[dict] = []
    ob, nb = old.get("branches") or {}, new.get("branches") or {}
    for repo in sorted(nb):
        pinned = HEADS[repo][1] if repo in HEADS else None
        o, n = ob.get(repo) or {}, nb.get(repo) or {}
        if not o:
            continue
        for b in sorted(set(n) - set(o)):
            evs.append({"at": at, "kind": "branch", "repo": repo, "branch": b, "change": "new", "to": n[b][:10]})
        for b in sorted(set(o) - set(n)):
            evs.append({"at": at, "kind": "branch", "repo": repo, "branch": b, "change": "deleted"})
        for b in sorted(set(o) & set(n)):
            if o[b] != n[b] and b != pinned:  # the pinned branch's moves are "head" events already
                evs.append({"at": at, "kind": "branch", "repo": repo, "branch": b, "change": "moved",
                            "from": o[b][:10], "to": n[b][:10]})
    og, ng = old.get("gate") or {}, new.get("gate") or {}
    for b in sorted(ng):
        o, n = og.get(b) or {}, ng.get(b) or {}
        if not o or not n:
            continue
        if o.get("levels_sha") is None and n.get("levels_sha") is None:
            continue
        if o.get("max_level") != n.get("max_level"):
            evs.append({"at": at, "kind": "gate", "branch": b, "from": o.get("max_level"), "to": n.get("max_level")})
        of, nf = o.get("factors") or {}, n.get("factors") or {}
        if of != nf:
            evs.append({"at": at, "kind": "gate-factors", "branch": b,
                        "added": {k: nf[k] for k in sorted(set(nf) - set(of))},
                        "removed": sorted(set(of) - set(nf)),
                        "moved": {k: [of[k], nf[k]] for k in sorted(set(of) & set(nf)) if of[k] != nf[k]}})
        added = sorted(set(n.get("level_configs") or []) - set(o.get("level_configs") or []))
        if added:
            evs.append({"at": at, "kind": "level-config", "branch": b, "added": added})
    os_, ns = old.get("spec_branches") or {}, new.get("spec_branches") or {}
    if os_:
        for b in sorted(ns):
            if b == "main":
                continue  # main's spec is the "spec" and "level" events
            o, n = dict(os_.get(b) or {}), dict(ns[b] or {})
            o.pop("sha", None), n.pop("sha", None)
            if o != n:
                evs.append({"at": at, "kind": "spec-branch", "branch": b, "new": b not in os_, "spec": n})
    od, nd = old.get("docs") or {}, new.get("docs") or {}
    if od and nd:
        fields = [k for k in ("level", "next", "ladder_sha") if od.get(k) != nd.get(k)]
        if fields:
            evs.append({"at": at, "kind": "docs", "fields": fields, "level": nd.get("level"), "next": nd.get("next")})
    orp, nrp = old.get("org_repos"), new.get("org_repos")
    if orp and nrp:
        for name in sorted(set(nrp) - set(orp)):
            evs.append({"at": at, "kind": "repo", "name": name})
    return evs


def events(old: dict, new: dict, at: str) -> list[dict]:
    out = []
    ok, nk = (old.get("king") or {}).get("key"), (new.get("king") or {}).get("key")
    if old and ok != nk:
        out.append({"at": at, "kind": "crown", "from": (old.get("king") or {}).get("repo"), "to": (new.get("king") or {}).get("repo"), "key": nk})
    if old and old.get("level") != new.get("level"):
        out.append({"at": at, "kind": "level", "from": old.get("level"), "to": new.get("level")})
    if old:
        o, n = dict(old.get("spec") or {}), dict(new["spec"])
        o.pop("sha", None), n.pop("sha", None)
        if o != n:
            out.append({"at": at, "kind": "spec", "fields": sorted(k for k in set(o) | set(n) if o.get(k) != n.get(k))})
        for name, h in new["heads"].items():
            before = ((old.get("heads") or {}).get(name) or {}).get("sha")
            if before and before != h["sha"]:
                out.append({"at": at, "kind": "head", "repo": name, "from": before[:10], "to": h["sha"][:10], "message": h["message"]})
    return out


def is_alert(ev: dict) -> bool:
    return ev.get("kind") in ALERT_KINDS or (ev.get("kind") == "head" and ev.get("repo") in ALERT_HEADS)


def describe(ev: dict) -> str:
    k = ev.get("kind")
    if k == "crown":
        return f"Crown: {ev.get('from') or 'none'} -> {ev.get('to')}"
    if k == "level":
        return f"LEVEL {ev.get('from')} -> {ev.get('to')} in the live spec"
    if k == "spec":
        return "Live spec changed: " + ", ".join(ev.get("fields") or [])
    if k == "head":
        return f"{ev.get('repo')} moved: {ev.get('message') or ''}"
    if k == "branch":
        return f"{ev.get('repo')}: branch {ev.get('branch')} {ev.get('change')}"
    if k == "gate":
        return f"Benchmark level gate ({ev.get('branch')}): max level {ev.get('from')} -> {ev.get('to')}"
    if k == "gate-factors":
        bits = []
        if ev.get("added"):
            bits.append("new factor " + ", ".join(f"{a} (level {l})" for a, l in ev["added"].items()))
        if ev.get("removed"):
            bits.append("removed " + ", ".join(ev["removed"]))
        if ev.get("moved"):
            bits.append("moved " + ", ".join(ev["moved"]))
        return f"Benchmark level gate ({ev.get('branch')}): " + "; ".join(bits)
    if k == "level-config":
        return f"Benchmark ({ev.get('branch')}): new level config " + ", ".join(ev.get("added") or [])
    if k == "spec-branch":
        s = ev.get("spec") or {}
        return (f"vector-orchestrator branch {ev.get('branch')}{' (new)' if ev.get('new') else ''}: spec level {s.get('level')}, "
                f"{s.get('tasks')} tasks, step ratio {s.get('step_ratio')}, margin {s.get('margin')}, {s.get('architecture')}")
    if k == "docs":
        return f"Docs changed ({', '.join(ev.get('fields') or [])}): Vector is at level {ev.get('level')}, next: {ev.get('next')}"
    if k == "repo":
        return f"New public repository: {ORG}/{ev.get('name')}"
    return json.dumps(ev)


def step(old: dict, hist: dict, heartbeat_min: int = HEARTBEAT_MIN, source: str = "action") -> dict:
    """One watch step on the last crown.json (`old`) and crown-history.json (`hist`).
    Returns {"crown", "history", "events", "alerts", "write"}; `write` says whether to store them."""
    at = now()
    new = snapshot()
    new["watch"] = watch(old.get("watch"))
    evs = events(old, new, at) + watch_events(old.get("watch"), new["watch"], at)
    alerts = [dict(e, text=describe(e)) for e in evs if is_alert(e)]
    keys = ("king", "kings", "kings_commit", "level", "spec", "heads")
    changed = {k: old.get(k) for k in keys} != {k: new.get(k) for k in keys} or bool(evs)
    stale = True
    if old.get("checked_at"):
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(old["checked_at"].replace("Z", "+00:00"))
        stale = age.total_seconds() >= heartbeat_min * 60
    new["checked_at"] = at
    new["checked_by"] = source
    new["changed_at"] = at if (changed or not old) else old.get("changed_at", at)
    new["alerts"] = ((old.get("alerts") or []) + alerts)[-KEEP_ALERTS:]
    hist = dict(hist or {})
    if evs:
        hist["events"] = ((hist.get("events") or []) + evs)[-300:]
    hist.setdefault("events", [])
    return {"crown": new, "history": hist, "events": evs, "alerts": alerts, "write": changed or stale}


def main() -> int:
    data = Path(sys.argv[1])
    crown_path, hist_path = data / "crown.json", data / "crown-history.json"
    old = json.loads(crown_path.read_text()) if crown_path.exists() else {}
    hist = json.loads(hist_path.read_text()) if hist_path.exists() else {"events": []}
    res = step(old, hist)
    for e in res["events"]:
        print("EVENT", describe(e))
    if not res["write"]:
        print("no change; heartbeat fresh")
        return 0
    crown_path.write_text(json.dumps(res["crown"], indent=2) + "\n")
    if res["events"] or not hist_path.exists():
        hist_path.write_text(json.dumps(res["history"], indent=2) + "\n")
    if res["alerts"]:
        # read by the workflow, which opens an issue so the owner is notified; never committed
        (data / "alerts_new.json").write_text(json.dumps(res["alerts"], indent=2) + "\n")
    print("written", "(changed)" if res["events"] else "(heartbeat)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
