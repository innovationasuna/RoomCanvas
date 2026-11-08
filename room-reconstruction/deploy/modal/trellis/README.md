# TRELLIS on Modal

[app.py](app.py) wraps
[models/trellis/inference.py](../../../src/litereality_agent/models/trellis/inference.py).
Deploy it through the [combined Modal app](../README.md#setup-and-deployment).

## Build and execution

The base image and Python dependencies build on CPU. The native CUDA extension
layer and inference use an H100. The function allows one container, no application
retries, and a ten-second idle scale-down window.

The first invocation downloads `microsoft/TRELLIS.2-4B` into the
`litereality-trellis-models` Volume. Later containers reuse that cache.

## DINOv3 encoder

The deployment pins an encoder snapshot:

| Field | Value |
|---|---|
| Repository | `camenduru/dinov3-vitl16-pretrain-lvd1689m` |
| Revision | `3c276edd87d6f6e569ff0c4400e086807d0f3881` |
| `model.safetensors` SHA-256 | `dcb2e45127cccbf1601e5f42fef165eea275c8e5213197e8dcf3f48822718179` |

The image build verifies the digest and sets `LITEREALITY_DINOV3` to the local
snapshot. The deployment does not configure a Hugging Face secret; it uses public
download locations. Download availability remains an external dependency.

For a local runtime, point `LITEREALITY_DINOV3` at an accessible encoder snapshot;
see [local GPU setup](../../local-gpu.md).
