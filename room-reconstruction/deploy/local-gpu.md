# Local GPU setup

Use a Linux NVIDIA GPU runtime for TRELLIS and detection. For RoomCanvas's
configured single-machine runner, follow the
[project guide](../../docs/ROOM_RECONSTRUCTION.md).

For a standalone module installation, install the main environment as described in
[Install](../README.md#install), then configure separate model environments.

## TRELLIS

The deployment recipe in [trellis/app.py](modal/trellis/app.py) records the CUDA
extension build and dependencies used by the project. Install TRELLIS.2 and those
extensions in a dedicated environment, with its package available to that interpreter.
The native extension build requires a visible CUDA GPU. The recipe uses
PyTorch 2.6.0 with CUDA 12.4. From `room-reconstruction/`, with the prepared
model environment active, the source and extension setup steps are:

```bash
git clone --recursive https://github.com/microsoft/TRELLIS.2.git TRELLIS.2
cd TRELLIS.2
. ./setup.sh --cumesh --o-voxel --flexgemm --nvdiffrast --nvdiffrec
```

Use the [Dockerfile](modal/trellis/Dockerfile) and deployment recipe for the
remaining system/Python dependencies; the extension command alone is not a
complete environment installation.

Set `TRELLIS_PYTHON` to that environment's interpreter.
The local worker can use `LITEREALITY_TRELLIS_LAUNCHER` to select a launcher;
RoomCanvas supplies [server/trellis_local.py](../server/trellis_local.py).

Model weights are downloaded on first use unless already cached. Set
`LITEREALITY_DINOV3` to a local DINOv3 encoder snapshot; the resolver also checks
`<LITEREALITY_WEIGHTS>/dinov3`, defaulting to `<LR_REPO_ROOT>/weights/dinov3`.
The [runtime resolver](../src/litereality_agent/models/runtime_env.py) expects
`TRELLIS.2` beneath the module root unless the package is otherwise importable. The
[Modal TRELLIS recipe](modal/trellis/README.md#dinov3-encoder) records its pinned snapshot.

## Detection and embeddings

The `detect` extra installs torch, torchvision, and transformers.
From `room-reconstruction/`, create an isolated detection environment:

```bash
UV_PROJECT_ENVIRONMENT=/path/to/detect-env uv sync --frozen --extra detect
```

Configure `.env` with the interpreter paths:

```dotenv
TRELLIS_PYTHON=/path/to/trellis-env/bin/python
GROUNDING_DINO_PYTHON=/path/to/detect-env/bin/python
LR_DINO_BACKEND=local
```

`LR_DINO_BACKEND=local` requires CUDA and overrides Modal for detection.
TRELLIS chooses Modal whenever a token pair or `MODAL_PROFILE` is configured;
leave those unset for local TRELLIS. Selection is implemented in
[models/registry.py](../src/litereality_agent/models/registry.py).

## Verify configuration

```bash
uv run python sanity.py
```

Basic checks do not prove model inference. `SANITY_DEEP=1` enables deeper
model loading/inference checks; test the selected GPU environment before a full run.
