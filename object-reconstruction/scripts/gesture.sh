#!/bin/sh
# Compatibility entry for commands issued from the object-reconstruction module.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec sh "$repo_root/scripts/gesture.sh" "$@"
