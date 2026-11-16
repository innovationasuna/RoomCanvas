#!/usr/bin/env bash
# Stage 3 benchmark driver: PC-01 .. PC-04 x shadow types at 2640x1200.
#
# Usage: bash run_stage3_matrix.sh <paced|uncapped>
#   paced    --max-fps=60, duration 40 s (60 FPS acceptance run)
#   uncapped --max-fps=0,  duration 20 s (throughput ceiling run)
#
# For each case it starts room_viewer.exe, reads the "[proc] pid=" line it
# prints, samples that process's GPU memory once per second, and appends one
# summary row to summary_stage3_<mode>.csv.

set -u

SCENE=/d/FilamentDesktop/scene
BENCH=/d/FilamentDesktop/benchmark
EXE="$SCENE/out/room_viewer.exe"
SAMPLER="$BENCH/sample_gpu_mem.ps1"

MODE=${1:-paced}
case "$MODE" in
    paced)
        DURATION=${DURATION:-40}
        FPS=${FPS:-60}
        ;;
    uncapped)
        DURATION=${DURATION:-20}
        FPS=${FPS:-0}
        ;;
    *)
        echo "usage: $0 <paced|uncapped>" >&2
        exit 2
        ;;
esac

WARMUP=${WARMUP:-5}
WIDTH=${WIDTH:-2640}
HEIGHT=${HEIGHT:-1200}
SUMMARY="$BENCH/summary_stage3_${MODE}.csv"
LOGDIR="$BENCH/logs"
mkdir -p "$LOGDIR"

run_case() {
    local label="$1" preset="$2" shadow="$3"
    local log="$LOGDIR/${label}_${MODE}.log"
    local framecsv="$BENCH/frames_${label}_${MODE}.csv"
    local vramcsv="$BENCH/vram_${label}_${MODE}.csv"

    : > "$log"
    "$EXE" --headless --no-input --preset="$preset" --shadow-type="$shadow" \
        --duration="$DURATION" --warmup="$WARMUP" --max-fps="$FPS" \
        --width="$WIDTH" --height="$HEIGHT" --gpu-hint=NVIDIA \
        --label="$label" --csv="$SUMMARY" --frame-csv="$framecsv" \
        > "$log" 2>&1 &
    local viewer_pid=$!

    local pid=""
    for _ in $(seq 1 150); do
        pid=$(grep -o '\[proc\] pid=[0-9]*' "$log" 2>/dev/null | head -n1 | cut -d= -f2)
        [ -n "$pid" ] && break
        sleep 0.1
    done

    if [ -n "$pid" ]; then
        # Background processes are subject to Windows power throttling, which can
        # delay sleep-based pacing by hundreds of milliseconds. A real foreground
        # app is not throttled, so raise priority to match that environment.
        powershell -NoProfile -Command "(Get-Process -Id $pid).PriorityClass='High'" \
            > /dev/null 2>&1
        # The WMI GPU-memory query itself costs ~15 ms once per second and shows
        # up as a 29 ms pace spike every second, so it is off by default for the
        # timing matrix. VRAM is static after load; sample it in a separate pass
        # with VRAM_SAMPLE=1.
        if [ "${VRAM_SAMPLE:-0}" = "1" ]; then
            powershell -NoProfile -ExecutionPolicy Bypass -File "$SAMPLER" \
                -ProcessId "$pid" -DurationSec "$((DURATION + 15))" -Out "$vramcsv" \
                > /dev/null 2>&1
        fi
    else
        echo "WARN: no pid line for $label" >&2
    fi

    wait "$viewer_pid"
    local status=$?
    if [ "$status" -ne 0 ]; then
        echo "FAIL $label exit=$status" >&2
    else
        echo "DONE $label"
    fi
}

# Warm the GPU (clocks/power state) before the first measured case so the
# first preset is not penalised by a cold device.
if [ "${PREHEAT:-1}" = "1" ]; then
    echo "PREHEAT 20s"
    "$EXE" --headless --no-input --preset=p4 --shadow-type=pcss \
        --duration=20 --warmup=0 --max-fps=0 \
        --width="$WIDTH" --height="$HEIGHT" --gpu-hint=NVIDIA \
        --label=preheat > "$LOGDIR/preheat.log" 2>&1
fi

run_case pc01_p1       p1 pcss
run_case pc02_p2       p2 pcss
run_case pc03_pcss     p3 pcss
run_case pc03_dpcf     p3 dpcf
run_case pc03_pcf      p3 pcf
run_case pc04_pcss     p4 pcss
run_case pc04_dpcf     p4 dpcf
run_case pc04_pcf      p4 pcf

echo "MATRIX $MODE COMPLETE"
