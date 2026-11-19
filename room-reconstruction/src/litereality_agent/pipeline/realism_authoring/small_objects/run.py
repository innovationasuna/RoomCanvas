"""The small-object pass, run after `author` on its Room.blend without re-running it.

    python -m litereality_agent.pipeline.realism_authoring.small_objects <scene dir> [--only ID ...]

<scene dir> is a pipeline scene directory (it holds scene.json and realism_authoring/). Output
goes to realism_authoring/small_objects/ and never touches room_preview/:

    items.json              every candidate with its evidence, decision and rebuild
    evidence/<id>/          photo crops, the outlined frame, photo/render pairs
    renders/{before,after}/ the room rendered from the frames used as evidence
    rebuild/<id>/           evidence sheet, prompt, reference image, TRELLIS mesh (cleaned,
                            then model.glb: hue turned back to the reference, metal zeroed)
    room_preview/           the result: Room.blend, Room.glb, room_layout.json, apply.json
    candidates.md           every item's id, the author's objects in it and its evidence folder
    summary.md, overview.jpg

Every step skips work already on disk, so an interrupted run resumes where it stopped.
Steps: candidates -> photo evidence -> render the current models -> Astra decides per item (one
question each) -> TRELLIS rebuilds -> apply -> render the rebuilds beside the photos for people
to review in overview.jpg.

The operator may steer it through the environment (all optional):
    LR_SMALL_OBJECTS_POLICY=trellis-first   Astra rebuilds what it can see and drops only what has
                                            no usable evidence (judge.TRELLIS_FIRST)
    LR_SMALL_OBJECTS_FORCE=ID=trellis,...   overrides Astra's decision for these items
    LR_SMALL_OBJECTS_PHOTOS=<dir>           <dir>/<item id>/*.jpg: close-ups of that item, shown to
                                            Astra and leading its reference sheet
    LR_SMALL_OBJECTS_MODELS=<dir>           <dir>/<Kind>.glb from `premake` (or <dir>/<id>.glb):
                                            used for item <Kind>, <Kind>0, <Kind>12 ... as if
                                            TRELLIS had rebuilt it; Astra is not asked about it
Photos, policy and a supplied model are part of each item's own inputs: changing them judges and
rebuilds again only the items they concern. Each item's outcome is traced as `small_object_done`
when it is settled.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from PIL import Image, ImageDraw

from litereality_agent import artifact_cache as cache
from litereality_agent import telemetry
from litereality_agent.pipeline.realism_authoring import pass_cache
from litereality_agent.pipeline.realism_authoring.small_objects import candidates, evidence, judge
from litereality_agent.room_ops.paths import find_blender

BLENDER_OPS = Path(__file__).with_name("blender_ops.py")
RES_DIV = 2  # renders at half the capture resolution are plenty for a side-by-side
# What an item's judgement and rebuild leave in items.json; cleared when its own inputs change.
DERIVED = ("decision", "decision_error", "reference", "reference_error", "glb", "glb_error",
           "fragments", "trellis_pipeline", "material")


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
        self.dependency_key = pass_cache.prepare(
            self.out, self.preview, self.frames, self.layout, Path(__file__).parent)
        self.state_path = self.out / "items.json"
        self.items = (json.loads(self.state_path.read_text()) if self.state_path.exists()
                      else None)
        self.policy = os.environ.get("LR_SMALL_OBJECTS_POLICY", "").strip() or None
        if self.policy and self.policy not in judge.POLICIES:
            raise ValueError(f"LR_SMALL_OBJECTS_POLICY={self.policy}: one of {judge.POLICIES}")
        self.force = judge.parse_force(os.environ.get("LR_SMALL_OBJECTS_FORCE", ""))
        photos = os.environ.get("LR_SMALL_OBJECTS_PHOTOS", "").strip()
        self.photo_root = Path(photos).expanduser().resolve() if photos else None
        if self.photo_root and not self.photo_root.is_dir():
            raise FileNotFoundError(f"LR_SMALL_OBJECTS_PHOTOS={photos} is not a directory")
        models = os.environ.get("LR_SMALL_OBJECTS_MODELS", "").strip()
        self.model_root = Path(models).expanduser().resolve() if models else None
        if self.model_root and not self.model_root.is_dir():
            raise FileNotFoundError(f"LR_SMALL_OBJECTS_MODELS={models} is not a directory")
        self.run_id = os.environ.get("LITEREALITY_RUN_ID") or uuid.uuid4().hex
        self.reported: set[str] = set()  # items whose small_object_done this run has written

    # ------------------------------------------------------------------ bookkeeping
    def save(self):
        handle = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.out, delete=False)
        tmp = Path(handle.name)
        try:
            with handle:
                json.dump(self.items, handle, indent=1, ensure_ascii=False)
            tmp.replace(self.state_path)
        finally:
            tmp.unlink(missing_ok=True)

    def log(self, message: str):
        print(f"[small-objects] {message}", flush=True)

    def active(self):
        return [item for item in self.items if not self.only or item["id"] in self.only]

    def record(self, kind: str, **data):
        """One record in the scene's trace, where the replay reads the pipeline's own."""
        traces = self.scene_dir / "scene_init/obj_stage/traces"
        traces.mkdir(parents=True, exist_ok=True)
        telemetry.record(traces, kind, run=self.run_id, stage="small_objects",
                         job_id=os.environ.get("LITEREALITY_JOB_ID") or str(self.scene_dir), **data)

    def finished(self, item, reused: bool):
        """`small_object_done` once per item and run, when its outcome is settled: now, also when
        that outcome was already on disk (then `reused`)."""
        if item["id"] in self.reported:
            return
        self.reported.add(item["id"])
        decision = item.get("decision", {}).get("decision")
        method = {"drop": "dropped", "procedural": "procedural"}.get(decision, "kept")
        if decision == "trellis" and item.get("glb"):
            method = "trellis"
        source = item["decision"].get("source") if method == "trellis" else None
        self.record("small_object_done", name=item["id"], method=method,
                    status="failed" if method == "kept" else "ok", reused=reused,
                    **({"source": source} if source else {}))

    def photos(self, item) -> list[Path]:
        """The operator's close-ups of this item, <LR_SMALL_OBJECTS_PHOTOS>/<id>/*.jpg."""
        folder = self.photo_root / item["id"] if self.photo_root else None
        if folder is None or not folder.is_dir():
            return []
        return sorted(p for p in folder.iterdir()
                      if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg"))

    def model(self, item) -> Path | None:
        """The operator's premade mesh for this item: <LR_SMALL_OBJECTS_MODELS>/<id>.glb, else
        <Kind>.glb for an id that is <Kind> followed only by digits (TissueBox0, TissueBox12)."""
        if self.model_root is None:
            return None
        for name in (item["id"], item["id"].rstrip("0123456789")):
            if name and (self.model_root / f"{name}.glb").is_file():
                return self.model_root / f"{name}.glb"
        return None

    def inputs(self, item) -> str | None:
        """What decides an item besides the room: its photos, the policy and a supplied model.
        None when there is none of them, so an item judged before they existed keeps its results."""
        photos, model = self.photos(item), self.model(item)
        if not photos and not self.policy and not model:
            return None
        key = {"policy": self.policy, "photos": {p.name: cache.file_hash(p) for p in photos}}
        if model:  # only then, so the key of an item without one stays what it was
            key["model"] = cache.file_hash(model)
        return cache.fingerprint(key)

    def refresh(self):
        """Judge and rebuild again only the items whose own inputs changed. The room-wide key
        (pass_cache.prepare) stays as it is, so the other items keep their results."""
        ids = {item["id"] for item in self.items}
        unknown = sorted(set(self.force) - ids)
        if unknown:
            raise ValueError(f"LR_SMALL_OBJECTS_FORCE names no candidate: {', '.join(unknown)} "
                             f"(candidates: {', '.join(sorted(ids))})")
        if self.photo_root:
            stray = sorted(p.name for p in self.photo_root.iterdir()
                           if p.is_dir() and p.name not in ids)
            if stray:
                self.log(f"photos for no candidate (ignored): {', '.join(stray)}")
        if self.model_root:  # the author may not have placed every thing the operator modelled
            used = {self.model(item) for item in self.items}
            unused = sorted(p.name for p in self.model_root.glob("*.glb") if p not in used)
            if unused:
                self.log(f"models for no candidate (ignored): {', '.join(unused)}")
        changed = False
        for item in self.items:
            key = self.inputs(item)
            if item.get("inputs") == key:
                continue
            changed = True
            if any(name in item for name in DERIVED):
                self.log(f"{item['id']}: photos, policy or model changed; judged and rebuilt again")
                cache.retire([self.out / "rebuild" / item["id"],
                              self.out / "rebuild" / "_trellis" / "glb" / f"{item['id']}.glb"],
                             self.out)
            for name in DERIVED:
                item.pop(name, None)
            if key is None:
                item.pop("inputs", None)
            else:
                item["inputs"] = key
        if changed:
            self.save()

    def enforce(self, item) -> bool:
        """LR_SMALL_OBJECTS_FORCE over Astra's answer (kept as `judged`); True if it changed."""
        answer = item.get("decision")
        if not answer:
            return False
        judged = answer.get("judged", answer["decision"])
        want = self.force.get(item["id"], judged)
        if (want == "trellis" and not item.get("views") and not self.photos(item)
                and not self.model(item)):
            self.log(f"{item['id']}: no photo to rebuild it from; LR_SMALL_OBJECTS_FORCE ignored")
            want = judged
        if want == answer["decision"]:
            return False
        item["decision"] = {**answer, "decision": want, "judged": judged, "forced": want != judged}
        return True

    def listing(self):
        """candidates.md: the ids LR_SMALL_OBJECTS_FORCE and the photo folders are named by."""
        rows = []
        for item in self.items:
            views = item.get("views") or []
            rows.append(f"| {item['id']} | {', '.join(item['members'])} | {item['category']} | "
                        f"{len(views)} ({sum(v['detected'] for v in views)} detected) | "
                        f"{len(self.photos(item))} | {self.out / 'evidence' / item['id']} |")
        text = ["# Small-object candidates", "",
                "Ids for LR_SMALL_OBJECTS_FORCE and the folder names under "
                "LR_SMALL_OBJECTS_PHOTOS.", "",
                "| id | author's objects | category | capture views | operator photos | evidence |",
                "|---|---|---|---|---|---|", *rows, ""]
        (self.out / "candidates.md").write_text("\n".join(text), encoding="utf-8")
        for row in rows:
            self.log(row)
        self.log(f"candidates: {self.out / 'candidates.md'}")

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
        self.refresh()

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
        known = {item["id"] for item in self.active() if "decision" in item}
        for item in self.active():
            if "decision" in item:
                continue
            model = self.model(item)
            if model:  # the operator made it up front (premake); seen in the scan or not
                item["decision"] = {"decision": "trellis", "reason": "the operator supplied a "
                                    "model", "description": "", "forced": True,
                                    "source": str(model)}
                continue
            photos = self.photos(item)
            if not item["views"] and not photos:
                item["decision"] = {"decision": "drop", "reason": "not visible in any capture "
                                    "frame", "description": ""}
                continue
            folder = self.out / "evidence" / item["id"]
            folder.mkdir(parents=True, exist_ok=True)
            images = [folder / "context.jpg", folder / "pair_before.jpg",
                      *[v["image"] for v in item["views"][1:]]] if item["views"] else []
            detected = any(v["detected"] for v in item["views"])
            # A forced or policy-made rebuild needs a description whatever Astra decides.
            prompt = judge.decide_prompt(item, detected, len(photos), self.policy,
                                         describe=bool(self.policy) or item["id"] in self.force)
            jobs.append((item, "decision", [*images, *photos], prompt, judge.parse_decision))
        self.save()
        if jobs:
            asyncio.run(self._ask_all(jobs))
        changed = {item["id"] for item in self.active() if self.enforce(item)}
        if changed:
            self.save()
        for item in self.active():
            if item.get("decision", {}).get("decision") != "trellis":
                self.finished(item, reused=item["id"] in known - changed)

    def rebuild(self):
        from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

        wanted = [i for i in self.active() if i.get("decision", {}).get("decision") == "trellis"]
        known = {i["id"] for i in wanted if "material" in i}
        for item in wanted:
            source = item["decision"].get("source")
            if source and "glb" not in item:
                # A premade mesh stands where TRELLIS's corrected one would: no reference, no
                # TRELLIS, and premake already cleaned it and corrected its material.
                model = self.out / "rebuild" / item["id"] / "model.glb"
                model.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, model)
                item.update(glb=str(model), material={"supplied": source})
                self.log(f"{item['id']}: the operator's model {source}")
                self.save()
        todo = [i for i in wanted if "reference" not in i and "glb" not in i]

        def reference(item):
            folder = self.out / "rebuild" / item["id"]
            # The operator's close-ups lead: the first tile is the sheet's primary view.
            tiles = [*evidence.photo_inputs(self.photos(item), folder / "tiles"),
                     *evidence.generator_inputs(item["views"], folder / "tiles")]
            meta = rebuild.make_reference(item, tiles, item["decision"]["description"], folder)
            return str(folder / "reference.png"), (meta or {}).get("cost_usd") or 0

        with ThreadPoolExecutor(self.concurrency) as pool:
            futures = {pool.submit(reference, item): item for item in todo}
            for future in as_completed(futures):
                item = futures[future]
                try:
                    item["reference"], item["image_cost_usd"] = future.result()
                except Exception as exc:  # noqa: BLE001 — keep other references and retry this item
                    item["reference_error"] = f"{type(exc).__name__}: {exc}"
                else:
                    item.pop("reference_error", None)
                self.save()
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
        for item in wanted:  # also meshes made before this correction existed
            if item.get("glb") and "material" not in item:
                model = self.out / "rebuild" / item["id"] / "model.glb"
                item["material"] = rebuild.correct_material(
                    Path(item["glb"]), Path(item["reference"]), item["category"], model)
                item["glb"] = str(model)
                self.log(f"material {item['id']}: {item['material']}")
                self.save()
        for item in wanted:
            self.finished(item, reused=item["id"] in known)

    def plan(self, items):
        drop, replace = [], []
        for item in items:
            decision = item.get("decision", {}).get("decision")
            if decision == "drop":
                drop.append({"id": item["id"], "members": item["members"]})
            elif decision == "trellis" and item.get("glb"):  # a failed rebuild keeps its model
                # Seen only in the operator's photos: no capture camera to face.
                camera = (self.cameras[item["views"][0]["frame"]]["position"] if item["views"]
                          else None)
                replace.append({"id": item["id"], "members": item["members"],
                                "category": item["category"], "glb": item["glb"],
                                "camera": camera, "material": item.get("material")})
        return drop, replace

    def apply(self):
        """Drops and rebuilds applied to the author's Room.blend, written to room_preview/."""
        final = self.out / "room_preview"
        drop, replace = self.plan(self.items)
        plan = {"drop": drop, "replace": replace}
        key = cache.fingerprint({"source": self.dependency_key, "plan": plan,
                                 "meshes": {i["glb"]: cache.file_hash(Path(i["glb"]))
                                            for i in replace}})
        if not pass_cache.bundle_matches(final, key, pass_cache.ROOM_FILES):
            cache.retire([final, self.out / "renders" / "after"], self.out)
            for item in self.items:
                (self.out / "evidence" / item["id"] / "pair_after.jpg").unlink(missing_ok=True)
            try:
                self.blender(self.preview / "Room.blend",
                             {"op": "apply", "layout": str(self.preview / "room_layout.json"),
                              "out_dir": str(final), **plan}, "apply")
                pass_cache.record_bundle(final, key, pass_cache.ROOM_FILES)
                cache.atomic_json(final / "plan.json", plan)
            except BaseException:
                cache.retire([final], self.out)
                raise
        # For people to look at (overview.jpg); nobody asks a model about these.
        rebuilt = [i for i in self.items if i.get("glb") and
                   i["decision"]["decision"] == "trellis"]
        self.render_pairs(final / "Room.blend", rebuilt, "after")
        # Keep publication evidence for direct CLI use without duplicating a launcher's
        # model_saved event, which is responsible for selecting a model in the replay.
        traces = self.scene_dir / "scene_init/obj_stage/traces"
        traces.mkdir(parents=True, exist_ok=True)
        telemetry.record_artifact(
            traces, "artifact_published", final / "Room.glb",
            path=os.path.relpath(final / "Room.glb", self.scene_dir), phase="small_objects", stage="small_objects",
            run=os.environ.get("LITEREALITY_RUN_ID") or uuid.uuid4().hex,
            job_id=os.environ.get("LITEREALITY_JOB_ID") or str(self.scene_dir),
        )

    def outcome(self, item) -> str:
        decision = item.get("decision", {}).get("decision")
        if decision is None:
            return "unchanged (no decision: " + item.get("decision_error", "not judged") + ")"
        if decision == "procedural":
            return "kept procedural"
        if decision == "drop":
            return "dropped"
        if item["decision"].get("source") and item.get("glb"):
            return "the operator's model " + Path(item["decision"]["source"]).name
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
        self.record("small_objects_start", **({"through": through} if through else {}))
        self.find()
        self.gather_evidence()
        self.render_pairs(self.preview / "Room.blend", self.active(), "before")
        self.listing()
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
        drop, replace = self.plan(self.items)
        self.record("small_objects_done", rebuilt=len(replace), dropped=len(drop),
                    kept=len(self.items) - len(replace) - len(drop))


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
        small.listing()
        return 0
    small.run(args.through)
    return 0


if __name__ == "__main__":
    sys.exit(main())
