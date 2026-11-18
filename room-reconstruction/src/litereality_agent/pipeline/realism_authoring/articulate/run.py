"""The articulation pass, run after `author` on its Room.blend without re-running it.

    python -m litereality_agent.pipeline.realism_authoring.articulate <scene dir> [--out DIR]
                                                                       [--only ID ...]

<scene dir> is a pipeline scene directory (scene.json, realism_authoring/). Output goes to
--out (default realism_authoring/articulate/) and never touches the author's room_preview/:

    items.json              every candidate: box, Astra's plan, the cut, the check
    views/<id>/             metric front/side renders of the model alone (+ the grids), photos
    draft/                  Room.blend and Room.glb with every planned part cut
    check/<id>/             the cut object closed and opened, for the check
    room_preview/           the result: Room.blend, Room.glb, room_layout.json (only kept parts)
    room/Objects/           the run's own Objects (linked) + Articulated/<id>/sim/<id>.urdf, so
                            web/scripts/room_objects.py finds every joint beside room_preview/
    summary.md, overview.jpg

Steps: candidates -> views -> photos -> Astra decides per object (does it open, where, how) ->
cut everything planned (draft) -> render closed/open -> Astra checks each part -> the kept parts
are cut again from the author's room (room_preview). Every step skips work already on disk.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from litereality_agent import artifact_cache as cache
from litereality_agent.pipeline.realism_authoring import pass_cache
from litereality_agent.pipeline.realism_authoring.articulate import candidates, judge, urdf
from litereality_agent.pipeline.realism_authoring.small_objects import evidence
from litereality_agent.room_ops.paths import find_blender

BLENDER_OPS = Path(__file__).with_name("blender_ops.py")
PHOTOS = 3  # photo crops per object


def grid(png: Path, meta: dict, view: str, out: Path):
    """A metric grid over an orthographic view: lines every 0.1 m, labels every 0.2 m (or every
    0.5 / 1 m for large objects), in the object's own frame."""
    image = Image.open(png).convert("RGB")
    draw = ImageDraw.Draw(image)
    px, span = meta["pixels"], meta["span_m"]
    centre, right = meta["views"][view]["center"], meta["views"][view]["right"]
    h = 0 if abs(right[0]) > 0.5 else 1
    sign = 1 if right[h] > 0 else -1
    step = 0.1 if span < 2.5 else 0.25
    label = 2 if span < 2.5 else 4
    to_u = lambda value: px / 2 + sign * (value - centre[h]) / span * px  # noqa: E731
    to_v = lambda z: px / 2 - (z - centre[2]) / span * px  # noqa: E731
    lo, hi = meta["box_min"], meta["box_max"]
    font = evidence._font(15)
    for i in range(math.floor(lo[h] / step) - 2, math.ceil(hi[h] / step) + 3):
        u = to_u(i * step)
        draw.line([(u, 0), (u, px)], fill=(220, 40, 40) if i % label == 0 else (240, 160, 160))
        if i % label == 0:
            draw.text((u + 2, px - 18), f"{'XY'[h]} {i * step:+.2f}", fill=(200, 0, 0), font=font)
    for i in range(math.floor(lo[2] / step) - 2, math.ceil(hi[2] / step) + 3):
        v = to_v(i * step)
        draw.line([(0, v), (px, v)], fill=(40, 40, 220) if i % label == 0 else (160, 160, 240))
        if i % label == 0:
            draw.text((2, v + 2), f"Z {i * step:+.2f}", fill=(0, 0, 200), font=font)
    image.save(out)


def tiles(paths, out: Path, columns: int = 2):
    """Equal-sized images in a grid, row by row."""
    images = [Image.open(p).convert("RGB") for p in paths]
    w, h = images[0].size
    rows = math.ceil(len(images) / columns)
    sheet = Image.new("RGB", (w * columns + 6 * (columns - 1), h * rows + 6 * (rows - 1)),
                      (40, 40, 40))
    for n, image in enumerate(images):
        sheet.paste(image.resize((w, h)), ((n % columns) * (w + 6), (n // columns) * (h + 6)))
    sheet.save(out, quality=90)
    return out


def side_by_side(paths, out: Path, height: int = 420):
    tiles = []
    for path in paths:
        with Image.open(path) as image:
            tile = image.convert("RGB")
        tiles.append(tile.resize((round(tile.width * height / tile.height), height)))
    sheet = Image.new("RGB", (sum(t.width for t in tiles) + 8 * (len(tiles) - 1), height),
                      (40, 40, 40))
    x = 0
    for tile in tiles:
        sheet.paste(tile, (x, 0))
        x += tile.width + 8
    sheet.save(out, quality=90)
    return out


class Pass:
    def __init__(self, scene_dir: Path, out: Path | None = None, only: list[str] | None = None,
                 concurrency: int = 4):
        self.scene_dir = scene_dir.resolve()
        scene = json.loads((self.scene_dir / "scene.json").read_text())
        self.frames = self.scene_dir / scene["paths"]["capture"]
        self.preview = self.scene_dir / scene["paths"]["authoring_preview"]
        self.room = self.scene_dir / scene["paths"]["authoring_room"]
        self.out = (out or self.scene_dir / scene["paths"]["authoring"] / "articulate").resolve()
        self.layout = json.loads((self.preview / "room_layout.json").read_text())
        self.cameras = list(self.layout["cameras"])
        self.only = set(only or [])
        self.concurrency = concurrency
        (self.out / "logs").mkdir(parents=True, exist_ok=True)
        self.dependency_key = pass_cache.prepare(
            self.out, self.preview, self.frames, self.layout, Path(__file__).parent)
        self.state_path = self.out / "items.json"
        self.items = (json.loads(self.state_path.read_text()) if self.state_path.exists()
                      else None)

    # ------------------------------------------------------------------ bookkeeping
    def save(self):
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.items, indent=1, ensure_ascii=False))
        tmp.replace(self.state_path)

    def log(self, message: str):
        print(f"[articulate] {message}", flush=True)

    def active(self):
        return [item for item in self.items if not self.only or item["id"] in self.only]

    def blender(self, blend: Path, request: dict, name: str):
        request_path = self.out / "logs" / f"{name}.json"
        request_path.write_text(json.dumps(request, indent=1))
        log = self.out / "logs" / f"{name}.log"
        cmd = [find_blender(), "-b", str(blend), "--python", str(BLENDER_OPS), "--",
               str(request_path)]
        with log.open("w") as handle:
            code = subprocess.run(cmd, stdout=handle, stderr=subprocess.STDOUT).returncode
        if code or f"DONE {request['op']}" not in log.read_text(errors="replace"):
            raise RuntimeError(f"Blender {name} failed (exit {code}); see {log}")

    async def _ask(self, item, key, images, prompt, parse):
        from litereality_agent.agent.providers.vision import ask_images

        folder = self.out / "views" / item["id"]
        last = None
        for attempt in range(2):
            try:
                reply = await ask_images(images, prompt, role="agent", cwd=folder,
                                         timeout_seconds=600)
                (folder / f"{key}_reply.txt").write_text(reply, encoding="utf-8")
                item[key] = parse(reply)
                item.pop(f"{key}_error", None)
                item["astra_calls"] = item.get("astra_calls", 0) + attempt + 1
                self.save()
                return
            except Exception as exc:  # noqa: BLE001 — recorded; the object is left as it was
                last = f"{type(exc).__name__}: {exc}"
        item[f"{key}_error"] = last
        item["astra_calls"] = item.get("astra_calls", 0) + 2
        self.save()

    def ask_all(self, jobs):
        async def run():
            gate = asyncio.Semaphore(self.concurrency)

            async def one(job):
                async with gate:
                    await self._ask(*job)
                    item, key = job[0], job[1]
                    self.log(f"{key} {item['id']}: {item.get(key) or item.get(key + '_error')}")

            await asyncio.gather(*(one(job) for job in jobs))

        if jobs:
            asyncio.run(run())

    # ------------------------------------------------------------------ steps
    def find(self):
        if self.items is None:
            self.items = candidates.find_candidates(self.layout)
            self.save()
        self.log(f"{len(self.items)} candidates: {', '.join(i['id'] for i in self.items)}")

    def views(self):
        todo = [i for i in self.active() if "box" not in i]
        if todo:
            self.blender(self.preview / "Room.blend",
                         {"op": "views", "items": [i["id"] for i in todo],
                          "out_dir": str(self.out / "views")}, "views")
        for item in todo:
            folder = self.out / "views" / item["id"]
            meta = json.loads((folder / "views.json").read_text())
            if "error" in meta:
                item["skip"] = meta["error"]
                continue
            item["box"] = {"min": meta["box_min"], "max": meta["box_max"]}
            item["existing"] = meta["existing"]
            for view in ("front", "side"):
                grid(folder / f"{view}.png", meta, view, folder / f"{view}_grid.png")
            tiles([folder / f"perspective_{n}.png" for n in range(4)], folder / "perspective.jpg")
        self.save()

    def photos(self):
        for item in self.active():
            if "photos" in item or "box" not in item:
                continue
            folder = self.out / "views" / item["id"] / "photos"
            views = evidence.collect_views(item, self.cameras, self.frames, folder, None)
            item["photos"] = [v["image"] for v in views[:PHOTOS]]
            self.save()

    def decide(self):
        jobs = []
        for item in self.active():
            if "plan" in item or "box" not in item:
                continue
            if not item["photos"]:
                item["plan"] = {"openable": False, "reason": "not seen in any capture frame",
                                "parts": [], "rejected": []}
                continue
            folder = self.out / "views" / item["id"]
            images = [folder / "front_grid.png", folder / "side_grid.png",
                      folder / "perspective.jpg", *item["photos"]]
            box = item["box"]
            jobs.append((item, "plan", images, judge.decide_prompt(item, box, item["existing"]),
                         lambda text, box=box: judge.parse_plan(text, box)))
        self.save()
        self.ask_all(jobs)

    def planned(self, key: str = "plan") -> list[dict]:
        """Objects with parts to cut: from the plan, or (key="kept") only the parts kept."""
        out = []
        for item in self.items:
            parts = (item.get("plan") or {}).get("parts") or []
            if key == "kept":
                verdicts = item.get("check") or {}
                parts = [p for p in parts if verdicts.get(p["name"], {}).get("keep")]
            if parts:
                out.append({"id": item["id"], "parts": parts})
        return out

    def cut(self, target: Path, plan: list[dict], name: str):
        """Cut `plan` from the author's Room.blend into target/, unless it is already there."""
        key = cache.fingerprint({"source": self.dependency_key, "plan": plan})
        if pass_cache.bundle_matches(target, key, ("Room.blend", "Room.glb", "apply.json")):
            return False
        cache.retire([target], self.out)
        try:
            self.blender(self.preview / "Room.blend",
                         {"op": "apply", "out_dir": str(target), "items": plan}, name)
            pass_cache.record_bundle(target, key, ("Room.blend", "Room.glb", "apply.json"))
            cache.atomic_json(target / "plan.json", plan)
        except BaseException:
            cache.retire([target], self.out)
            raise
        return True

    def draft(self):
        plan = self.planned()
        if not plan:
            return
        if self.cut(self.out / "draft", plan, "draft"):
            cache.retire([self.out / "check", self.out / "room_preview"], self.out)
            for item in self.items:
                item.pop("check", None)
                item.pop("check_error", None)
            self.save()
        todo = [p["id"] for p in plan
                if not (self.out / "check" / p["id"] / "open_3.png").exists()]
        if todo:
            self.blender(self.out / "draft" / "Room.blend",
                         {"op": "check", "items": todo, "out_dir": str(self.out / "check")},
                         "check")

    def check(self):
        jobs = []
        cut = {row["id"]: row["parts"]
               for row in json.loads((self.out / "draft" / "apply.json").read_text())["cut"]} \
            if (self.out / "draft" / "apply.json").exists() else {}
        for item in self.items:
            parts = (item.get("plan") or {}).get("parts") or []
            if not parts or "check" in item:
                continue
            made = {p["name"] for p in cut.get(item["id"], [])}
            if not made:
                item["check"] = {p["name"]: {"keep": False, "reason": "nothing to cut in its box"}
                                 for p in parts}
                continue
            folder = self.out / "check" / item["id"]
            closed = tiles([folder / f"closed_{n}.png" for n in range(4)], folder / "closed.jpg")
            opened = tiles([folder / f"open_{n}.png" for n in range(4)], folder / "open.jpg")
            names = [p["name"] for p in parts if p["name"] in made]
            jobs.append((item, "check", [closed, opened, *item["photos"][:2]],
                         judge.check_prompt(item, [p for p in parts if p["name"] in made]),
                         lambda text, names=names: judge.parse_check(text, names)))
        self.save()
        self.ask_all(jobs)

    def final(self):
        """The kept parts, cut again from the author's room; joints written beside it."""
        final = self.out / "room_preview"
        kept = self.planned("kept")
        if kept:
            key = cache.fingerprint({"source": self.dependency_key, "plan": kept})
            draft = self.out / "draft"
            if pass_cache.bundle_matches(draft, key, ("Room.blend", "Room.glb", "apply.json")):
                if not pass_cache.bundle_matches(final, key, ("Room.blend", "Room.glb", "apply.json")):
                    cache.retire([final], self.out)
                    shutil.copytree(draft, final)
            else:
                self.cut(final, kept, "final")
        else:
            cache.retire([final], self.out)
            final.mkdir(parents=True)
            for name in ("Room.blend", "Room.glb"):
                shutil.copyfile(self.preview / name, final / name)
        shutil.copyfile(self.preview / "room_layout.json", final / "room_layout.json")
        objects = self.out / "room" / "Objects"
        shutil.rmtree(objects, ignore_errors=True)
        objects.mkdir(parents=True)
        for source in sorted((self.room / "Objects").iterdir()):
            if source.is_dir():
                (objects / source.name).symlink_to(source)
        for row in kept:
            urdf.write(row["id"], row["parts"], objects)
        self.log(f"kept {sum(len(r['parts']) for r in kept)} parts on {len(kept)} objects")

    def summarize(self):
        rows, calls = [], 0
        for item in self.items:
            calls += item.get("astra_calls", 0)
            plan = item.get("plan") or {}
            verdicts = item.get("check") or {}
            if item.get("skip"):
                result = "skipped: " + item["skip"]
            elif "plan" not in item:
                result = "not judged: " + str(item.get("plan_error", ""))
            elif not plan.get("parts"):
                result = "does not open: " + plan.get("reason", "")
            else:
                result = "; ".join(
                    f"{p['name']} {p['joint']} {'kept' if verdicts.get(p['name'], {}).get('keep') else 'dropped'}"
                    f" ({verdicts.get(p['name'], {}).get('reason', '')})" for p in plan["parts"])
            for r in plan.get("rejected", []):
                result += f"; {r['name']} not cut ({r['reason']})"
            rows.append(f"| {item['id']} | {item['category']} | {result} |")
        kept = self.planned("kept")
        text = ["# Openable parts", "",
                f"{len(self.items)} candidates, {calls} Astra calls, "
                f"{sum(len(r['parts']) for r in kept)} parts kept on {len(kept)} objects.", "",
                "| object | category | result |", "|---|---|---|", *rows, ""]
        failed = [i["id"] for i in self.items if i.get("plan_error") or i.get("check_error")]
        skipped = [i["id"] for i in self.items if i.get("skip") or
                   ("plan" in i and not (i.get("plan") or {}).get("parts"))]
        added = sum(len(row["parts"]) for row in kept)
        existing = sum(len(i.get("existing") or []) for i in self.items)
        if added:
            reason = ""
        elif not self.items:
            reason = "no candidate objects"
        elif failed:
            reason = "no new joints accepted; some candidate checks failed"
        elif not self.planned():
            reason = "candidates contain no additional openable parts"
        else:
            reason = "all proposed new parts were rejected by the check"
        cache.atomic_json(self.out / "summary.json", {
            "attempt_id": os.environ.get("LITEREALITY_RUN_ID"),
            "schema_version": 1, "existing": existing, "candidates": len(self.items),
            "added": added, "skipped": len(skipped), "failed": len(failed),
            "units": {"existing": "joints", "added": "joints", "candidates": "objects",
                      "skipped": "objects", "failed": "objects"},
            "zero_added_reason": reason, "failed_objects": failed, "skipped_objects": skipped,
        })
        (self.out / "summary.md").write_text("\n".join(text), encoding="utf-8")
        self.overview()
        self.log(f"done: {self.out / 'summary.md'}")

    def overview(self, height: int = 300):
        sheets = []
        for item in self.items:
            folder = self.out / "check" / item["id"]
            if not (folder / "open_3.png").exists() or not item.get("photos"):
                continue
            for state in ("closed", "open"):  # also after a re-cut, which asks nothing
                tiles([folder / f"{state}_{n}.png" for n in range(4)], folder / f"{state}.jpg")
            row = side_by_side([item["photos"][0], folder / "closed.jpg", folder / "open.jpg"],
                               folder / "row.jpg", height)
            with Image.open(row) as image:
                tile = Image.new("RGB", (image.width, image.height + 30), (30, 30, 30))
                tile.paste(image, (0, 30))
            kept = [n for n, v in (item.get("check") or {}).items() if v.get("keep")]
            ImageDraw.Draw(tile).text((8, 6), f"{item['id']}: kept {', '.join(kept) or 'none'}",
                                      fill=(255, 220, 120), font=evidence._font(20))
            sheets.append(tile)
        if not sheets:
            return
        width = max(s.width for s in sheets)
        sheet = Image.new("RGB", (width, sum(s.height for s in sheets)), (30, 30, 30))
        y = 0
        for tile in sheets:
            sheet.paste(tile, (0, y))
            y += tile.height
        sheet.save(self.out / "overview.jpg", quality=88)

    def run(self, through: str | None = None):
        self.find()
        self.views()
        self.photos()
        if through == "views":
            return
        self.decide()
        if through == "decide":
            return
        self.draft()
        self.check()
        if self.only:  # a partial run never writes the room
            self.log("stopping before the final room (--only)")
            return
        self.final()
        self.summarize()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scene_dir", type=Path)
    parser.add_argument("--out", type=Path, help="default: realism_authoring/articulate")
    parser.add_argument("--only", nargs="*", help="look at only these objects")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--list", action="store_true", help="print the candidates and exit")
    parser.add_argument("--through", choices=("views", "decide"),
                        help="stop after this step (nothing is cut)")
    args = parser.parse_args(argv)
    work = Pass(args.scene_dir, args.out, args.only, args.concurrency)
    if args.list:
        work.find()
        return 0
    work.run(args.through)
    return 0


if __name__ == "__main__":
    sys.exit(main())
