#!/usr/bin/env bash
set -euo pipefail
CODE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${VIEWFORGE_ROOT:?Set VIEWFORGE_ROOT to the external runtime directory}"
ENV_DIR="$VIEWFORGE_ROOT/envs/birefnet"
export TMPDIR="$VIEWFORGE_ROOT/cache/birefnet/tmp"
export PIP_CACHE_DIR="$VIEWFORGE_ROOT/cache/birefnet/pip"
mkdir -p "$TMPDIR" "$PIP_CACHE_DIR"
python3 -m venv "$ENV_DIR"
"$ENV_DIR/bin/python" -m pip install -r "$CODE_ROOT/configs/birefnet-requirements.txt"
"$ENV_DIR/bin/python" - "$CODE_ROOT/configs/birefnet.json" "$VIEWFORGE_ROOT/weights/birefnet" <<'PY'
import json, sys
from pathlib import Path
from huggingface_hub import snapshot_download
config = json.loads(Path(sys.argv[1]).read_text())
marker = Path(sys.argv[2], 'viewforge_revision.json')
if marker.exists() and json.loads(marker.read_text()) != {key: config[key] for key in ('model_id', 'revision')}:
    raise SystemExit('Existing BiRefNet revision differs; preserve it and use a separate weights directory')
if marker.exists() and json.loads(marker.read_text()) == {key: config[key] for key in ('model_id', 'revision')} and all(Path(sys.argv[2], name).is_file() for name in ('config.json', 'birefnet.py', 'BiRefNet_config.py', 'model.safetensors')):
    print('Pinned BiRefNet snapshot already present')
    sys.exit(0)
snapshot_download(repo_id=config['model_id'], revision=config['revision'], local_dir=sys.argv[2], allow_patterns=['*.py', 'config.json', 'model.safetensors', 'README.md', 'requirements.txt'])
Path(sys.argv[2], 'revision.txt').write_text(config['revision'] + '\n')
Path(sys.argv[2], 'viewforge_revision.json').write_text(json.dumps({key: config[key] for key in ('model_id', 'revision')}, indent=2) + '\n')
PY
