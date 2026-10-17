#!/bin/sh
# Resolve the bundled gesture project relative to this script, not the checkout path.
set -eu
gesture_root=$(CDPATH= cd -- "$(dirname -- "$0")/../gesture-furniture-demo" && pwd)
cd "$gesture_root"
case "${1:-dev}" in
  install) shift; exec npm ci "$@" ;;
  *) exec sh ./scripts/run.sh "$@" ;;
esac
