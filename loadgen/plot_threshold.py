#!/usr/bin/env python3
"""Plots the -max-inflight threshold comparison for the report's "Optimize
the Threshold" section. The loadgen tool has no notion of the LB's threshold
(that's set on the LB side), so the three data points are wired up by hand
here rather than read from a column in the CSV.
"""
import csv
from pathlib import Path

import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "results" / "plots" / "threshold_comparison.png"

# (max-inflight threshold, experiment name, source CSV)
POINTS = [
    (4, "threshold4-c25", ROOT / "results" / "threshold-comparison.csv"),
    (8, "medium-load-c25", ROOT / "results" / "comparison.csv"),
    (16, "threshold16-c25", ROOT / "results" / "threshold-comparison.csv"),
]


def load_row(experiment, path):
    with path.open() as f:
        for row in csv.DictReader(f):
            if row["experiment"] == experiment:
                return row
    raise KeyError(f"{experiment} not found in {path}")


def main():
    thresholds, dropout, message_p95, feed_p95, throughput = [], [], [], [], []
    for threshold, experiment, path in POINTS:
        row = load_row(experiment, path)
        thresholds.append(threshold)
        dropout.append(float(row["dropout_percent"]))
        message_p95.append(float(row["message_p95_ms"]))
        feed_p95.append(float(row["feed_p95_ms"]))
        throughput.append(float(row["throughput_rps"]))

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4.5))

    ax1.plot(thresholds, dropout, "o-", color="firebrick", label="Dropout %")
    ax1.set_xlabel("-max-inflight threshold")
    ax1.set_ylabel("Dropout %")
    ax1.set_title("Dropout rate vs. overload threshold\n(same load profile: concurrency=25)")
    ax1.set_xticks(thresholds)
    ax1.grid(alpha=0.3)
    best_idx = dropout.index(min(dropout))
    ax1.annotate(
        f"best: {thresholds[best_idx]}",
        (thresholds[best_idx], dropout[best_idx]),
        textcoords="offset points",
        xytext=(0, -20),
        ha="center",
        color="firebrick",
        fontweight="bold",
    )

    ax2.plot(thresholds, throughput, "o-", color="steelblue")
    ax2.set_xlabel("-max-inflight threshold")
    ax2.set_ylabel("Throughput (rps)")
    ax2.set_title("Throughput vs. overload threshold")
    ax2.set_xticks(thresholds)
    ax2.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(OUT, dpi=150)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
