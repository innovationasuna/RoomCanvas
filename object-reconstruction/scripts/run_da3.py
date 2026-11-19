"""
Depth Anything 3 (DA3) Runner Script

This script runs DA3 on a folder of images and outputs:
- depth maps
- pointmaps (3D coordinates in camera space)
- camera extrinsics and intrinsics
- visualization files (optional)

The outputs can be used as input to MV-SAM3D for improved 3D reconstruction.

Usage:
    python scripts/run_da3.py --image_dir ./data/example/images --output_dir ./da3_outputs/example
    
    # With custom resolution
    python scripts/run_da3.py --image_dir ./data/example/images --output_dir ./da3_outputs/example --process_res 756
    
    # Without visualization (faster)
    python scripts/run_da3.py --image_dir ./data/example/images --output_dir ./da3_outputs/example --no_vis
"""

import os
import sys
import argparse
import numpy as np
from pathlib import Path
from typing import List, Optional, Dict, Any

# ============================================================================
# Path setup: DA3 should be a sibling directory to MV-SAM3D
# ============================================================================
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent  # MV-SAM3D root
DA3_ROOT = PROJECT_ROOT.parent / "Depth-Anything-3"
if os.environ.get("VIEWFORGE_ROOT"):
    DA3_ROOT = Path(os.environ["VIEWFORGE_ROOT"]) / "third_party" / "depth-anything-3"

if not DA3_ROOT.exists():
    raise FileNotFoundError(
        f"Depth-Anything-3 not found at {DA3_ROOT}. "
        f"Please ensure DA3 is installed as a sibling directory to MV-SAM3D:\n"
        f"  parent_dir/\n"
        f"  ├── MV-SAM3D/\n"
        f"  └── Depth-Anything-3/"
    )

sys.path.insert(0, str(DA3_ROOT / "src"))

# Now we can import DA3
from depth_anything_3.api import DepthAnything3


from da3_arrays import depth_to_pointmap, pointmap_to_sam3d_format, pointmaps_from_depth


def run_da3_inference(
    image_dir: str,
    output_dir: str,
    model_path: Optional[str] = None,
    process_res: int = 504,
    save_visualization: bool = True,
    device: str = "cuda",
) -> Dict[str, Any]:
    """
    Run DA3 on a folder of images.
    
    Args:
        image_dir: Path to folder containing input images
        output_dir: Path to output directory
        model_path: Path to DA3 model checkpoint (default: auto-detect)
        process_res: Processing resolution (default: 504)
        save_visualization: Whether to save GLB and depth visualizations
        device: Device to run on ('cuda' or 'cpu')
    
    Returns:
        Dictionary containing:
            - depth: (N, H, W) depth maps
            - pointmaps: (N, H, W, 3) point cloud maps
            - extrinsics: (N, 3, 4) or (N, 4, 4) camera extrinsics
            - intrinsics: (N, 3, 3) camera intrinsics
            - image_files: List of input image paths
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    # Auto-detect model path if not provided
    if model_path is None:
        # Check common locations
        possible_paths = [
            DA3_ROOT / "checkpoints" / "DA3NESTED-GIANT-LARGE",
            DA3_ROOT / "checkpoints" / "DA3-GIANT-LARGE",
            Path.home() / ".cache" / "huggingface" / "hub" / "models--depth-anything--DA3NESTED-GIANT-LARGE",
        ]
        for p in possible_paths:
            if p.exists():
                model_path = str(p)
                break
        
        if model_path is None:
            # Fall back to HuggingFace model ID
            model_path = "depth-anything/DA3NESTED-GIANT-LARGE"
            print(f"No local model found, will download from HuggingFace: {model_path}")
    
    print(f"Loading DA3 model from: {model_path}")
    model = DepthAnything3.from_pretrained(model_path).to(device)
    
    # Collect images
    image_dir = Path(image_dir)
    image_extensions = ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.bmp']
    image_files = []
    for ext in image_extensions:
        image_files.extend(image_dir.glob(ext))
    
    # Sort with natural number ordering (consistent with inference code)
    # This ensures "2.jpg" comes before "10.jpg" for numeric filenames
    def natural_sort_key(path):
        """Sort key that handles numeric filenames correctly."""
        stem = path.stem
        try:
            return (0, int(stem), stem)  # Numeric names first, sorted numerically
        except ValueError:
            return (1, 0, stem)  # Non-numeric names after, sorted alphabetically
    
    image_files = sorted(image_files, key=natural_sort_key)
    
    if len(image_files) == 0:
        raise ValueError(f"No images found in {image_dir}")
    
    print(f"Found {len(image_files)} images:")
    for f in image_files:
        print(f"  - {f.name}")
    
    # Build export format
    export_format = "mini_npz"
    if save_visualization:
        export_format += "-glb-depth_vis"
    
    # Run inference
    print(f"\nRunning DA3 inference (process_res={process_res})...")
    prediction = model.inference(
        image=[str(f) for f in image_files],
        process_res=process_res,
        export_dir=str(output_path),
        export_format=export_format,
        show_cameras=True,
    )
    
    # Extract results
    depth = np.asarray(prediction.depth, dtype=np.float32)  # (N, H, W)
    extrinsics = np.asarray(prediction.extrinsics, dtype=np.float32)  # (N, 3, 4) or (N, 4, 4)
    intrinsics = np.asarray(prediction.intrinsics, dtype=np.float32)  # (N, 3, 3)
    
    print(f"\nDA3 Output:")
    print(f"  Depth shape: {depth.shape}")
    print(f"  Depth range: [{depth.min():.4f}, {depth.max():.4f}]")
    print(f"  Extrinsics shape: {extrinsics.shape}")
    print(f"  Intrinsics shape: {intrinsics.shape}")
    
    # Store one NHWC float32 array. Channel-first access is a transpose view.
    # Coordinates stay in OpenCV space; SAM3D performs its axis transform once.
    N = depth.shape[0]
    pointmaps = pointmaps_from_depth(depth, intrinsics)
    pointmaps_sam3d = pointmaps.transpose(0, 3, 1, 2)
    print(f"  Pointmaps shape: {pointmaps.shape} (float32, OpenCV camera space)")
    print(f"  Z range: [{pointmaps[..., 2].min():.4f}, {pointmaps[..., 2].max():.4f}]")

    # Save comprehensive output
    output_file = output_path / "da3_output.npz"
    np.savez(
        output_file,
        depth=depth,                          # (N, H, W)
        schema_version=2, pointmap_layout="NHWC", coordinate_system="opencv",
        pointmaps=pointmaps,                  # (N, H, W, 3), float32; no duplicate NCHW data
        extrinsics=extrinsics,                # (N, 3, 4) or (N, 4, 4)
        intrinsics=intrinsics,                # (N, 3, 3)
        image_files=np.array([str(f) for f in image_files]),
        process_res=process_res,
    )
    print(f"\nResults saved to: {output_file}")
    print(f"  - depth: {depth.shape}")
    print(f"  - pointmaps: {pointmaps.shape} (float32, OpenCV camera space)")
    print(f"  - pointmaps_sam3d: {pointmaps_sam3d.shape} (transpose view in memory only)")
    print(f"  - extrinsics: {extrinsics.shape}")
    print(f"  - intrinsics: {intrinsics.shape}")
    
    # Print summary of camera poses
    print(f"\nCamera poses (first 3 views):")
    for i in range(min(3, N)):
        ext = extrinsics[i]
        # Extract rotation and translation
        if ext.shape == (4, 4):
            R, t = ext[:3, :3], ext[:3, 3]
        else:
            R, t = ext[:, :3], ext[:, 3]
        print(f"  View {i}: t = [{t[0]:.3f}, {t[1]:.3f}, {t[2]:.3f}]")
    
    return {
        "depth": depth,
        "pointmaps": pointmaps,
        "pointmaps_sam3d": pointmaps_sam3d,
        "extrinsics": extrinsics,
        "intrinsics": intrinsics,
        "image_files": [str(f) for f in image_files],
    }


def main():
    parser = argparse.ArgumentParser(
        description="Run Depth Anything 3 on a folder of images",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Basic usage
    python scripts/run_da3.py --image_dir ./data/example/images --output_dir ./da3_outputs/example
    
    # Higher resolution
    python scripts/run_da3.py --image_dir ./data/example/images --output_dir ./da3_outputs/example --process_res 756
    
    # Without visualization (faster)
    python scripts/run_da3.py --image_dir ./data/example/images --output_dir ./da3_outputs/example --no_vis
        """
    )
    
    parser.add_argument(
        "--image_dir", 
        type=str, 
        required=True,
        help="Path to folder containing input images"
    )
    parser.add_argument(
        "--output_dir", 
        type=str, 
        required=True,
        help="Path to output directory"
    )
    parser.add_argument(
        "--model_path", 
        type=str, 
        default=None,
        help="Path to DA3 model checkpoint (default: auto-detect)"
    )
    parser.add_argument(
        "--process_res", 
        type=int, 
        default=504,
        help="Processing resolution (default: 504)"
    )
    parser.add_argument(
        "--no_vis", 
        action="store_true",
        help="Disable visualization output (GLB, depth_vis)"
    )
    parser.add_argument(
        "--device",
        type=str,
        default="cuda",
        help="Device to run on (default: cuda)"
    )
    
    args = parser.parse_args()
    
    run_da3_inference(
        image_dir=args.image_dir,
        output_dir=args.output_dir,
        model_path=args.model_path,
        process_res=args.process_res,
        save_visualization=not args.no_vis,
        device=args.device,
    )


if __name__ == "__main__":
    main()
