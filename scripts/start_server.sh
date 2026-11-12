#!/usr/bin/env bash
# Start the room service, the object service and the gateway on the GPU server; the ones already healthy are left alone.
#   bash scripts/start_server.sh [--object-host ADDR]     start whatever is not running, then print the status
#   bash scripts/start_server.sh --preview                no GPU: browse rooms, objects and replays, no reconstruction
#   bash scripts/start_server.sh status                   print the status only
# Without a visible NVIDIA GPU the script starts in preview mode by itself.
# The computer then runs: python3 web/scripts/serve.py --ssh <SSH host>
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOMCANVAS_HOME="${ROOMCANVAS_HOME:-$REPO}"
# A machine's own settings (caches and temp files kept in one place, download mirrors), if it has any.
# shellcheck source=/dev/null
[ -f "$ROOMCANVAS_HOME/runtime/server-env.sh" ] && . "$ROOMCANVAS_HOME/runtime/server-env.sh"
OBJECT_HOST=127.0.0.1
ACTION=start
PREVIEW=0
while [ $# -gt 0 ]; do
    case "$1" in
        status) ACTION=status ;;
        --preview) PREVIEW=1 ;;
        --object-host) OBJECT_HOST="${2:?--object-host needs an address}"; shift ;;
        *) echo "usage: start_server.sh [status] [--preview] [--object-host ADDR]" >&2; exit 2 ;;
    esac
    shift
done
ROOM_PORT=7866 OBJECT_PORT=7862 GATEWAY_PORT=7870
DATA="$ROOMCANVAS_HOME/runs/web-room-jobs"

healthy() {  # healthy <host> <port> <path>
    python3 -c 'import sys,urllib.request; urllib.request.urlopen(f"http://{sys.argv[1]}:{sys.argv[2]}{sys.argv[3]}", timeout=3)' "$@" 2>/dev/null
}

start() {  # start <name> <host> <port> <health path> <log> <command...>
    local name=$1 host=$2 port=$3 path=$4 log=$5; shift 5
    if healthy "$host" "$port" "$path"; then echo "$name: already running ($host:$port)"; return; fi
    mkdir -p "$(dirname "$log")"
    setsid nohup "$@" >> "$log" 2>&1 < /dev/null &
    for _ in $(seq 60); do
        healthy "$host" "$port" "$path" && { echo "$name: started ($host:$port), log $log"; return; }
        sleep 2
    done
    echo "$name: NOT healthy after 120 s, see $log" >&2; return 1
}

FAILED=0
if [ "$ACTION" = start ]; then
    if [ $PREVIEW = 0 ] && ! nvidia-smi -L 2>/dev/null | grep -q '^GPU'; then
        echo "No NVIDIA GPU visible: starting in preview mode (browse only, no reconstruction)."
        PREVIEW=1
    fi
    MODE=(); [ $PREVIEW = 1 ] && MODE=(--preview)
    mkdir -p "$DATA"
    start "room service" 127.0.0.1 $ROOM_PORT /room-reconstruction/health "$DATA/service.log" \
        "$ROOMCANVAS_HOME/runtime/litereality-env/bin/python" "$REPO/web/scripts/room_service.py" --port $ROOM_PORT --data-dir "$DATA" ${MODE[@]+"${MODE[@]}"} || FAILED=1
    (
        cd "$REPO/object-reconstruction"
        if [ -f configs/local.env ]; then
            source configs/local.env
        elif [ $PREVIEW = 1 ]; then
            export VIEWFORGE_ROOT="$ROOMCANVAS_HOME/runtime/object-reconstruction"
        else
            echo "object service: configs/local.env is missing; run the objects setup first" >&2; exit 1
        fi
        # Preview: the object service only serves the catalog and models, so hide any GPU from it.
        [ $PREVIEW = 1 ] && export CUDA_VISIBLE_DEVICES=-1
        source scripts/env.sh
        start "object service" "$OBJECT_HOST" $OBJECT_PORT /health "$VIEWFORGE_ROOT/logs/web.log" \
            python scripts/web.py --host "$OBJECT_HOST" --port $OBJECT_PORT
    ) || FAILED=1
    start "gateway" 127.0.0.1 $GATEWAY_PORT /room-reconstruction/health "$DATA/gateway.log" \
        python3 "$REPO/web/scripts/gateway.py" --port $GATEWAY_PORT --objects "$OBJECT_HOST:$OBJECT_PORT" --rooms 127.0.0.1:$ROOM_PORT ${MODE[@]+"${MODE[@]}"} || FAILED=1
else
    for item in "room service:127.0.0.1:$ROOM_PORT:/room-reconstruction/health" "object service:$OBJECT_HOST:$OBJECT_PORT:/health" "gateway:127.0.0.1:$GATEWAY_PORT:/room-reconstruction/health"; do
        IFS=: read -r name host port path <<< "$item"
        if healthy "$host" "$port" "$path"; then echo "$name: ok ($host:$port)"; else echo "$name: DOWN ($host:$port)"; FAILED=1; fi
    done
fi
exit $FAILED
