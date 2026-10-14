#!/usr/bin/env bash
# Show provider request records and summarize cost and cache by provider and model.
#
#   provider-cost-tracer.sh [N]            last N records (default 10) + summary of those N
#   provider-cost-tracer.sh --total_cost    cost/cache summary over the whole log
#   provider-cost-tracer.sh --reset         clear the log
set -euo pipefail

python3 - "${1:-10}" <<'PY'
import sys, json

log = "/tmp/opencode/provider-cost-tracer/index.jsonl"
arg = sys.argv[1] if len(sys.argv) > 1 else "10"

if arg == "--reset":
    open(log, "w").close()
    print("Cleared", log)
    raise SystemExit(0)

total_only = arg == "--total_cost"
limit = int(arg) if not total_only else 0

try:
    lines = [l for l in open(log, encoding="utf-8").read().splitlines() if l]
except FileNotFoundError:
    print("No trace log found at", log)
    raise SystemExit(0)

records = []
for line in lines:
    try:
        o = json.loads(line)
    except ValueError:
        continue
    r = o.get("response") or {}
    records.append({
        "ts": o.get("ts", ""),
        "model": o.get("model") or "-",
        "provider": r.get("provider") or o.get("providerID") or "-",
        "in": r.get("input_tokens") or 0,
        "out": r.get("output_tokens") or 0,
        "cache": r.get("cache_read_tokens") or 0,
        "cost": r.get("cost"),
    })

if not records:
    print("No trace records yet.")
    raise SystemExit(0)


def left(s, w):
    s = str(s)
    return (s[:w] if len(s) > w else s).ljust(w)


def right(v, w):
    return str(v).rjust(w)


def cost_fmt(c):
    return f"{c:.8f}" if c is not None else "-"


W = {"n": 5, "in": 8, "out": 8, "cache": 9, "cost": 12}
LABEL = 32


def rec_header():
    return (f"{left('TIME', 26)}  {left('MODEL', 30)}  {left('PROVIDER', 16)}  "
            f"{right('IN', W['in'])}  {right('OUT', W['out'])}  {right('CACHE', W['cache'])}  {right('COST', W['cost'])}")


def rec_row(rec):
    return (f"{left(rec['ts'], 26)}  {left(rec['model'], 30)}  {left(rec['provider'], 16)}  "
            f"{right(rec['in'], W['in'])}  {right(rec['out'], W['out'])}  {right(rec['cache'], W['cache'])}  {right(cost_fmt(rec['cost']), W['cost'])}")


def summarize(recs):
    providers = {}
    for rec in recs:
        p = providers.setdefault(rec["provider"], {"n": 0, "in": 0, "out": 0, "cache": 0, "cost": 0.0, "models": {}})
        m = p["models"].setdefault(rec["model"], {"n": 0, "in": 0, "out": 0, "cache": 0, "cost": 0.0})
        for t in (p, m):
            t["n"] += 1
            t["in"] += rec["in"]
            t["out"] += rec["out"]
            t["cache"] += rec["cache"]
            if rec["cost"] is not None:
                t["cost"] += rec["cost"]
    return providers


def sum_header():
    return (f"  {left('PROVIDER / MODEL', LABEL)}  {right('N', W['n'])}  {right('IN', W['in'])}  "
            f"{right('OUT', W['out'])}  {right('CACHE', W['cache'])}  {right('COST', W['cost'])}")


def sum_row(label, t):
    return (f"  {left(label, LABEL)}  {right(t['n'], W['n'])}  {right(t['in'], W['in'])}  "
            f"{right(t['out'], W['out'])}  {right(t['cache'], W['cache'])}  {right(cost_fmt(t['cost']), W['cost'])}")


def print_summary(title, recs):
    print(title)
    print(sum_header())
    providers = summarize(recs)
    grand = {"n": 0, "in": 0, "out": 0, "cache": 0, "cost": 0.0}
    for p, t in sorted(providers.items(), key=lambda kv: -kv[1]["cost"]):
        print(sum_row(p, t))
        for m, mt in sorted(t["models"].items(), key=lambda kv: -kv[1]["cost"]):
            print(sum_row("  " + m, mt))
        for k in ("n", "in", "out", "cache"):
            grand[k] += t[k]
        grand["cost"] += t["cost"]
    print(sum_row("TOTAL", grand))


if total_only:
    print_summary(f"cost by provider and model (all {len(records)} requests):", records)
    raise SystemExit(0)

window = records[-limit:]

print(rec_header())
for rec in reversed(window):
    print(rec_row(rec))

print()
print_summary(f"cost by provider and model (last {len(window)}):", window)
PY