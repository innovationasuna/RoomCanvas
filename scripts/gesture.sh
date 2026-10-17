#!/bin/sh
# Keep the gesture project independent of the checkout's absolute location.
set -eu
gesture_root=$(CDPATH= cd -- "$(dirname -- "$0")/../gesture" && pwd)
cd "$gesture_root"
case "${1:-dev}" in
  install) shift; exec npm ci "$@" ;;
  *) exec sh ./scripts/run.sh "$@" ;;
esac
