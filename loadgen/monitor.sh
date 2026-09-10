#!/usr/bin/env bash
# Samples this machine's CPU and memory utilization once per second and
# appends it to a CSV, for the assignment's "system utilization of all 4
# systems" report requirement. Pure /proc parsing so it has no dependency on
# tools that may not be installed (top, vmstat, sysstat).
#
# Run this on each of the 4 systems (the load-balancer machine and the 3
# backend machines) for the duration of a loadgen run, then collect the CSVs
# to plot alongside loadgen's own latency/throughput numbers.
#
# Usage: ./monitor.sh <label> [output_csv] [interval_seconds]
#   label      Identifies this system in the CSV (e.g. sys1-lb, sys2-backend)
#   output_csv Defaults to monitor-<label>.csv in the current directory
#   interval   Seconds between samples, default 1
#
# Stop it with Ctrl+C once the corresponding loadgen run has finished.

set -euo pipefail

LABEL="${1:?usage: $0 <label> [output_csv] [interval_seconds]}"
OUT="${2:-monitor-${LABEL}.csv}"
INTERVAL="${3:-1}"

read_cpu_total_idle() {
  # First line of /proc/stat: cpu  user nice system idle iowait irq softirq steal guest guest_nice
  read -r _ user nice system idle iowait irq softirq steal _ _ < /proc/stat
  local idle_all=$((idle + iowait))
  local total=$((user + nice + system + idle_all + irq + softirq + steal))
  echo "$total $idle_all"
}

mem_used_percent() {
  awk '
    /^MemTotal:/     { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END              { if (total > 0) printf "%.2f", (total - avail) * 100.0 / total; else print "0" }
  ' /proc/meminfo
}

needs_header=1
[ -f "$OUT" ] && needs_header=0
if [ "$needs_header" -eq 1 ]; then
  echo "timestamp,label,cpu_percent,mem_percent" > "$OUT"
fi

echo "Sampling every ${INTERVAL}s into $OUT (label=$LABEL). Press Ctrl+C to stop."

read -r prev_total prev_idle < <(read_cpu_total_idle)

while true; do
  sleep "$INTERVAL"

  read -r total idle < <(read_cpu_total_idle)
  d_total=$((total - prev_total))
  d_idle=$((idle - prev_idle))
  prev_total=$total
  prev_idle=$idle

  if [ "$d_total" -gt 0 ]; then
    cpu_pct=$(awk -v dt="$d_total" -v di="$d_idle" 'BEGIN { printf "%.2f", (dt - di) * 100.0 / dt }')
  else
    cpu_pct="0.00"
  fi

  mem_pct=$(mem_used_percent)
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  echo "${ts},${LABEL},${cpu_pct},${mem_pct}" >> "$OUT"
done
