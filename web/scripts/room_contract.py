"""Public room API constants shared by the HTTP, job and executor modules."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREFIX = "/room-reconstruction"
STAGES = ["ingest", "reconstruct", "seed", "author", "publish"]
ASSETS = {"Room.glb", "room_objects.json", "thumbnail.jpg"}
