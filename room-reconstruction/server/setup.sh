#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set +x
set -euo pipefail

# Download sources, checked against each upstream; override any of them with an
# environment variable of the same name.
BLENDER_ARCHIVE_URL="${BLENDER_ARCHIVE_URL:-https://download.blender.org/release/Blender5.1/blender-5.1.2-linux-x64.tar.xz}" # Official release path (same file on the official mirrors).
CUDA124_CONDA_SPEC="${CUDA124_CONDA_SPEC:-cuda-toolkit=12.4.1}" # conda-forge cuda-toolkit 12.4.1, matching the Dockerfile's nvidia/cuda:12.4.1 base.
SPARSE_DECODER_REPO="${SPARSE_DECODER_REPO:-microsoft/TRELLIS-image-large}" # TRELLIS.2-4B pipeline.json: "microsoft/TRELLIS-image-large/ckpts/ss_dec_conv3d_16l8_fp16".
# No immutable TRELLIS source pin is recorded: follow Dockerfile's main branch.
# Do not invent pins for other HF snapshots either; only DINOv3 is pinned below.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../scripts/setup_server.sh
source "$SCRIPT_DIR/../../scripts/setup_server.sh"
setup_init "$@"
CODE="$SETUP_REPO/room-reconstruction"
RUNTIME="$ROOMCANVAS_HOME/runtime"
WEIGHTS="$ROOMCANVAS_HOME/backends/weights"
TRELLIS="$ROOMCANVAS_HOME/backends/TRELLIS.2"
PY="$RUNTIME/trellis-env/bin/python"
preflight "$ROOMCANVAS_HOME"
step 'Confirm missing distribution coordinates before installing anything'
if ! exists "$RUNTIME/blender/blender-5.1.2-linux-x64"; then
    need_value BLENDER_ARCHIVE_URL 'Confirm the official Blender 5.1.2 Linux x64 tar.xz URL.'
fi
if ! exists "$RUNTIME/cuda-12.4"; then
    need_value CUDA124_CONDA_SPEC 'Confirm a conda-forge CUDA 12.4.1 toolkit spec (including nvcc and development libraries).'
fi
if ! exists "$WEIGHTS/sparse-decoder"; then
    need_value SPARSE_DECODER_REPO 'Confirm the HF sparse decoder repo from the upstream TRELLIS.2 pipeline.'
fi

step 'System build and graphics dependencies (TRELLIS Dockerfile)'
# Ubuntu/Debian packages from deploy/modal/trellis/Dockerfile. Python is provided
# separately by uv; do not install the container-only python-is-python3 package.
system_packages=(build-essential ffmpeg git git-lfs libgl1 libglib2.0-0 libjpeg-dev zlib1g-dev)
missing=()
if (( DRY_RUN )); then
    printf '  Check dpkg status first; install only missing packages (sudo if not root).\n'
    run apt-get update
    run apt-get install -y --no-install-recommends "${system_packages[@]}"
else
    command -v dpkg-query >/dev/null && command -v apt-get >/dev/null || fail 'This system dependency recipe requires Debian/Ubuntu apt; use the Ubuntu 22.04 base recorded in deploy/modal/trellis/Dockerfile.'
    installed() { [[ $(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true) == 'install ok installed' ]]; }
    for package in "${system_packages[@]}"; do
        case "$package" in
            # Command-line tools may also come from PATH (for example conda-forge).
            ffmpeg|git|git-lfs) command -v "$package" >/dev/null && continue ;;
            # Ubuntu 24.04+ renamed the library package for the 64-bit time_t ABI.
            libglib2.0-0) installed libglib2.0-0t64 && continue ;;
        esac
        installed "$package" || missing+=("$package")
    done
    if (( ${#missing[@]} )); then
        if (( EUID == 0 )); then
            run apt-get update
            run apt-get install -y --no-install-recommends "${missing[@]}"
        # sudo -l may prompt for a password; it fails without a terminal or rights.
        elif command -v sudo >/dev/null && sudo -l apt-get >/dev/null 2>&1; then
            run sudo apt-get update
            run sudo apt-get install -y --no-install-recommends "${missing[@]}"
        else
            fail "Missing system packages: ${missing[*]}. Without sudo, ffmpeg/git-lfs can come from PATH (conda create -p <prefix> -c conda-forge ffmpeg git-lfs; export PATH=<prefix>/bin:\$PATH); libraries need an administrator."
        fi
    else skip 'system packages'; fi
fi

step 'Create the main application environment (local models remain isolated)'
ensure_dir "$RUNTIME" "$WEIGHTS"
setup_begin "$RUNTIME/litereality-env"
if [[ "$SETUP_ACTION" == install ]]; then
    # Python 3.11 matches the server runtime layout. The modal extra is a client
    # dependency only; no Modal credentials/deployment are configured here.
    if [[ ! -s "$RUNTIME/litereality-env/bin/python" ]]; then
        run uv venv --allow-existing --python 3.11 "$RUNTIME/litereality-env"
    fi
    run env "UV_PROJECT_ENVIRONMENT=$RUNTIME/litereality-env" uv sync --project "$CODE" --frozen --python 3.11 --extra modal
fi
if [[ "$SETUP_ACTION" != skip ]]; then
require_file "$RUNTIME/litereality-env/bin/python"
require_file "$RUNTIME/litereality-env/bin/litereality"
run env "PYTHONPATH=$CODE/src" "$RUNTIME/litereality-env/bin/python" -c 'import pathlib, sys, litereality_agent; assert pathlib.Path(litereality_agent.__file__).is_relative_to(pathlib.Path(sys.argv[1])); from litereality_agent.settings import LiteRealitySettings' "$CODE/src"
setup_finish "$RUNTIME/litereality-env"
fi

step 'Create CUDA 12.4 toolkit and the lib path used by run_room.py'
setup_begin "$RUNTIME/cuda-12.4"
if [[ "$SETUP_ACTION" == install ]]; then
    if [[ -s "$RUNTIME/cuda-12.4/conda-meta/history" ]]; then
        run "$CONDA" install -y --prefix "$RUNTIME/cuda-12.4" -c conda-forge "$CUDA124_CONDA_SPEC"
    else
        run "$CONDA" create -y --prefix "$RUNTIME/cuda-12.4" -c conda-forge "$CUDA124_CONDA_SPEC"
    fi
    # Conda toolkit layouts can use lib, lib64, or targets/x86_64-linux/lib.
    run python3 -c 'from pathlib import Path; import sys
p = Path(sys.argv[1]); lib = p / "lib"
if not lib.exists():
    source = next((p / n for n in ("lib64", "targets/x86_64-linux/lib") if (p / n).is_dir()), None)
    if source is None: raise SystemExit("CUDA toolkit has no library directory")
    lib.symlink_to(source, target_is_directory=True)' "$RUNTIME/cuda-12.4"
fi
if [[ "$SETUP_ACTION" != skip ]]; then
require_file "$RUNTIME/cuda-12.4/bin/nvcc"
if (( ! DRY_RUN )); then
    "$RUNTIME/cuda-12.4/bin/nvcc" --version | grep -q 'release 12.4' || fail 'Existing CUDA toolkit is not 12.4; preserve it and choose a different ROOMCANVAS_HOME.'
    [[ -d "$RUNTIME/cuda-12.4/lib" ]] || fail 'CUDA toolkit must expose runtime/cuda-12.4/lib.'
fi
setup_finish "$RUNTIME/cuda-12.4"
fi

step 'Download and unpack Blender 5.1.2'
BLENDER="$RUNTIME/blender/blender-5.1.2-linux-x64"
setup_begin "$BLENDER"
if [[ "$SETUP_ACTION" == install ]]; then
    atomic_download "$BLENDER_ARCHIVE_URL" "$RUNTIME/blender/blender-5.1.2-linux-x64.tar.xz"
    run tar -tJf "$RUNTIME/blender/blender-5.1.2-linux-x64.tar.xz"
    # Only script-owned incomplete installs may have partially extracted files.
    run tar -xJf "$RUNTIME/blender/blender-5.1.2-linux-x64.tar.xz" -C "$RUNTIME/blender"
fi
if [[ "$SETUP_ACTION" != skip ]]; then
    require_file "$BLENDER/blender"
    run "$BLENDER/blender" --version
    setup_finish "$BLENDER"
fi

step 'Clone TRELLIS.2 sources (main, recursive, as in the Dockerfile)'
clone_pinned https://github.com/microsoft/TRELLIS.2.git main "$TRELLIS" setup.sh trellis2/pipelines/__init__.py

step 'Build TRELLIS and detection in the shared server model environment'
export CUDA_HOME="$RUNTIME/cuda-12.4"
export LD_LIBRARY_PATH="$RUNTIME/cuda-12.4/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
setup_begin "$RUNTIME/trellis-env"
if [[ "$SETUP_ACTION" == install ]]; then
    # The local Dockerfile/app.py supplies the build recipe. Inspect the checked
    # out upstream script at execution time, without fetching it during preflight.
    if (( ! DRY_RUN )) && grep -q /tmp/extensions "$TRELLIS/setup.sh" && exists /tmp/extensions; then
        fail 'TRELLIS setup hard-codes /tmp/extensions, which already exists. Nothing there was changed; ask its owner to resolve it before rerunning.'
    fi
    if [[ ! -s "$PY" ]]; then run uv venv --allow-existing --python 3.11 --seed "$RUNTIME/trellis-env"; fi
    # Install in recipe order. run_room.py hardcodes the Python 3.11 library path;
    # Modal's Python 3.10 is deliberately adapted to that local server contract.
    run "$PY" -m pip install 'setuptools>=64' wheel
    run "$PY" -m pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
    run "$PY" -m pip install imageio imageio-ffmpeg tqdm easydict opencv-python-headless ninja trimesh transformers gradio==6.0.1 tensorboard pandas lpips zstandard git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8 pillow-simd kornia timm xformers==0.0.29.post3 huggingface-hub hf-xet
    # Do not copy the Modal H100 arch=9.0 onto a different GPU. Upstream detects
    # visible devices; an explicitly exported TORCH_CUDA_ARCH_LIST is respected.
    run env "PATH=$RUNTIME/trellis-env/bin:$RUNTIME/cuda-12.4/bin:$PATH" "CUDA_HOME=$RUNTIME/cuda-12.4" "VIRTUAL_ENV=$RUNTIME/trellis-env" bash -c '
set -euo pipefail
cd "$1"
if grep -q /tmp/extensions setup.sh && [[ -e /tmp/extensions || -L /tmp/extensions ]]; then
    echo "ERROR: /tmp/extensions already exists; preserved. Resolve ownership before retrying." >&2
    exit 1
fi
build=$(mktemp -d "${TMPDIR:-/tmp}/roomcanvas-trellis.XXXXXXXX")
export TMPDIR="$build"
# Isolate even literal /tmp/extensions paths; leave upstream sources unchanged.
sed "s|/tmp/extensions|$build/extensions|g" setup.sh > "$build/setup.sh"
printf "TRELLIS build directory (retained): %s\n" "$build"
. "$build/setup.sh" --cumesh --o-voxel --flexgemm --nvdiffrast --nvdiffrec
' _ "$TRELLIS"
    run "$PY" -m pip install transformers==4.57.5 -r "$CODE/deploy/modal/dino/requirements.txt"
    # detect = torch, torchvision, transformers; the pins above satisfy that
    # extra without uv sync replacing CUDA torch with the main app's resolution.
    run "$PY" -m pip install --no-deps --editable "$CODE[detect]"
fi
if [[ "$SETUP_ACTION" != skip ]]; then
require_file "$PY"
run env "PYTHONPATH=$CODE/src:$TRELLIS" "$PY" -c 'import torch, torchvision, transformers, cumesh, o_voxel, flex_gemm, nvdiffrast; assert torch.__version__.startswith("2.6.0"); assert torch.version.cuda == "12.4"; assert transformers.__version__ == "4.57.5"; assert torch.cuda.is_available(); from transformers import AutoModelForZeroShotObjectDetection, AutoModel'

setup_finish "$RUNTIME/trellis-env"
fi

step 'Download and verify local room model snapshots'
# trellis_local.py replaces the remote sparse decoder reference with this pair.
snapshot "$PY" "$SPARSE_DECODER_REPO" "$WEIGHTS/sparse-decoder" "" files \
    ckpts/ss_dec_conv3d_16l8_fp16.json ckpts/ss_dec_conv3d_16l8_fp16.safetensors
snapshot "$PY" microsoft/TRELLIS.2-4B "$WEIGHTS/trellis2" "" trellis \
    pipeline.json 'ckpts/*.json' 'ckpts/*.safetensors'
snapshot "$PY" camenduru/dinov3-vitl16-pretrain-lvd1689m "$WEIGHTS/dinov3" 3c276edd87d6f6e569ff0c4400e086807d0f3881 dinov3 \
    '*.json' '*.safetensors' '*LICENSE*' '*license*'
snapshot "$PY" IDEA-Research/grounding-dino-tiny "$WEIGHTS/grounding-dino-tiny" "" hf \
    '*.json' '*.safetensors' 'pytorch_model*.bin' '*.txt' '*.model'
snapshot "$PY" facebook/dinov2-small "$WEIGHTS/dinov2-small" "" hf \
    '*.json' '*.safetensors' 'pytorch_model*.bin'

step 'Create private .env from the template only when absent'
if exists "$ROOMCANVAS_HOME/.env"; then skip "$ROOMCANVAS_HOME/.env";
else
    run python3 -c 'from pathlib import Path; import sys
text = Path(sys.argv[1]).read_text().replace("LR_DINO_BACKEND=auto", "LR_DINO_BACKEND=local")
with open(sys.argv[2], "x") as f: f.write(text)' "$CODE/.env.example" "$ROOMCANVAS_HOME/.env"
fi
printf '  Fill OPENAI_API_KEY (or GEMINI_API_KEY with LR_IMAGE_PROVIDER=gemini), LR_SCANS_DIR, and authenticate the configured coding agent. run_room.py supplies Blender/model paths.\n'
printf '  Local GPU route: keep MODAL_TOKEN_ID, MODAL_TOKEN_SECRET and MODAL_PROFILE empty in .env and the invoking shell; set LR_DINO_BACKEND=local in any existing .env.\n'
step 'Room setup steps finished; no inference has been run'
next_commands
