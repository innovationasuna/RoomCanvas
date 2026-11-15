#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set +x
set -euo pipefail

# Download sources, checked against each upstream; override any of them with an
# environment variable of the same name.
DA3_SOURCE_URL="${DA3_SOURCE_URL:-https://github.com/ByteDance-Seed/Depth-Anything-3.git}" # Official repo; contains the commit pinned in configs/upstream_versions.json.
SAM3D_WEIGHTS_REPO="${SAM3D_WEIGHTS_REPO:-facebook/sam-3d-objects}" # Gated: request access on Hugging Face first (sam-3d-objects doc/setup.md).
SAM3D_WEIGHTS_SUBDIR="${SAM3D_WEIGHTS_SUBDIR:-checkpoints}" # Upstream setup moves <snapshot>/checkpoints into place; it holds pipeline.yaml.
DINOV2_REVISION="${DINOV2_REVISION:-7764ea0f912e53c92e82eb78a2a1631e92725fc8}" # facebookresearch/dinov2 main; the original Torch Hub snapshot recorded no commit.
DINOV2_WEIGHT_URL="${DINOV2_WEIGHT_URL:-https://dl.fbaipublicfiles.com/dinov2/dinov2_vitl14/dinov2_vitl14_reg4_pretrain.pth}" # Official DINOv2 release URL.
# Known source owner comes from sam3d_objects/model/backbone/dit/embedder/dino.py.
DINOV2_SOURCE_URL=https://github.com/facebookresearch/dinov2.git
# Known utils3d repository comes from room-reconstruction/deploy/modal/trellis/Dockerfile;
# its OBJECT service commit is different and is read from upstream_versions.json.
UTILS3D_SOURCE_URL=https://github.com/EasternJournalist/utils3d.git

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../scripts/setup_server.sh
source "$SCRIPT_DIR/../../scripts/setup_server.sh"
setup_init "$@"
CODE="$SETUP_REPO/object-reconstruction"
resolve_viewforge_root "$CODE/configs/local.env"
ENV_DIR="$VIEWFORGE_ROOT/envs/mvsam3d"
PY="$ENV_DIR/bin/python"
THIRD="$VIEWFORGE_ROOT/third_party"
WEIGHTS="$VIEWFORGE_ROOT/weights"
preflight "$VIEWFORGE_ROOT"

step 'Confirm source coordinates and gated SAM 3D access before installing anything'
if ! exists "$THIRD/depth-anything-3"; then need_value DA3_SOURCE_URL 'Confirm the upstream DA3 Git URL.'; fi
if ! exists "$THIRD/dinov2"; then need_value DINOV2_REVISION 'The recorded DINOv2 commit is null; supply a confirmed immutable commit.'; fi
if ! exists "$WEIGHTS/dinov2/hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth"; then
    need_value DINOV2_WEIGHT_URL 'Confirm the DINOv2 checkpoint URL for the recorded reg4 model.'
fi
if ! exists "$WEIGHTS/sam3d"; then
    need_value SAM3D_WEIGHTS_REPO 'Confirm the gated SAM 3D Objects Hugging Face model repo.'
    need_value SAM3D_WEIGHTS_SUBDIR 'Confirm the snapshot subdirectory containing pipeline.yaml (or .).'
    if [[ "$MODEL_SOURCE" == modelscope ]]; then
        printf '  MODEL_SOURCE=modelscope: SAM 3D comes from ModelScope under the same repo ID; HF_TOKEN is not needed.\n'
    elif [[ -z "${HF_TOKEN:-}" ]]; then
        printf '  REQUIRED: request access to the SAM 3D Objects model on Hugging Face, accept its terms, and export HF_TOKEN with read access (or leave MODEL_SOURCE at its default, modelscope). Token values are never printed.\n'
        if (( ! DRY_RUN )); then fail 'HF_TOKEN is required for the missing gated SAM 3D Objects weights.'; fi
    else printf '  HF_TOKEN is present (value hidden); model access will be checked by the download.\n'; fi
fi

step 'Create runtime directories and local.env without replacing existing configuration'
ensure_dir "$VIEWFORGE_ROOT/envs" "$VIEWFORGE_ROOT/logs" "$THIRD" "$WEIGHTS"
if exists "$CODE/configs/local.env"; then skip "$CODE/configs/local.env";
else
    # The template's GPU/lock/architecture/time-zone lines are optional comments; only
    # VIEWFORGE_ROOT is read from an existing local.env, in a subshell.
    run python3 -c 'from pathlib import Path; import shlex, sys
text = Path(sys.argv[1]).read_text().replace("export VIEWFORGE_ROOT=/path/to/ViewForge", "export VIEWFORGE_ROOT=" + shlex.quote(sys.argv[3]))
with open(sys.argv[2], "x") as f: f.write(text)' "$CODE/configs/local.env.example" "$CODE/configs/local.env" "$VIEWFORGE_ROOT"
fi
printf '  configs/local.env only needs VIEWFORGE_ROOT; the GPU, lock, build architecture and time zone have defaults (pin a GPU there on a shared server).\n'

step 'Clone DA3, DINOv2 and utils3d; preserve and verify existing source pins'
# Metadata reads are static and work on macOS without conda or a GPU.
DA3_REVISION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["depth-anything-3"]["commit"])' "$CODE/configs/upstream_versions.json")
UTILS3D_REVISION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["utils3d"]["commit"])' "$CODE/configs/upstream_versions.json")
clone_pinned "${DA3_SOURCE_URL:-<confirm-DA3_SOURCE_URL>}" "$DA3_REVISION" "$THIRD/depth-anything-3" src/depth_anything_3/api.py
clone_pinned "$UTILS3D_SOURCE_URL" "$UTILS3D_REVISION" "$THIRD/utils3d" utils3d/__init__.py
clone_pinned "$DINOV2_SOURCE_URL" "$DINOV2_REVISION" "$THIRD/dinov2" hubconf.py

step 'Create the Conda environment and install repository requirements / extras'
# Apply this on reruns as well, so validation sees the same CUDA libraries.
export CONDA_PREFIX="$ENV_DIR" CUDA_HOME="$ENV_DIR"
export PATH="$ENV_DIR/bin:$PATH"
export CPATH="$ENV_DIR/targets/x86_64-linux/include"
export LIBRARY_PATH="$ENV_DIR/targets/x86_64-linux/lib"
export LD_LIBRARY_PATH="$ENV_DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export MAX_JOBS="${MAX_JOBS:-4}" OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}" MKL_NUM_THREADS="${MKL_NUM_THREADS:-4}"
setup_begin "$ENV_DIR"
if [[ "$SETUP_ACTION" == install ]]; then
    if [[ -s "$ENV_DIR/conda-meta/history" ]]; then
        run "$CONDA" env update --prefix "$ENV_DIR" --file "$CODE/environments/default.yml"
    else
        run "$CONDA" env create --prefix "$ENV_DIR" --file "$CODE/environments/default.yml"
    fi
    # Same build/runtime wiring as scripts/env.sh, without its mandatory GPU
    # selection or executing any private configuration file.
    # Read package indexes and build dependencies from pyproject, not a new list.
    if (( DRY_RUN )); then
        printf '  Use PIP_EXTRA_INDEX_URL from pyproject.toml: https://pypi.nvidia.com https://download.pytorch.org/whl/cu121\n'
    else
        PIP_EXTRA_INDEX_URL=$("$PY" -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1], "rb"))["tool"]["hatch"]["envs"]["default"]["env-vars"]["PIP_EXTRA_INDEX_URL"])' "$CODE/pyproject.toml")
        export PIP_EXTRA_INDEX_URL
    fi
    # torch bootstrap: requirements.txt pins torchaudio 2.5.1+cu121 and xformers
    # 0.0.28.post3; torch/torchvision pair also recorded in birefnet-requirements.
    run "$PY" -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121
    run "$PY" -c 'import subprocess, sys, tomllib
p = tomllib.load(open(sys.argv[1], "rb"))
subprocess.check_call([sys.executable, "-m", "pip", "install", *p["build-system"]["requires"]])' "$CODE/pyproject.toml"
    run "$PY" -m pip install --no-build-isolation -r "$CODE/requirements.txt"
    # p3d/inference/dev map directly to requirements.{p3d,inference,dev}.txt.
    # no-build-isolation lets CUDA source builds use the installed torch.
    run "$PY" -m pip install --no-build-isolation \
        -f https://nvidia-kaolin.s3.us-east-2.amazonaws.com/torch-2.5.1_cu121.html \
        --editable "$CODE[p3d,inference,dev]"
    run "$PY" -m pip install -r "$CODE/configs/api-requirements.txt"
    # These sources are outside the main package and must be installed too.
    run "$PY" -m pip install --no-build-isolation --editable "$THIRD/depth-anything-3"
    run "$PY" -m pip install --no-build-isolation --editable "$THIRD/utils3d"
    run "$PY" -m pip check
fi
# Recheck existing environments too: an old completion marker can predate baking.
require_file "$PY"
# Inference uses flash_attn only on A100/H100/H200 (sam3d_objects/pipeline/inference_pipeline.py), xformers elsewhere.
run env "PYTHONPATH=$CODE:$CODE/notebook:$THIRD/depth-anything-3/src" "$PY" -c 'import torch, pytorch3d, gsplat, nvdiffrast.torch, xatlas, kaolin, xformers, utils3d, starlette, uvicorn; from depth_anything_3.api import DepthAnything3; assert torch.__version__.split("+")[0] == "2.5.1"; assert torch.version.cuda == "12.1"; assert kaolin.__version__ == "0.17.0"; assert torch.cuda.is_available(); gpu = torch.cuda.get_device_name(0); any(g in gpu for g in ("A100", "H100", "H200")) and __import__("flash_attn")'
setup_finish "$ENV_DIR"

step 'Download SAM 3D, DA3 and DINOv2 weights into the runner layout'
setup_begin "$WEIGHTS/sam3d"
if [[ "$SETUP_ACTION" == install ]]; then
    # Link the requested subtree from the download cache into our marked directory;
    # never alter a pre-existing directory or symlink. Preserve relative paths.
    case "$SAM3D_WEIGHTS_SUBDIR" in /*|..|../*|*/..|*/../*) fail 'SAM3D_WEIGHTS_SUBDIR must stay inside the snapshot.' ;; esac
    SAM3D_SNAPSHOT=
    if [[ "$MODEL_SOURCE" == modelscope ]]; then
        SAM3D_SNAPSHOT="$VIEWFORGE_ROOT/cache/modelscope/$SAM3D_WEIGHTS_REPO"
        if [[ "$SAM3D_WEIGHTS_SUBDIR" == . ]]; then modelscope_download "$SAM3D_WEIGHTS_REPO" "$SAM3D_SNAPSHOT"
        else modelscope_download "$SAM3D_WEIGHTS_REPO" "$SAM3D_SNAPSHOT" "$SAM3D_WEIGHTS_SUBDIR/*"; fi
    fi
    run "$PY" -c 'from pathlib import Path; import sys
repo, subdir, dest, cache, snapshot = sys.argv[1:]
p = Path(subdir)
if snapshot:
    root = Path(snapshot)
else:
    from huggingface_hub import snapshot_download
    patterns = [str(p) + "/*"] if str(p) != "." else None
    root = Path(snapshot_download(repo_id=repo, cache_dir=cache, allow_patterns=patterns))
source = root / p
if not (source / "pipeline.yaml").is_file(): raise SystemExit("Confirmed SAM3D subtree has no pipeline.yaml")
for child in source.iterdir():
    target = Path(dest) / child.name
    if target.exists() or target.is_symlink():
        if target.resolve() != child.resolve(): raise SystemExit("Existing SAM3D file differs; preserved: " + str(target))
    else: target.symlink_to(child, target_is_directory=child.is_dir())' "$SAM3D_WEIGHTS_REPO" "$SAM3D_WEIGHTS_SUBDIR" "$WEIGHTS/sam3d" "$VIEWFORGE_ROOT/cache/huggingface/hub" "$SAM3D_SNAPSHOT"
fi
if [[ "$SETUP_ACTION" != skip ]]; then
    verify_weights "$PY" sam3d "$WEIGHTS/sam3d"
    setup_finish "$WEIGHTS/sam3d"
fi
DA3_MODEL=$(sed -n 's/^  model: //p' "$CODE/configs/default.yaml")
[[ "$DA3_MODEL" == da3-nested-giant-large ]] || fail 'DA3 model changed: confirm its HF repo mapping in scripts/run_da3.py before setup.'
snapshot "$PY" depth-anything/DA3NESTED-GIANT-LARGE "$WEIGHTS/$DA3_MODEL" "" da3 config.json model.safetensors
setup_begin "$WEIGHTS/dinov2"
if [[ "$SETUP_ACTION" == install ]]; then
    ensure_dir "$WEIGHTS/dinov2/hub/checkpoints"
    atomic_download "$DINOV2_WEIGHT_URL" "$WEIGHTS/dinov2/hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth"
fi
if [[ "$SETUP_ACTION" != skip ]]; then
    verify_weights "$PY" dinov2 "$WEIGHTS/dinov2"
    setup_finish "$WEIGHTS/dinov2"
fi

step 'Set up isolated BiRefNet (same recipe as setup_birefnet.sh)'
# Track environment and weights separately: one may be user-installed while
# the other is absent or an interrupted script-owned step.
BIREF_PY="$VIEWFORGE_ROOT/envs/birefnet/bin/python"
setup_begin "$VIEWFORGE_ROOT/envs/birefnet"
if [[ "$SETUP_ACTION" == install ]]; then
    run "$PY" -m venv "$VIEWFORGE_ROOT/envs/birefnet"
    run "$BIREF_PY" -m pip install -r "$CODE/configs/birefnet-requirements.txt"
fi
if [[ "$SETUP_ACTION" != skip ]]; then
    require_file "$BIREF_PY"
    run "$BIREF_PY" -c 'import torch, transformers, timm, kornia; assert torch.__version__.split("+")[0] == "2.5.1"; assert transformers.__version__ == "4.48.3"'
    setup_finish "$VIEWFORGE_ROOT/envs/birefnet"
fi
setup_begin "$WEIGHTS/birefnet"
if [[ "$SETUP_ACTION" == install ]]; then
    run "$BIREF_PY" - "$CODE/configs/birefnet.json" "$WEIGHTS/birefnet" <<'PY'
from pathlib import Path
import json, sys
from huggingface_hub import snapshot_download
cfg = json.loads(Path(sys.argv[1]).read_text())
root = Path(sys.argv[2])
marker = root / "viewforge_revision.json"
expected = {k: cfg[k] for k in ("model_id", "revision")}
if marker.exists() and json.loads(marker.read_text()) != expected:
    raise SystemExit("Existing BiRefNet revision differs; preserved")
snapshot_download(repo_id=cfg["model_id"], revision=cfg["revision"], local_dir=root,
                  allow_patterns=["*.py", "config.json", "model.safetensors", "README.md", "requirements.txt"])
(root / "revision.txt").write_text(cfg["revision"] + "\n")
marker.write_text(json.dumps(expected, indent=2) + "\n")
PY
fi
if [[ "$SETUP_ACTION" != skip ]]; then
    verify_weights "$BIREF_PY" birefnet "$WEIGHTS/birefnet" "$CODE/configs/birefnet.json"
    setup_finish "$WEIGHTS/birefnet"
fi

step 'Object setup steps finished; configure the GPU/lock before starting the service'
next_commands
