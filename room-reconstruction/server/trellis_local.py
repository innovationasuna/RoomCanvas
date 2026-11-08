#!/usr/bin/env python3
"""TRELLIS.2 launcher for LiteReality: official inference CLI with pinned local weights.

Runs under the TRELLIS Python (LITEREALITY_TRELLIS_LAUNCHER). Quality defaults are
unchanged; only weight locations and low_vram differ from upstream.

$ROOMCANVAS_HOME is the directory holding backends/weights, normally the
RoomCanvas checkout root. Set it explicitly when invoking this launcher.
"""

import json
import os
import sys
from pathlib import Path

if not os.environ.get("ROOMCANVAS_HOME"):
    raise SystemExit("trellis_local.py: set ROOMCANVAS_HOME to the directory holding backends/weights")
home = Path(os.environ["ROOMCANVAS_HOME"])
weights = home / "backends/weights"
source = weights / "trellis2"
local = weights / "trellis2-local"
local.mkdir(exist_ok=True)
cfg = json.loads((source / "pipeline.json").read_text())
cfg["args"]["image_cond_model"]["args"]["model_name"] = str(weights / "dinov3")
cfg["args"]["models"]["sparse_structure_decoder"] = str(
    weights / "sparse-decoder/ckpts/ss_dec_conv3d_16l8_fp16"
)
cfg["args"]["low_vram"] = True
if not (local / "ckpts").exists():
    (local / "ckpts").symlink_to(source / "ckpts")
(local / "pipeline.json").write_text(json.dumps(cfg, indent=2))
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

from litereality_agent.models.trellis.inference import main  # noqa: E402

sys.argv.extend(["--model", str(local)])
raise SystemExit(main())
