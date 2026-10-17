"""The small-object pass, run after `author` on its Room.blend without re-running it.

    python -m litereality_agent.pipeline.realism_authoring.small_objects <scene dir> [--only ID ...]

<scene dir> is a pipeline scene directory (it holds scene.json and realism_authoring/). Output
goes to realism_authoring/small_objects/ and never touches room_preview/:

    items.json              every candidate with its evidence, decision and rebuild
    evidence/<id>/          photo crops, the outlined frame, photo/render pairs
    renders/{before,after}/ the room rendered from the frames used as evidence
    rebuild/<id>/           evidence sheet, prompt, reference image, TRELLIS mesh (cleaned)
    room_preview/           the result: Room.blend, Room.glb, room_layout.json, apply.json
    summary.md, overview.jpg

Every step skips work already on disk, so an interrupted run resumes where it stopped.
Steps: candidates -> photo evidence -> render the current models -> Astra decides per item (one
question each) -> TRELLIS rebuilds -> apply -> render the rebuilds beside the photos for people
to review in overview.jpg.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw

from litereality_agent.pipeline.realism_authoring.small_objects import candidates, evidence, judge
from litereality_agent.room_ops.paths import find_blender

BLENDER_OPS = Path(__file__).with_name("blender_ops.py")
RES_DIV = 2  # renders at half the capture resolution are plenty for a side-by-side


class Pass:
    def __init__(self, scene_dir: Path, out: Path | None = None, only: list[str] | None = None,
                 concurrency: int = 4):
        self.scene_dir = scene_dir.resolve()
        scene = json.loads((self.scene_dir / "scene.json").read_text())
        self.frames = self.scene_dir / scene["paths"]["capture"]
        self.preview = self.scene_dir / scene["paths"]["authoring_preview"]
        self.out = (out or self.scene_dir / scene["paths"]["authoring"] / "small_objects").resolve()
        self.layout = json.loads((self.preview / "room_layout.json").read_text())
        self.cameras = {c["frame_index"]: c for c in self.layout["cameras"]}
        self.only = set(only or [])
        self.concurrency = concurrency
        (self.out / "logs").mkdir(parents=True, exist_ok=True)
        self.state_path = self.out / "items.json"
        self.items = (json.loads(self.state_path.read_text()) if self.state_path.exists()
                      else None)

    # ------------------------------------------------------------------ bookkeeping
    def save(self):
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, indent=1, ensure_ascii=False))
        tmp.replace(self.state_path)

    def log(self, message: str):
        print(f"[small-objects] {message}", flush=True)

    def active(self):
        return [item for item in self.items if not self.only or item["id"] in self.only]

    def blender(self, blend: Path, request: dict, name: str):
        request_path = self.out / "logs" / f"{name}.json"
        request_path.parent.mkdir(parents=True, exist_ok=True)
        request_path.write_text(json.dumps(request, indent=1))
        log = self.out / "logs" / f"{name}.log"
        cmd = [find_blender(), "-b", str(blend), "--python", str(BLENDER_OPS), "--",
               str(request_path)]
        with log.open("w") as handle:
            code = subprocess.run(cmd, stdout=handle, stderr=subprocess.STDOUT).returncode
        if code or f"DONE {request['op']}" not in log.read_text(errors="replace"):
            raise RuntimeError(f"Blender {name} failed (exit {code}); see {log}")

    # ------------------------------------------------------------------ steps
    def find(self):
        if self.items is None:
            self.items = candidates.find_candidates(self.layout)
            self.save()
        self.log(f"{len(self.items)} candidates: {', '.join(i['id'] for i in self.items)}")

    def gather_evidence(self):
        todo = [item for item in self.active() if "views" not in item]
        if not todo:
            return
        from litereality_agent.models.grounding_dino.service import DinoSubprocessService

        python = os.environ.get("LR_DINO_PYTHON") or os.environ.get("GROUNDING_DINO_PYTHON")
        detector = DinoSubprocessService(python=python)
        cameras = list(self.cameras.values())
        try:
            for item in todo:
                folder = self.out / "evidence" / item["id"]
                item["views"] = evidence.collect_views(item, cameras, self.frames, folder, detector)
                if item["views"]:
                    view = item["views"][0]
                    evidence.context_image(self.frames / view["frame_image"], view["rect"],
                                           view["turns"], folder / "context.jpg")
                found = sum(v["detected"] for v in item["views"])
                self.log(f"evidence {item['id']}: {len(item['views'])} views, {found} detected")
                self.save()
        finally:
            detector.close()

    def render_pairs(self, blend: Path, items: list[dict], stage: str):
        """Render each item's primary frame from `blend` and pair it with the photo crop."""
        items = [i for i in items if i["views"] and not (self.out / "evidence" / i["id"]
                                                          / f"pair_{stage}.jpg").exists()]
        if not items:
            return
        renders = self.out / "renders" / stage
        frames = sorted({i["views"][0]["frame"] for i in items})
        missing = [f for f in frames if not (renders / f"frame_{f:05d}.png").exists()]
        if missing:
            resolution = self.cameras[frames[0]]["resolution"]
            self.blender(blend, {"op": "render", "frames": missing, "out_dir": str(renders),
                                 "resolution": resolution, "res_div": RES_DIV},
                         f"render_{stage}")
        label = "CURRENT MODEL" if stage == "before" else "REBUILT MODEL"
        for item in items:
            view = item["views"][0]
            evidence.pair_image(self.frames / view["frame_image"],
                                renders / f"frame_{view['frame']:05d}.png", view,
                                self.out / "evidence" / item["id"] / f"pair_{stage}.jpg",
                                1 / RES_DIV, ("PHOTO", f"{label} (render, same camera)"))

    async def _ask(self, item, key, images, prompt, parse):
        from litereality_agent.agent.providers.vision import ask_images

        folder = self.out / "evidence" / item["id"]
        last = None
        for attempt in range(2):
            try:
                reply = await ask_images(images, prompt, role="agent", cwd=folder,
                                         timeout_seconds=600)
                (folder / f"{key}_reply.txt").write_text(reply, encoding="utf-8")
                item[key] = parse(reply)
                item.setdefault("astra_calls", 0)
                item["astra_calls"] += attempt + 1
                self.save()
                return
            except Exception as exc:  # noqa: BLE001 — recorded, and the item is left as it was
                last = f"{type(exc).__name__}: {exc}"
        item[f"{key}_error"] = last
        item["astra_calls"] = item.get("astra_calls", 0) + 2
        self.save()

    async def _ask_all(self, jobs):
        gate = asyncio.Semaphore(self.concurrency)

        async def one(job):
            async with gate:
                await self._ask(*job)
                self.log(f"{job[1]} {job[0]['id']}: {job[0].get(job[1]) or job[0].get(job[1] + '_error')}")

        await asyncio.gather(*(one(job) for job in jobs))

    def decide(self):
        jobs = []
        for item in self.active():
            if "decision" in item:
                continue
            if not item["views"]:
                item["decision"] = {"decision": "drop", "reason": "not visible in any capture "
                                    "frame", "description": ""}
                continue
            folder = self.out / "evidence" / item["id"]
            images = [folder / "context.jpg", folder / "pair_before.jpg",
                      *[v["image"] for v in item["views"][1:]]]
            detected = any(v["detected"] for v in item["views"])
            jobs.append((item, "decision", images, judge.decide_prompt(item, detected),
                         judge.parse_decision))
        self.save()
        if jobs:
            asyncio.run(self._ask_all(jobs))

    def rebuild(self):
        from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

        wanted = [i for i in self.active() if i.get("decision", {}).get("decision") == "trellis"]
        todo = [i for i in wanted if "reference" not in i]

        def reference(item):
            folder = self.out / "rebuild" / item["id"]
            tiles = evidence.generator_inputs(item["views"], folder / "tiles")
            try:
                meta = rebuild.make_reference(item, tiles, item["decision"]["description"],
                                              folder)
                item["reference"] = str(folder / "reference.png")
                item.pop("reference_error", None)
                item["image_cost_usd"] = (meta or {}).get("cost_usd") or 0
            except Exception as exc:  # noqa: BLE001
                item["reference_error"] = f"{type(exc).__name__}: {exc}"
            self.save()

        with ThreadPoolExecutor(self.concurrency) as pool:
            list(pool.map(reference, todo))
        pending = {i["id"]: Path(i["reference"]) for i in wanted
                   if i.get("reference") and "glb" not in i}  # includes earlier failures
        if pending:
            self.log(f"TRELLIS on {len(pending)} items")
            work = self.out / "rebuild" / "_trellis"
            work.mkdir(parents=True, exist_ok=True)
            made = rebuild.run_trellis(pending, work, self.out / "logs" / "trellis.log")
            for item in wanted:
                if item["id"] in made and "glb" not in item:
                    clean = self.out / "rebuild" / item["id"] / "mesh.glb"
                    item["fragments"] = rebuild.drop_fragments(made[item["id"]]["glb"], clean)
                    item["trellis_pipeline"] = made[item["id"]]["pipeline"]
                    item["glb"] = str(clean)
                    item.pop("glb_error", None)
                elif item["id"] in pending:
                    item["glb_error"] = "TRELLIS wrote no mesh"
            self.save()

    def plan(self, items):
        drop, replace = [], []
        for item in items:
            decision = item.get("decision", {}).get("decision")
            if decision == "drop":
                drop.append({"id": item["id"], "members": item["members"]})
            elif decision == "trellis" and item.get("glb"):  # a failed rebuild keeps its model
                camera = self.cameras[item["views"][0]["frame"]]["position"]
                replace.append({"id": item["id"], "members": item["members"],
                                "category": item["category"], "glb": item["glb"],
                                "camera": camera})
        return drop, replace

    def apply(self):
        """Drops and rebuilds applied to the author's Room.blend, written to room_preview/."""
        final = self.out / "room_preview"
        drop, replace = self.plan(self.items)
        plan = {"drop": drop, "replace": replace}
        record = final / "plan.json"
        if record.exists() and json.loads(record.read_text()) != plan:
            # A rerun finished rebuilds that failed before: the derived room is made again.
            self.log("plan changed since the last apply: rebuilding room_preview")
            shutil.rmtree(final)
            shutil.rmtree(self.out / "renders" / "after", ignore_errors=True)
            for item in self.items:
                (self.out / "evidence" / item["id"] / "pair_after.jpg").unlink(missing_ok=True)
        if not (final / "Room.blend").exists():
            self.blender(self.preview / "Room.blend",
                         {"op": "apply", "layout": str(self.preview / "room_layout.json"),
                          "out_dir": str(final), **plan}, "apply")
            record.write_text(json.dumps(plan, indent=1))
        # For people to look at (overview.jpg); nobody asks a model about these.
        rebuilt = [i for i in self.items if i.get("glb") and
                   i["decision"]["decision"] == "trellis"]
        self.render_pairs(final / "Room.blend", rebuilt, "after")

    def outcome(self, item) -> str:
        decision = item.get("decision", {}).get("decision")
        if decision is None:
            return "unchanged (no decision: " + item.get("decision_error", "not judged") + ")"
        if decision == "procedural":
            return "kept procedural"
        if decision == "drop":
            return "dropped"
        if not item.get("glb"):
            return "unchanged, rebuild failed (" + str(item.get("reference_error")
                                                      or item.get("glb_error")) + "); rerun to retry"
        return "rebuilt with TRELLIS"

    def summarize(self):
        rows, cost, calls = [], 0.0, 0
        for item in self.items:
            cost += item.get("image_cost_usd") or 0
            calls += item.get("astra_calls", 0)
            reason = item.get("decision", {}).get("reason", "")
            rows.append(f"| {item['id']} | {len(item['members'])} | {self.outcome(item)} | "
                        f"{reason} |")
        text = ["# Small objects", "",
                f"{len(self.items)} candidates, {calls} Astra calls, image generation "
                f"${cost:.2f}.", "",
                "| item | objects | result | Astra |", "|---|---|---|---|", *rows, ""]
        (self.out / "summary.md").write_text("\n".join(text), encoding="utf-8")
        self.overview()
        self.log(f"done: {self.out / 'summary.md'}")

    def overview(self, height: int = 300):
        """One row per rebuilt item: photo | old model | rebuilt model (from the pair images)."""
        rows = []
        for item in self.items:
            folder = self.out / "evidence" / item["id"]
            before, after = folder / "pair_before.jpg", folder / "pair_after.jpg"
            if not (before.exists() and after.exists()):
                continue
            with Image.open(before) as b, Image.open(after) as a:
                b, a = b.convert("RGB"), a.convert("RGB")
                right = a.crop((a.width // 2 + 6, 0, a.width, a.height))
                row = Image.new("RGB", (b.width + right.width + 6, b.height + 34), (30, 30, 30))
                row.paste(b, (0, 34))
                row.paste(right, (b.width + 6, 34))
            ImageDraw.Draw(row).text((8, 6), f"{item['id']}: {self.outcome(item)}",
                                     fill=(255, 220, 120), font=evidence._font(22))
            row.thumbnail((10_000, height))
            rows.append(row)
        if not rows:
            return
        width = max(r.width for r in rows)
        sheet = Image.new("RGB", (width, sum(r.height for r in rows)), (30, 30, 30))
        y = 0
        for row in rows:
            sheet.paste(row, (0, y))
            y += row.height
        sheet.save(self.out / "overview.jpg", quality=88)

    def run(self, through: str | None = None):
        """All steps in order; `through` stops after evidence, decide or rebuild."""
        self.find()
        self.gather_evidence()
        self.render_pairs(self.preview / "Room.blend", self.active(), "before")
        if through == "evidence":
            return
        self.decide()
        if through == "decide":
            return
        self.rebuild()
        if through == "rebuild" or self.only:  # a partial run stops before touching the room
            self.log("stopping before apply")
            return
        self.apply()
        self.summarize()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scene_dir", type=Path)
    parser.add_argument("--out", type=Path, help="default: realism_authoring/small_objects")
    parser.add_argument("--only", nargs="*", help="judge and rebuild only these items")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--list", action="store_true", help="print the candidates and exit")
    parser.add_argument("--through", choices=("evidence", "decide", "rebuild"),
                        help="stop after this step (the room is not changed)")
    args = parser.parse_args(argv)
    small = Pass(args.scene_dir, args.out, args.only, args.concurrency)
    if args.list:
        small.find()
        return 0
    small.run(args.through)
    return 0


if __name__ == "__main__":
    sys.exit(main())
