#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
runtime_node=$(command -v node || true)
if [ -z "$runtime_node" ]; then
 runtime_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [ ! -x "$runtime_node" ]; then
 echo '请先安装 Node.js 22.12+ 或 24 LTS。' >&2
 exit 1
fi
case "${1:-dev}" in
 dev) exec "$runtime_node" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 8800 --strictPort ;;
 preview) exec "$runtime_node" node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 8800 --strictPort ;;
 test) exec "$runtime_node" node_modules/vitest/vitest.mjs run ;;
 build) "$runtime_node" node_modules/typescript/bin/tsc --noEmit; exec "$runtime_node" node_modules/vite/bin/vite.js build ;;
 resources) exec "$runtime_node" scripts/check-resources.mjs ;;
 *) echo '用法：./scripts/run.sh dev|preview|test|build|resources' >&2; exit 2 ;;
esac
