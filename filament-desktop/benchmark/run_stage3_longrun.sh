#!/usr/bin/env bash
# Long-run stability test: PC-04 at 2640x1200, 60 fps pacing, 10 minutes.
# Samples per-process VRAM (1 Hz) and GPU temperature/clocks/power (every 5 s).
#
# Usage: bash run_stage3_longrun.sh            # 600 s, PCSS
#        DURATION=900 SHADOW=dpcf bash run_stage3_longrun.sh

set -u

SCENE=/d/FilamentDesktop/scene
BENCH=/d/FilamentDesktop/benchmark
EXE="$SCENE/out/room_viewer.exe"
SAMPLER="$BENCH/sample_gpu_mem.ps1"

DURATION=${DURATION:-600}
SHADOW=${SHADOW:-pcss}
WARMUP=${WARMUP:-5}
WIDTH=${WIDTH:-2640}
HEIGHT=${HEIGHT:-1200}
FPS=${FPS:-60}

LOG="$BENCH/logs/pc04_long.log"
FRAMES="$BENCH/frames_pc04_long.csv"
VRAM="$BENCH/vram_pc04_long.csv"
GPUSTAT="$BENCH/gpu_pc04_long.csv"
SUMMARY="$BENCH/summary_stage3_long.csv"
mkdir -p "$BENCH/logs"

: > "$LOG"
"$EXE" --headless --no-input --preset=p4 --shadow-type="$SHADOW" \
    --duration="$DURATION" --warmup="$WARMUP" --max-fps="$FPS" \
    --width="$WIDTH" --height="$HEIGHT" --gpu-hint=NVIDIA \
    --label=pc04_long --csv="$SUMMARY" --frame-csv="$FRAMES" \
    > "$LOG" 2>&1 &
viewer_pid=$!

pid=""
for _ in $(seq 1 150); do
    pid=$(grep -o '\[proc\] pid=[0-9]*' "$LOG" 2>/dev/null | head -n1 | cut -d= -f2)
    [ -n "$pid" ] && break
    sleep 0.1
done

if [ -n "$pid" ]; then
    # Match a foreground app: background processes get power-throttled and their
    # sleep-based pacing can stall for hundreds of milliseconds.
    powershell -NoProfile -Command "(Get-Process -Id $pid).PriorityClass='High'" \
        > /dev/null 2>&1
    # 15 s cadence: the WMI query costs ~15 ms, which is invisible at this rate
    # but would bias the frame pacing at 1 Hz.
    powershell -NoProfile -ExecutionPolicy Bypass -File "$SAMPLER" \
        -ProcessId "$pid" -DurationSec "$((DURATION + 15))" -IntervalSec 15 -Out "$VRAM" \
        > /dev/null 2>&1 &
else
    echo "WARN: no pid line" >&2
fi

echo "timestamp,temp_c,sm_clock_mhz,power_w,util_pct,mem_used_mb" > "$GPUSTAT"
while kill -0 "$viewer_pid" 2>/dev/null; do
    line=$(nvidia-smi --query-gpu=temperature.gpu,clocks.sm,power.draw,utilization.gpu,memory.used \
        --format=csv,noheader,nounits 2>/dev/null | head -n1 | tr -d ' ')
    [ -n "$line" ] && echo "$(date +%H:%M:%S),$line" >> "$GPUSTAT"
    sleep 15
done

wait "$viewer_pid"
echo "LONGRUN COMPLETE shadow=$SHADOW duration=${DURATION}s"
