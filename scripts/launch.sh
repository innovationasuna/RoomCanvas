#!/usr/bin/env bash
set -euo pipefail
mv_code_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$mv_code_root/scripts/env.sh"
exec python "$mv_code_root/scripts/run.py" "$@"
