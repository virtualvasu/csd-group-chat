#!/usr/bin/env python3
"""Generates the two plots the assignment's report requires: response time
(from loadgen's comparison.csv) and system utilization of all 4 systems
(from monitor.sh's CSVs). Run from loadgen/ with the venv's python:

    .venv/bin/python plot_report.py
"""
import csv
import datetime as dt
from pathlib import Path

import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent
RESULTS_CSV = ROOT / "results" / "comparison.csv"
MONITOR_DIR = ROOT.parent / "monitor_results"
OUT_DIR = ROOT / "results" / "plots"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Only the in-scope, controlled response-time runs (low/medium/higher load).
# The high-c80 / high-c80-retest rows were exploratory stress-test data used
# to find and verify the health-check flapping fix, not part of the
# assignment's requested response-time-vs-load curve.
RESPONSE_TIME_EXPERIMENTS = ["low-load-c10", "medium-load-c25", "higher-load-c50"]

MONITOR_FILES = {
    "Sys1 (Load Balancer)": MONITOR_DIR / "lb",
    "Sys2 (Backend)": MONITOR_DIR / "server1",
    "Sys3 (Backend)": MONITOR_DIR / "server2",
    "Sys4 (Backend)": MONITOR_DIR / "server3",
}


def load_comparison_rows():
    with RESULTS_CSV.open() as f:
        rows = list(csv.DictReader(f))
    by_experiment = {r["experiment"]: r for r in rows}
    return [by_experiment[name] for name in RESPONSE_TIME_EXPERIMENTS if name in by_experiment]


def plot_response_time(rows):
    concurrency = [int(r["concurrency"]) for r in rows]
    message_p50 = [float(r["message_p50_ms"]) for r in rows]
    message_p95 = [float(r["message_p95_ms"]) for r in rows]
    feed_p50 = [float(r["feed_p50_ms"]) for r in rows]
    feed_p95 = [float(r["feed_p95_ms"]) for r in rows]
    dropout = [float(r["dropout_percent"]) for r in rows]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4.5))

    ax1.plot(concurrency, message_p50, "o-", label="/message p50")
    ax1.plot(concurrency, message_p95, "o--", label="/message p95")
    ax1.plot(concurrency, feed_p50, "s-", label="/feed p50")
    ax1.plot(concurrency, feed_p95, "s--", label="/feed p95")
    ax1.set_xlabel("Concurrent workers (loadgen -concurrency)")
    ax1.set_ylabel("Response time (ms)")
    ax1.set_title("Response time vs. load")
    ax1.legend(fontsize=8)
    ax1.grid(alpha=0.3)

    ax2.plot(concurrency, dropout, "o-", color="firebrick")
    ax2.set_xlabel("Concurrent workers (loadgen -concurrency)")
    ax2.set_ylabel("Dropout %")
    ax2.set_title("Dropout rate vs. load")
    ax2.grid(alpha=0.3)

    fig.tight_layout()
    out = OUT_DIR / "response_time.png"
    fig.savefig(out, dpi=150)
    print(f"wrote {out}")


def parse_ts(s):
    return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ")


def load_monitor(path):
    times, cpu, mem = [], [], []
    with path.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            times.append(parse_ts(row["timestamp"]))
            cpu.append(float(row["cpu_percent"]))
            mem.append(float(row["mem_percent"]))
    return times, cpu, mem


def plot_utilization():
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 7), sharex=True)

    for label, path in MONITOR_FILES.items():
        if not path.exists():
            continue
        times, cpu, mem = load_monitor(path)
        ax1.plot(times, cpu, label=label, linewidth=1)
        ax2.plot(times, mem, label=label, linewidth=1)

    ax1.set_ylabel("CPU %")
    ax1.set_title("CPU utilization during load testing — all 4 systems")
    ax1.legend(fontsize=8)
    ax1.grid(alpha=0.3)

    ax2.set_ylabel("Memory %")
    ax2.set_xlabel("Time (UTC)")
    ax2.set_title("Memory utilization during load testing — all 4 systems")
    ax2.legend(fontsize=8)
    ax2.grid(alpha=0.3)

    fig.autofmt_xdate()
    fig.tight_layout()
    out = OUT_DIR / "system_utilization.png"
    fig.savefig(out, dpi=150)
    print(f"wrote {out}")


if __name__ == "__main__":
    rows = load_comparison_rows()
    if rows:
        plot_response_time(rows)
    else:
        print("no matching rows in comparison.csv, skipping response-time plot")

    plot_utilization()
