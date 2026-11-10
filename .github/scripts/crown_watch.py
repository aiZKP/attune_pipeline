#!/usr/bin/env python3
"""Crown watch (public facts only): kings.json of robotensor/vector-kings, the vector-orchestrator spec, and
the heads of the repos the pipeline pins. Writes crown.json and crown-history.json into the data checkout.

Commits happen only when something changed, or as an hourly heartbeat, so the data branch stays small.
Usage: crown_watch.py <data-dir>
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import urllib.request
from pathlib import Path

HF = "https://huggingface.co"
KINGS_REPO = "robotensor/vector-kings"
HEADS = {
    "vector-orchestrator": ("robotensor/vector-orchestrator", "main"),
    "RoboTwin-Vector": ("robotensor/RoboTwin-Vector", "vector"),
    "attune-subnet": ("robotensor/attune-subnet", "main"),
}
HEARTBEAT_MIN = 55


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def get(url: str, github: bool = False):
    headers = {"User-Agent": "attune-crown-watch"}
    token = os.environ.get("GITHUB_TOKEN")
    if github and token:
        headers["Authorization"] = f"Bearer {token}"
        headers["Accept"] = "application/vnd.github+json"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
        return json.loads(r.read())


def snapshot() -> dict:
    kings = get(f"{HF}/{KINGS_REPO}/resolve/main/kings.json")
    info = get(f"{HF}/api/models/{KINGS_REPO}")
    heads = {}
    for name, (repo, branch) in HEADS.items():
        d = get(f"https://api.github.com/repos/{repo}/commits/{branch}", github=True)
        heads[name] = {"sha": d["sha"], "date": d["commit"]["committer"]["date"],
                       "message": d["commit"]["message"].splitlines()[0][:120], "branch": branch}
    orch = heads["vector-orchestrator"]["sha"]
    spec = get(f"https://raw.githubusercontent.com/robotensor/vector-orchestrator/{orch}/spec.json")
    ks = sorted(kings.get("kings", []), key=lambda k: k.get("place", 99))
    return {
        "king": ks[0] if ks else None,
        "kings": ks,
        "kings_commit": info.get("sha"),
        "level": spec.get("level"),
        "spec": {
            "version": spec.get("version"),
            "sha": orch,
            "level": spec.get("level"),
            "margin": (spec.get("crown") or {}).get("margin"),
            "max_void": (spec.get("crown") or {}).get("max_void"),
            "runs_per_task": spec.get("runs_per_task"),
            "step_ratio": spec.get("step_ratio"),
            "tasks": len(spec.get("tasks") or []),
            "architecture": (spec.get("model") or {}).get("architecture"),
        },
        "heads": heads,
    }


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


def main() -> int:
    data = Path(sys.argv[1])
    crown_path, hist_path = data / "crown.json", data / "crown-history.json"
    old = json.loads(crown_path.read_text()) if crown_path.exists() else {}
    hist = json.loads(hist_path.read_text()) if hist_path.exists() else {"events": []}
    at = now()
    new = snapshot()
    evs = events(old, new, at)
    substantive_old = {k: old.get(k) for k in ("king", "kings", "kings_commit", "level", "spec", "heads")}
    changed = substantive_old != new
    last = old.get("checked_at")
    stale = True
    if last:
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(last.replace("Z", "+00:00"))
        stale = age.total_seconds() >= HEARTBEAT_MIN * 60
    if not changed and not stale:
        print("no change; heartbeat fresh")
        return 0
    new["checked_at"] = at
    new["changed_at"] = at if (changed or not old) else old.get("changed_at", at)
    crown_path.write_text(json.dumps(new, indent=2) + "\n")
    if evs:
        hist["events"] = (hist.get("events") or []) + evs
        hist["events"] = hist["events"][-200:]
        hist_path.write_text(json.dumps(hist, indent=2) + "\n")
    elif not hist_path.exists():
        hist_path.write_text(json.dumps(hist, indent=2) + "\n")
    for e in evs:
        print("EVENT", json.dumps(e))
    print("written", "(changed)" if changed else "(heartbeat)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
