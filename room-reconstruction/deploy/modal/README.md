# Modal deployment

Modal runs GPU inference while the reconstruction pipeline stays on the calling
machine. Run these commands from `room-reconstruction/`.

## Setup and deployment

```bash
uv sync --frozen --extra modal
```

Configure `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in `.env`, or use
`MODAL_PROFILE` for a named profile. Both token fields are required.
For manual deployment, export the credentials into the shell first; the Modal
command does not load this project's `.env`.

Deploy both model functions together:

```bash
uv run modal deploy --env main deploy/modal/app.py
```

[app.py](app.py) includes DINO and TRELLIS in the same `litereality` app.
The child wrappers use separate app names, `litereality-dino` and
`litereality-trellis`, while the runtime defaults target `litereality`.

The CLI also provides `uv run litereality setup`, with `--profile`, `--env`,
and `--skip-deploy`. However,
[runtimes/setup.py](../../src/litereality_agent/runtimes/setup.py) currently
deploys the child wrappers separately, so its deployments do not match those
default app names. Use the combined command above for deployment.
For profile authentication without deployment:

```bash
uv run litereality setup --skip-deploy
```

Without token credentials, setup may open a browser for authentication and records
the selected profile in `.env`. With a token pair, it uses that pair directly.

## Runtime selection

[models/registry.py](../../src/litereality_agent/models/registry.py) selects Modal
when a token pair or profile is configured. Default app/function settings are in
[settings.py](../../src/litereality_agent/settings.py).
For local inference, see [local GPU setup](../local-gpu.md).

## DINO

[dino/app.py](dino/app.py) serves GroundingDINO detection and DINOv2 embeddings.
Its deployment image uses precompiled wheels; inference uses an L4, at most four
containers, and a 60-second idle scale-down window.
Weights are cached in the `litereality-dino-models` Volume.

## TRELLIS

[trellis/app.py](trellis/app.py) wraps the canonical TRELLIS inference code.
It uses an H100, one container, zero application retries, and a ten-second idle
scale-down window. Model weights persist in the `litereality-trellis-models` Volume.
See [TRELLIS dependencies and weights](trellis/README.md).

A deployment builds the images; model invocation may download weights.
Idle containers scale down, while stored images and Volumes remain.
