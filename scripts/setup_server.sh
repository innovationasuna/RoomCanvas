#!/usr/bin/env bash
# Also supports: sh scripts/setup_server.sh [all|rooms|objects] [--dry-run]
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set +x
set -euo pipefail

# Shared helpers are sourced by the two standalone setup scripts. Sourcing does
# not run preflight, create directories, or start either installer.
SETUP_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOMCANVAS_HOME="${ROOMCANVAS_HOME:-$SETUP_REPO}"
# Do not export a default here: child setup must distinguish an explicit value
# from the default before reading configs/local.env.
export PYTHONDONTWRITEBYTECODE=1

setup_init() {
    DRY_RUN=0
    STEP=0
    for arg in "$@"; do
        case "$arg" in
            --dry-run) DRY_RUN=1 ;;
            *) printf 'ERROR: unknown argument: %s\n' "$arg" >&2; exit 2 ;;
        esac
    done
    case "$ROOMCANVAS_HOME" in
        /*) ;;
        *) fail 'ROOMCANVAS_HOME must be an absolute path.' ;;
    esac
    # Never trace private configuration or token values.
    umask 077
}
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { STEP=$((STEP + 1)); printf '\n[%s] %s\n' "$STEP" "$*"; }
show() { printf '  +'; printf ' %q' "$@"; printf '\n'; }
run() {
    show "$@"
    if (( ! DRY_RUN )); then
        "$@" || fail "Command failed (${SETUP_ACTION:-setup}: ${SETUP_TARGET:-current step}). Pre-existing directories are verification-only; inspect the error or choose a new runtime root."
    fi
}
exists() { [[ -e "$1" || -L "$1" ]]; }
skip() { printf '  SKIP existing: %s (preserved)\n' "$1"; }
ensure_dir() {
    local path
    for path in "$@"; do
        if exists "$path"; then
            [[ -d "$path" ]] || fail "Expected a directory at $path; existing path was preserved."
            skip "$path"
        else run mkdir -p "$path"; fi
    done
}
need_value() {
    local name="$1" reason="$2"
    if [[ -z "${!name}" ]]; then
        printf '  REQUIRED: export %s — %s\n' "$name" "$reason"
        if (( ! DRY_RUN )); then fail "Confirm $name before setup; see the variables at the top of the component script."; fi
    fi
}
require_file() {
    if (( DRY_RUN )); then show test -s "$1";
    elif [[ ! -s "$1" ]]; then fail "Missing or empty: $1. Existing paths were preserved; inspect the incomplete result or select a new runtime root."; fi
}
preflight() {
    local target="$1" disk_path="$1" tool actual minimum
    step 'Preflight: Linux x86_64, NVIDIA GPU, tools, uv version, disk space'
    printf '  Target: %s\n' "$target"
    while [[ ! -d "$disk_path" && "$disk_path" != / ]]; do disk_path=$(dirname "$disk_path"); done
    # Read-only even in dry-run. No guessed capacity threshold is imposed.
    df -Pk "$disk_path"
    printf '  Free space is shown in 1K blocks; reserve space for all model snapshots and CUDA builds. No repository disk budget is specified.\n'
    CONDA=conda
    if ! command -v conda >/dev/null 2>&1 && command -v mamba >/dev/null 2>&1; then CONDA=mamba; fi
    minimum=$(sed -n 's/^required-version = ">=\([^"]*\)"/\1/p' "$SETUP_REPO/room-reconstruction/pyproject.toml")
    [[ -n "$minimum" ]] || fail 'Cannot read uv required-version from room-reconstruction/pyproject.toml.'
    if (( DRY_RUN )); then
        printf '  DRY-RUN: require Linux x86_64, working nvidia-smi, git, python3, conda (or mamba), uv >= %s. Checks do not block this Mac.\n' "$minimum"
        show nvidia-smi
        show uv --version
        return
    fi
    [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Use a Linux x86_64 NVIDIA GPU server; the checked-in environments and Blender layout are x86_64.'
    for tool in git python3 nvidia-smi "$CONDA" uv; do
        command -v "$tool" >/dev/null 2>&1 || fail "Missing $tool. Provision this prerequisite, then rerun (conda or mamba is accepted)."
    done
    nvidia-smi >/dev/null || fail 'nvidia-smi failed. Fix the NVIDIA driver / GPU visibility first.'
    actual=$(uv --version)
    python3 - "$minimum" "$actual" <<'PY'
import re, sys
required = tuple(map(int, sys.argv[1].split('.')))
match = re.search(r'\b(\d+)\.(\d+)\.(\d+)\b', sys.argv[2])
if not match or tuple(map(int, match.groups())) < required:
    raise SystemExit('Upgrade uv to >= ' + sys.argv[1] + ' before rerunning setup.')
PY
}
# A marker belongs to one installable directory, never a shared parent. A
# pre-existing directory is not adopted, even after successful verification.
setup_begin() {
    SETUP_TARGET="$1"
    SETUP_ACTION=install
    if [[ -f "$1/.roomcanvas-setup-complete" ]]; then
        SETUP_ACTION=skip
        printf '  SKIP complete: %s\n' "$1"
    elif exists "$1"; then
        [[ -d "$1" && ! -L "$1" ]] || {
            SETUP_ACTION=verify
            printf '  PRE-EXISTING: %s (verify-only; preserved)\n' "$1"
            return
        }
        if [[ -f "$1/.roomcanvas-setup-incomplete" ]]; then
            printf '  REDO incomplete: %s\n' "$1"
        else
            SETUP_ACTION=verify
            printf '  PRE-EXISTING: %s (verify-only; preserved)\n' "$1"
        fi
    fi
    if [[ "$SETUP_ACTION" == install ]]; then
        run mkdir -p "$1"
        run touch "$1/.roomcanvas-setup-incomplete"
    fi
}
setup_finish() {
    if [[ "$SETUP_ACTION" == install ]]; then
        # Rename only after every verification for this step has succeeded.
        run mv "$1/.roomcanvas-setup-incomplete" "$1/.roomcanvas-setup-complete"
    fi
}
resolve_viewforge_root() {
    local config="$1" explicit="${VIEWFORGE_ROOT:-}" configured
    if exists "$config"; then
        # Read only the root in a subshell. Keep all other private values out of
        # the parent environment and command output.
        configured=$(bash -c 'set +x; set -e; unset VIEWFORGE_ROOT; source "$1" >/dev/null; printf "%s" "${VIEWFORGE_ROOT:-}"' _ "$config") || fail "Cannot read VIEWFORGE_ROOT from $config"
        [[ "$configured" == /* ]] || fail "Set an absolute VIEWFORGE_ROOT in $config before rerunning."
        if [[ -n "$explicit" && "$explicit" != "$configured" ]]; then
            printf 'ERROR: VIEWFORGE_ROOT conflicts with %s. To use its root, rerun:\n' "$config" >&2
            printf '  env -u VIEWFORGE_ROOT bash %q' "$SETUP_REPO/object-reconstruction/scripts/setup.sh" >&2
            if (( DRY_RUN )); then printf ' --dry-run' >&2; fi
            printf '\n' >&2
            exit 1
        fi
        VIEWFORGE_ROOT="$configured"
        printf '  Using VIEWFORGE_ROOT from %s: %s\n' "$config" "$VIEWFORGE_ROOT"
    else
        VIEWFORGE_ROOT="${explicit:-$ROOMCANVAS_HOME/runtime/object-reconstruction}"
    fi
    [[ "$VIEWFORGE_ROOT" == /* ]] || fail 'VIEWFORGE_ROOT must be an absolute path.'
    export VIEWFORGE_ROOT
}
clone_pinned() {
    local url="$1" revision="$2" dest="$3" required
    shift 3
    setup_begin "$dest"
    [[ "$SETUP_ACTION" != skip ]] || return 0
    if [[ "$SETUP_ACTION" == install ]]; then
        # git clone refuses the nonempty marker directory; init/fetch can resume
        # an interrupted checkout without removing the ownership marker.
        run git -C "$dest" init
        if (( DRY_RUN )) || ! git -C "$dest" remote get-url origin >/dev/null 2>&1; then
            run git -C "$dest" remote add origin "$url"
        fi
        run git -C "$dest" fetch origin "$revision"
        run git -C "$dest" checkout --detach FETCH_HEAD
        run git -C "$dest" submodule update --init --recursive
    fi
    for required in "$@"; do require_file "$dest/$required"; done
    if (( ! DRY_RUN )); then
        git -C "$dest" rev-parse --verify HEAD >/dev/null || fail "Invalid pre-existing/source checkout: $dest"
        if [[ "$revision" != main && $(git -C "$dest" rev-parse HEAD) != "$revision" ]]; then
            fail "Source revision differs at $dest; preserved. Choose a new runtime root."
        fi
        [[ -z $(git -C "$dest" submodule status --recursive | sed -n '/^[-+U]/p') ]] || fail "Incomplete or mismatched submodules: $dest (verify-only if pre-existing)."
    fi
    setup_finish "$dest"
}
# Direct downloads never expose a partially written final filename. Preserve
# failed .part files for diagnosis; they are not mistaken for completed files.
atomic_download() {
    run python3 - "$1" "$2" <<'PY'
from pathlib import Path
import os, shutil, sys, tempfile, urllib.request
url, dest = sys.argv[1:]
p = Path(dest)
if p.exists():
    if not p.is_file() or not p.stat().st_size:
        raise SystemExit("Existing download is empty/invalid; preserved: " + dest)
    print("Reusing existing download (verified by the caller):", dest)
else:
    fd, tmp = tempfile.mkstemp(prefix=p.name + ".", suffix=".part", dir=p.parent)
    with os.fdopen(fd, "wb") as out, urllib.request.urlopen(url) as response:
        shutil.copyfileobj(response, out)
        expected = response.headers.get("Content-Length")
        if expected is not None and out.tell() != int(expected):
            raise SystemExit("Incomplete download retained at " + tmp)
        if not out.tell():
            raise SystemExit("Empty download retained at " + tmp)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, p)
PY
}
# kind selects the exact loader contract, not merely directory/config existence.
verify_weights() {
    local python="$1" kind="$2" dest="$3"
    shift 3
    run "$python" - "$kind" "$dest" "$@" <<'PY'
from pathlib import Path
import hashlib, json, sys
kind, directory, *extra = sys.argv[1:]
root = Path(directory)
def required(name):
    p = root / name
    if not p.is_file() or not p.stat().st_size:
        raise SystemExit("Missing/empty model file: " + str(p))
    return p
def model_weights():
    indexes = list(root.glob("*.safetensors.index.json")) + list(root.glob("pytorch_model.bin.index.json"))
    if indexes:
        for index in indexes:
            shards = set(json.loads(index.read_text())["weight_map"].values())
            if not shards: raise SystemExit("Empty weight index: " + str(index))
            for name in shards: required(name)
    elif (root / "model.safetensors").exists(): required("model.safetensors")
    else: required("pytorch_model.bin")
if kind == "files":
    for name in extra: required(name)
elif kind == "trellis":
    models = json.loads(required("pipeline.json").read_text())["args"]["models"]
    if not models: raise SystemExit("Empty TRELLIS model map")
    for name, stem in models.items():
        if name == "sparse_structure_decoder":
            # trellis_local.py explicitly replaces this remote reference.
            stem = str(root.parent / "sparse-decoder/ckpts/ss_dec_conv3d_16l8_fp16")
        elif not isinstance(stem, str) or not stem.startswith("ckpts/"):
            raise SystemExit("Unrecognized TRELLIS checkpoint reference: " + str(stem))
        required(stem + ".json")
        required(stem + ".safetensors")
elif kind in ("hf", "dinov3", "da3"):
    json.loads(required("config.json").read_text())
    if kind == "da3":
        required("model.safetensors")  # DepthAnything3 / PyTorchModelHubMixin
    else:
        model_weights()
        from transformers import AutoConfig, AutoImageProcessor
        AutoConfig.from_pretrained(root, local_files_only=True)
        AutoImageProcessor.from_pretrained(root, local_files_only=True)
    if kind == "hf" and extra == ["tokenizer"]:
        from transformers import AutoTokenizer
        AutoTokenizer.from_pretrained(root, local_files_only=True)
    if kind == "dinov3":
        h = hashlib.sha256()
        with required("model.safetensors").open("rb") as f:
            for block in iter(lambda: f.read(8 * 1024 * 1024), b""): h.update(block)
        if h.hexdigest() != "dcb2e45127cccbf1601e5f42fef165eea275c8e5213197e8dcf3f48822718179":
            raise SystemExit("DINOv3 SHA256 mismatch")
elif kind == "sam3d":
    import yaml
    cfg = yaml.safe_load(required("pipeline.yaml").read_text())
    for key in ("ss_generator_config_path", "slat_generator_config_path"):
        if not cfg.get(key): raise SystemExit("Missing SAM3D field: " + key)
    checkpoints = 0
    for key, value in cfg.items():
        if key.endswith(("_config_path", "_ckpt_path")) and value:
            required(value)
            checkpoints += key.endswith("_ckpt_path")
    if not checkpoints: raise SystemExit("SAM3D pipeline has no checkpoints")
elif kind == "dinov2":
    import torch
    state = torch.load(required("hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth"), map_location="cpu", weights_only=True)
    if not isinstance(state, dict) or not state: raise SystemExit("Invalid DINOv2 state dict")
elif kind == "birefnet":
    for name in ("config.json", "birefnet.py", "BiRefNet_config.py", "model.safetensors", "viewforge_revision.json"):
        required(name)
    cfg = json.loads(Path(extra[0]).read_text())
    if json.loads(required("viewforge_revision.json").read_text()) != {k: cfg[k] for k in ("model_id", "revision")}:
        raise SystemExit("Existing BiRefNet revision differs; preserved")
else:
    raise SystemExit("Unknown weight verifier: " + kind)
print("Verified", kind, directory)
PY
}
snapshot() {
    local python="$1" repo="$2" dest="$3" revision="$4" kind="$5"
    shift 5
    setup_begin "$dest"
    [[ "$SETUP_ACTION" != skip ]] || return 0
    if [[ "$SETUP_ACTION" == install ]]; then
        run "$python" -c 'import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2], revision=sys.argv[3] or None, allow_patterns=sys.argv[4:] or None)' "$repo" "$dest" "$revision" "$@"
    fi
    if [[ "$kind" == files ]]; then verify_weights "$python" "$kind" "$dest" "$@"
    elif [[ "$repo" == IDEA-Research/grounding-dino-tiny ]]; then verify_weights "$python" "$kind" "$dest" tokenizer
    else verify_weights "$python" "$kind" "$dest"; fi
    setup_finish "$dest"
}
next_commands() {
    if (( DRY_RUN )); then printf '\nDRY-RUN complete: no environments, downloads, configuration files or services were created.\n'; fi
    printf '\nNext commands (after filling the configuration keys):\n'
    show cd "$SETUP_REPO/object-reconstruction"
    printf '  source configs/local.env && source scripts/env.sh\n'
    printf '  python scripts/web.py --host 127.0.0.1 --port 7862\n'
    printf '  # In another terminal, replace /path/to/scan and /path/to/new-run:\n'
    show env "ROOMCANVAS_HOME=$ROOMCANVAS_HOME" "$ROOMCANVAS_HOME/runtime/litereality-env/bin/python" "$SETUP_REPO/room-reconstruction/server/run_room.py" /path/to/scan /path/to/new-run --check
    printf '  The service requires the objects setup; --check requires the rooms setup. --check is not an inference test.\n'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    mode=all
    mode_seen=0
    dry_args=()
    for arg in "$@"; do
        case "$arg" in
            all|rooms|objects)
                (( mode_seen == 0 )) || fail 'Specify only one of all, rooms, objects.'
                mode="$arg"; mode_seen=1 ;;
            --dry-run) dry_args=(--dry-run) ;;
            *) fail 'Usage: sh scripts/setup_server.sh [all|rooms|objects] [--dry-run]' ;;
        esac
    done
    # Bash 3.2 (macOS) treats an empty array expansion as unset under nounset.
    setup_init ${dry_args[@]+"${dry_args[@]}"}
    step "Server setup: $mode"
    if [[ "$mode" == all || "$mode" == rooms ]]; then
        show bash "$SETUP_REPO/room-reconstruction/server/setup.sh" ${dry_args[@]+"${dry_args[@]}"}
        bash "$SETUP_REPO/room-reconstruction/server/setup.sh" ${dry_args[@]+"${dry_args[@]}"}
    fi
    if [[ "$mode" == all || "$mode" == objects ]]; then
        show bash "$SETUP_REPO/object-reconstruction/scripts/setup.sh" ${dry_args[@]+"${dry_args[@]}"}
        bash "$SETUP_REPO/object-reconstruction/scripts/setup.sh" ${dry_args[@]+"${dry_args[@]}"}
    fi
    step 'Selected setup steps finished'
    next_commands
fi
