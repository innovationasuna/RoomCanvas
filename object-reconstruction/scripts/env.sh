#!/usr/bin/env bash
# Source configs/local.env explicitly before this file; never auto-load it.
: "${VIEWFORGE_ROOT:?Set VIEWFORGE_ROOT, or explicitly source configs/local.env first}"
: "${CUDA_VISIBLE_DEVICES:?Set one authorized CUDA_VISIBLE_DEVICES value}"
export CONDA_PREFIX="$VIEWFORGE_ROOT/envs/mvsam3d"
export PATH="$CONDA_PREFIX/bin:$PATH" CUDA_HOME="$CONDA_PREFIX"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}" MKL_NUM_THREADS="${MKL_NUM_THREADS:-4}" MAX_JOBS="${MAX_JOBS:-4}"
export MPLBACKEND=Agg LIDRA_SKIP_INIT=true PYTHONUNBUFFERED=1
export HF_HOME="$VIEWFORGE_ROOT/cache/huggingface" XDG_CACHE_HOME="$VIEWFORGE_ROOT/cache/xdg"
export WARP_CACHE_PATH="$VIEWFORGE_ROOT/cache/warp" TORCH_EXTENSIONS_DIR="$VIEWFORGE_ROOT/cache/torch_extensions"
# torch.hub expects hub/checkpoints beneath TORCH_HOME. These are persistent weights.
export TORCH_HOME="$VIEWFORGE_ROOT/weights/dinov2"
export PIP_CACHE_DIR="$VIEWFORGE_ROOT/cache/pip"
export CPATH="$CONDA_PREFIX/targets/x86_64-linux/include"
for mv_include in "$CONDA_PREFIX"/lib/python3.11/site-packages/nvidia/*/include; do
  export CPATH="$CPATH:$mv_include"
done
export LIBRARY_PATH="$CONDA_PREFIX/targets/x86_64-linux/lib"
mv_code_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export PYTHONPATH="$mv_code_root:$mv_code_root/notebook:$VIEWFORGE_ROOT/third_party/depth-anything-3/src"
