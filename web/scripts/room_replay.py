"""Reconstruction replay: turn a room run directory into a timeline the web page can play.

The pipeline already writes timestamped records while it runs (scene_init/obj_stage/traces/*.jsonl,
the acceptance reviews) and drops models as they are finished (each object, the assembled room,
each acceptance round, the final room). This module reads them, so the same data serves a live view
while the job runs and a replay afterwards. Newer runs also record in trace.jsonl when each AI-made
object was written (object_done), each room model was saved (model_saved), each acceptance round was
judged (review_done) and what each build of the authored room added (room_built), and the small-object
pass records each item it rebuilt and the room it saved (small_object_done, model_saved small_objects);
older runs fall back to file times and to when the agent's log first names a part. The author stage runs
the small-object and openable-parts passes on its room before the check (and again after its repair), and
marks their records stage "author"; older runs ran them after publishing, on their own.

Pipeline records become events with fixed Chinese wording. The modelling agent's own log (commands,
results, thoughts, in English) is condensed into plain Chinese by a model in batches; the results are
cached next to the job, and a rule-based wording stands in until (or unless) a batch is condensed.
"""
import json
import os
import re
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path

STAGES = [
    {'id': 'scan', 'name': '读取手机扫描', 'desc': '读入手机拍下的照片和测到的房间结构。'},
    {'id': 'layout', 'name': '整理房间布局', 'desc': '确定墙面、门窗和物品的位置与大小。'},
    {'id': 'photos', 'name': '整理物品图片', 'desc': '从照片中裁出物品，生成便于看清外形的图片。'},
    {'id': 'plan', 'name': '制作物品模型', 'desc': '选择合适的做法，制作物品并检查摆放和开合。'},
    {'id': 'assemble', 'name': '搭建完整房间', 'desc': '对照照片搭好房间，核对尺寸、补充陈设，再对照照片自查修改，最后把纸巾盒、瓶子、绿植这类小物品按照片做成模型放好。'},
    {'id': 'parts', 'name': '装上可开合部件', 'desc': '找出柜门、抽屉等能开合的部件，装上转轴或滑轨，装好后检查房间。'},
    {'id': 'review', 'name': '检查房间', 'desc': '对照照片检查一次房间，看摆放和外观有没有问题。'},
    {'id': 'review2', 'name': '按检查修改', 'desc': '没通过检查时，按检查出的问题修改一次，再做好小物品和可开合部件，修改后的房间就是结果。'},
    # Only listed for a run whose room was revised after it was published, or (older runs) that went through
    # the small-object pass or the openable parts after publishing (see stages_of).
    {'id': 'revise', 'name': '按意见修改', 'desc': '房间发布后收到修改意见，建模 agent 回到这间房间逐条改进，再检查、发布一次。'},
    {'id': 'small_objects', 'name': '重做小物品', 'desc': '把纸巾盒、瓶子、绿植这类小物品按照片重新做成模型，放回原处。'},
    {'id': 'articulate', 'name': '装上可开合部件', 'desc': '找出柜门、抽屉等能开合的部件，装上转轴或滑轨，这就是发布的房间。'},
]
STAGE_IDS = [s['id'] for s in STAGES]
# Finer stages the records still name, shown as one: the modelling agent's own adjusting and self-checking are
# part of building the room; an older flow's check after the repair belongs to the repair.
STAGE_ALIASES = {'adjust': 'assemble', 'check': 'assemble', 'review3': 'review2'}
AGENT_STAGES = ['assemble', 'adjust', 'check']
SUMMARY_VERSION = 1
NUMBERING = 'sessions'  # summary.json 'numbering': its record numbers run on across the agent's sessions

# Files the page may load, relative to the scene directory. Anything else is refused.
FILES = re.compile(r'^(?:'
                   r'scene_init/obj_stage/object_init/(?:object_refs|opening_refs)/[\w.-]+/[\w.-]+/(?:input2imagegen\.jpg|reference_1024\.png)'
                   r'|scene_init/obj_stage/object_init/chair_clusters/[\w.-]+/(?:input2imagegen|references)/[\w.-]+\.(?:jpg|png)'
                   r'|scene_init/obj_stage/reconstructed_objs/[\w.-]+/previews/preview_front\.png'
                   r'|scene_init/obj_stage/traces/img/[\w.-]+\.(?:jpg|png)'
                   r'|scene_init/obj_stage/object_init/input/scan_geometry/[\w.-]+/preview\.jpg'
                   r'|scene_init/scene_stage/room_init/room_preview/Room\.glb'
                   r'|realism_authoring/room_preview/Room\.glb'
                   r'|realism_authoring/acceptance/[\w.-]+/round_\d+/(?:Room\.glb|compare/pairs/pair_\d+\.png)'
                   r'|realism_authoring/_scratch/run_\d+/[\w.-]+/comparison_frame_\d+\.jpg'
                   r'|realism_authoring/evidence/contact_sheets/[\w.-]+\.jpg'
                   r')$')
SEED = 'scene_init/scene_stage/room_init/room_preview/Room.glb'
FINAL = 'realism_authoring/room_preview/Room.glb'
TRACES = 'scene_init/obj_stage/traces'
# The openable-parts and small-object passes write beside the scene (RUN/articulate, RUN/small-objects; the
# scene is RUN/pipeline/<scene>); the page names their rooms by these paths, which scene_file maps there.
ARTICULATED = 'articulate/room_preview/Room.glb'
SMALL_OBJECTS = 'small-objects/room_preview/Room.glb'
# Pictures the small-object pass keeps of an item (its folder beside the room): the photo crop it judged the item
# from, and the photo beside the rebuilt model once the room is rendered.
SMALL_PICTURES = re.compile(r'^small-objects/evidence/[\w.-]+/(?:view0|pair_before|pair_after)\.jpg$')
# The reference picture of the premade model an item took (see small_reference), named by the item.
SMALL_REFERENCE = re.compile(r'^small-objects/reference/([\w.-]+)\.png$')
PASSES = ('small_objects', 'articulated')  # room models of those passes: timed by their records only


def find_scene(job_dir):
    """The scene directory of a job (server runner: run/pipeline/<scene>, uv runner: output/<scene>)."""
    job_dir = Path(job_dir)
    for base in (job_dir / 'run' / 'pipeline', job_dir / 'output'):
        # The pipeline can leave a stray empty pipeline/pipeline/scene_init/scene_stage/...; a scene has the object stage.
        scenes = [p for p in base.glob('*') if (p / 'scene_init' / 'obj_stage').is_dir()] if base.is_dir() else []
        if len(scenes) == 1:
            return scenes[0]
    return None


def read_jsonl(path):
    rows = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass  # a line being written right now
    except OSError:
        pass
    return rows


def model_path(scene, rel):
    """The file of a room model named by its page path. A pass's room is where its last record says, if that is
    inside the run directory (the author stage's passes write beside the room), else beside the scene."""
    scene = Path(scene)
    if rel not in (ARTICULATED, SMALL_OBJECTS):
        return scene / rel
    model = 'articulated' if rel == ARTICULATED else 'small_objects'
    saved = [r.get('path') for r in trace_rows(scene) if r.get('kind') == 'model_saved' and r.get('model') == model]
    if saved and isinstance(saved[-1], str) and saved[-1].endswith('room_preview/Room.glb'):
        recorded = (scene / saved[-1]).resolve()  # absolute, or relative to the scene
        if scene.parent.parent.resolve() in recorded.parents and recorded.is_file():
            return recorded
    return scene.parent.parent / rel


def small_folder(scene):
    """The small-object pass's folder: the one its room is in."""
    return model_path(scene, SMALL_OBJECTS).parent.parent


def scene_file(scene, rel):
    """Resolve an allowlisted file inside the scene directory (or a later pass's room or pictures), or None."""
    if rel in (ARTICULATED, SMALL_OBJECTS):
        path = model_path(scene, rel)
        return path.resolve() if path.is_file() else None
    reference = SMALL_REFERENCE.fullmatch(rel or '')
    if reference:
        path = small_reference(scene, reference[1])
        return path.resolve() if path else None
    if SMALL_PICTURES.fullmatch(rel or '') and '..' not in rel.split('/'):
        folder = small_folder(scene).resolve()
        path = (folder / rel.split('/', 1)[1]).resolve()
        return path if folder in path.parents and path.is_file() else None
    if not FILES.fullmatch(rel or '') or '..' in rel.split('/'):
        return None
    path = (Path(scene) / rel).resolve()
    root = Path(scene).resolve()
    return path if root in path.parents and path.is_file() else None


def _mtime(path):
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _first(paths):
    paths = sorted(paths)
    return paths[0] if paths else None


def _rel(scene, path):
    return str(Path(path).relative_to(scene)) if path else None


def _object_image(scene, name, made=True):
    """A picture of an object: its finished model's front view, else its reference, else its photo. Before its
    model is `made` (its clear picture just generated), only the reference or photo."""
    model = [f'scene_init/obj_stage/reconstructed_objs/{name}/previews/preview_front.png'] if made else []
    for pattern in (*model, f'scene_init/obj_stage/object_init/*_refs/*/{name}/reference_1024.png',
                    f'scene_init/obj_stage/object_init/*_refs/*/{name}/input2imagegen.jpg'):
        found = _first(Path(scene).glob(pattern))
        if found:
            return _rel(scene, found)
    return None


CATEGORY = {'bed': '床', 'storage': '柜子', 'cabinet': '柜子', 'wardrobe': '衣柜', 'table': '桌子', 'desk': '书桌',
            'chair': '椅子', 'sofa': '沙发', 'stool': '凳子', 'shelf': '架子', 'bookshelf': '书架', 'tv': '电视',
            'refrigerator': '冰箱', 'washer': '洗衣机', 'sink': '水槽', 'toilet': '马桶', 'bathtub': '浴缸',
            'oven': '烤箱', 'dishwasher': '洗碗机', 'stove': '灶台', 'fireplace': '壁炉', 'piano': '钢琴'}


def object_names(scene):
    """Plain names for object ids: Bed0 -> 床, Storage0/1/2 -> 柜子1/2/3, Wall0_Door_0 -> 门, chair clusters -> 椅子."""
    shell = _first(Path(scene).glob('scene_init/obj_stage/object_init/input/scene_data/*/layout_shell.json'))
    try:
        objects = json.loads(shell.read_text()).get('objects', {}) if shell else {}
    except (OSError, ValueError):
        objects = {}
    by_label = {}
    for key, o in sorted(objects.items()):
        by_label.setdefault(CATEGORY.get(str(o.get('category', '')).lower(), '物品'), []).append(key)
    names = {}
    for label, keys in by_label.items():
        for k, key in enumerate(keys):
            names[key] = label if len(keys) == 1 else f'{label}{k + 1}'

    def name(key):
        if key in names:
            return names[key]
        if re.search(r'_Door_\d+$', key):
            return '门'
        if re.search(r'_Window_\d+$', key):
            return '窗'
        if key.startswith('ChairCluster') or key == 'generated':
            return '椅子'
        return key
    return name


# Small objects the pass rebuilds are named in English by the room (TissueBox0); the common ones in plain words.
SMALL = [('tissue', '纸巾盒'), ('bottle', '瓶子'), ('plant|flower|succulent', '绿植'), ('vase', '花瓶'),
         ('cardboard|carton', '纸箱'), ('book', '书'), ('cup|mug', '杯子'), ('lamp', '台灯'), ('pillow|cushion', '靠垫'),
         ('slipper|shoe', '鞋'), ('basket', '篮子'), ('clock', '钟'), ('box', '盒子'), ('shelf', '架上物品')]


def small_name(key):
    return next((word for pattern, word in SMALL if re.search(pattern, key, re.I)), '一件小物品')


def small_names(keys, name):
    """Plain names for the items a pass rebuilt, numbered when several share one (瓶子1, 瓶子2), as objects are."""
    words = {}
    for key in sorted(keys):
        word = name(key) if name(key) != key else small_name(key)
        words.setdefault('小物品' if word == '一件小物品' else word, []).append(key)
    return {key: word if len(same) == 1 else f'{word}{k + 1}' for word, same in words.items() for k, key in enumerate(same)}


def small_reference(scene, key, rows=None):
    """The reference picture of the premade model an item took: `premake` keeps it as <models>/work/<Kind>/reference.png
    beside <models>/<Kind>.glb, the model the item's record names (its `source`); a slim copy keeps its own copy
    beside the pass. None for an item without one."""
    kept = small_folder(scene) / 'reference' / f'{key}.png'
    if kept.is_file():
        return kept
    sources = [r.get('source') for r in (trace_rows(scene) if rows is None else rows)
               if r.get('kind') == 'small_object_done' and r.get('name') == key and isinstance(r.get('source'), str)]
    model = Path(sources[-1]) if sources else None
    if not model or not model.is_absolute() or model.suffix != '.glb':
        return None
    path = model.parent / 'work' / model.stem / 'reference.png'
    return path if path.is_file() else None


def small_media(scene, key, until=None, closeup=None, rows=None, done=None):
    """Pictures of an item the small-object pass rebuilt, each with the time it was written: the reference its
    premade model was made from (when it was there by the time the item was `done`), its photo crop (with the part
    showing the item, `closeup`, when known), and the photo beside the rebuilt model (rendered when the room is
    applied, so shown only from then)."""
    folder = small_folder(scene) / 'evidence' / key
    reference = small_reference(scene, key, rows)
    t = reference and _mtime(reference)
    media = [{'src': f'small-objects/reference/{key}.png', 'role': 'reference', 't': t}] if t and (not done or t <= done) else []
    for name, role in (('view0.jpg', 'photo'), ('pair_after.jpg', 'comparison')):
        t = _mtime(folder / name)
        if t and (not until or t <= until or role == 'photo'):  # the photo is the capture's, not the pass's work
            media.append({'src': f'small-objects/evidence/{key}/{name}', 'role': role, 't': t,
                          **({'crop': closeup} if closeup and role == 'photo' else {})})
    return media


def _project(camera, point):
    """Pixel position of a world point in a capture frame (as the small-object pass projects), or None behind it."""
    forward, up, position = camera['forward'], camera['up'], camera['position']
    right = [forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2],
             forward[0] * up[1] - forward[1] * up[0]]
    d = [point[k] - position[k] for k in range(3)]
    z = sum(a * b for a, b in zip(d, forward))
    if z <= 0.05:
        return None
    k = camera['intrinsics']
    return k['cx'] + k['fx'] * sum(a * b for a, b in zip(d, right)) / z, k['cy'] - k['fy'] * sum(a * b for a, b in zip(d, up)) / z


def small_closeups(scene, keys):
    """Where each item is in its photo crop (fractions of view0.jpg), for an item whose crop shows far more than it:
    the pass frames the crop on what its detector finds, and for an item on a shelf that is the whole shelf. The
    item's box is projected into that photo with the capture camera the pass used; an item the crop already shows
    closely, or one projected outside it, has none."""
    try:
        items = {i['id']: i for i in json.loads((small_folder(scene) / 'items.json').read_text())}
        layout = json.loads((Path(scene) / 'realism_authoring/room_preview/room_layout.json').read_text())
        cameras = {c['frame_index']: c for c in layout['cameras']}
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    out = {}
    for key in keys:
        try:
            item = items[key]
            view, low, high = item['views'][0], item['bbox_min'], item['bbox_max']
            points = [_project(cameras[view['frame']], [(high if n >> k & 1 else low)[k] for k in range(3)]) for n in range(8)]
            x0, y0, x1, y1 = view['rect']
            turns = view.get('turns', 0) % 4
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if None in points:
            continue
        u, v = [p[0] for p in points], [p[1] for p in points]
        cx, cy = (min(u) + max(u)) / 2, (min(v) + max(v)) / 2
        side = max(1.6 * max(max(u) - min(u), max(v) - min(v)), 96)  # a margin for where the box lands, a little room around
        w, h = x1 - x0, y1 - y0
        if side > min(w, h) / 2 or not (x0 <= cx <= x1 and y0 <= cy <= y1):
            continue
        left, top = min(max(cx - side / 2, x0), x1 - side) - x0, min(max(cy - side / 2, y0), y1 - side) - y0
        # The crop was turned upright by quarter turns (counter-clockwise): turn the square with it.
        a, b = [[(x, y), (y, w - x), (w - x, h - y), (h - y, x)][turns] for x, y in ((left, top), (left + side, top + side))]
        width, height = (w, h) if turns % 2 == 0 else (h, w)
        out[key] = [round(min(a[0], b[0]) / width, 4), round(min(a[1], b[1]) / height, 4),
                    round(max(a[0], b[0]) / width, 4), round(max(a[1], b[1]) / height, 4)]
    return out


def finished(scene, attempt):
    """Whether a launcher attempt ended its phase well (RUN/attempt-NN/exit holds 0); not known for older runs."""
    try:
        return (Path(scene).parent.parent / attempt / 'exit').read_text().strip() == '0'
    except OSError:
        return False


def trace_rows(scene, until=None):
    rows = [r for r in read_jsonl(Path(scene) / TRACES / 'trace.jsonl') if isinstance(r.get('t'), (int, float))]
    seen, keyed, last = set(), [], 0
    for row in rows:
        identifier = row.get('event_id')
        if identifier and identifier in seen:
            continue
        if identifier:
            seen.add(identifier)
        sequence = row.get('sequence')
        if isinstance(sequence, int) and not isinstance(sequence, bool):
            last = sequence
        elif 'sequence' in row:
            sequence = last + .5  # not a number, which the writer skips too: keep it where it was written
        else:
            sequence = row['t']
        # Equal keys (damaged or repeated numbers, equal times) keep the order rows were written in.
        keyed.append(((row.get('schema_version', 1) >= 2, sequence, len(keyed)), row))
    rows = [row for _, row in sorted(keyed, key=lambda item: item[0])]
    return [r for r in rows if r['t'] <= until] if until else rows


def saved_at(rows, model):
    """When the pipeline recorded writing a room model (seed / final), or None for runs without the record."""
    return next((r['t'] for r in reversed(rows) if r.get('kind') == 'model_saved' and r.get('model') == model), None)


def pipeline_events(scene, until=None):
    """Events from the pipeline's own trace, worded with fixed templates."""
    scene = Path(scene)
    rows = trace_rows(scene, until)
    events, said, small_done, closing = [], set(), None, []
    name = object_names(scene)
    # Objects with a finished-model record; their per-attempt agent steps then only show retries and errors.
    done = {r['name'] for r in rows if r.get('kind') == 'object_done' and r.get('status') == 'ok' and r.get('name')}
    attempts = []  # run_room.py attempts seen, in order (older traces have a run id per stage process)
    # A run whose author stopped short still tries the openable parts; when a later attempt or pass follows,
    # that try is not where the replay's last stage begins (the stages would all collapse into it). The passes
    # number their runs attempt-NN of their own, repeating the main run's, so this goes by position: a record
    # is followed by other work when a record of another run, or a pass's start, comes after it.
    later, runs, passes = [False] * len(rows), set(), False
    for k in range(len(rows) - 1, -1, -1):
        later[k] = passes or bool(runs - {rows[k].get('run'), None})
        runs.add(rows[k].get('run'))
        passes = passes or (rows[k].get('kind') in ('articulate_start', 'small_objects_start') and not inside(rows[k]))
    # A later pass (for small objects: an evidence-only run, then the full one; a rerun) replaces an earlier
    # one: only the last pass's records are shown, and the openable-parts room only when no pass started since.
    small_from = max((k for k, r in enumerate(rows) if r.get('kind') == 'small_objects_start' and not inside(r)),
                     default=-1)
    pass_from = max((k for k, r in enumerate(rows) if r.get('kind') in ('small_objects_start', 'articulate_start')
                     and not inside(r)), default=-1)
    # The author stage's own passes belong to the room it built, or after its repair to the repair.
    repairing, repaired = [], set()
    for r in rows:
        repaired |= {r.get('run')} if r.get('kind') == 'repair_start' else set()
        repairing.append(r.get('run') in repaired)

    def phase(k, stage):
        return 'review2' if repairing[k] else stage

    # The items rebuilt with pictures: an older run's last pass, and every pass the author stage ran.
    small_items = small_names({r['name'] for k, r in enumerate(rows) if r.get('kind') == 'small_object_done'
                               and (k > small_from or inside(r)) and r.get('method') == 'trellis'
                               and r.get('status') == 'ok' and r.get('name')}, name)
    closeups = small_closeups(scene, small_items) if small_items else {}

    def thing(key, work=None):
        """Which object an event is about, and the kind of work done to it (the page shows a run of the same
        work on several objects together)."""
        return {'object_id': key, 'object_name': name(key), **({'work': work} if work else {})}

    def small_line(r, stage, once):
        """One line per rebuilt item, with its photo (and its premade model's reference)."""
        media = small_media(scene, r['name'], until, closeups.get(r['name']), rows, r['t'])
        item = small_items.get(r['name']) or small_name(r['name'])
        add(r, stage, f'{item}换成了按照片重建的模型', once=once,
            img=next((m['src'] for m in media if m['role'] in ('reference', 'photo')), None), media=media,
            object_id=r['name'], object_name=item, work='small')

    def add(row, stage, say, kind='tool', once=None, **extra):
        if once:  # a resumed run repeats its early stages; show them once
            if once in said:
                return
            said.add(once)
        events.append({'id': row.get('event_id') or f'p{len(events)}', 't': row['t'], 'stage': stage,
                       'kind': kind, 'say': say, 'source': 'event', 'confidence': 'recorded',
                       'attempt_id': row.get('attempt_id', row.get('run')), **extra})

    for k, r in enumerate(rows):
        kind, stage, status = r.get('kind'), r.get('stage'), r.get('status')
        if kind == 'trace_start' and re.fullmatch(r'attempt-\d+', str(r.get('run', ''))) and r['run'] not in attempts:
            attempts.append(r['run'])
            # A retry goes on from the work already done; after a phase that ended well, the next one just follows.
            if len(attempts) > 1 and not finished(scene, attempts[-2]):
                add(r, 'scan', '重新开始重建，接着上次做好的部分继续', 'milestone')
        elif kind == 'scan_start':
            preview = _first(scene.glob('scene_init/obj_stage/object_init/input/scan_geometry/*/preview.jpg'))
            add(r, 'scan', '收到房间扫描，开始重建', 'milestone', once='scan', img=_rel(scene, preview))
        elif kind == 'stage' and status == 'done':
            if stage == 'extract_scene':
                add(r, 'scan', '读出扫描里的点云和房间结构', once='extract')
            elif stage == 'layout':
                moved = r.get('moved') or 0
                add(r, 'layout', f'整理好房间布局，校正了 {moved} 个物品框的位置' if moved else '整理好房间布局', once='layout', show=['@boxes'])
            elif stage == 'crop_objects':
                add(r, 'photos', f'从照片里裁出 {r.get("n_objects", "各")} 件物品', once='crop')
            elif stage == 'opening_references':
                add(r, 'photos', f'整理好 {r.get("n_openings", "")} 处门窗的图片', once='openings')
            elif stage == 'chair_clusters' and r.get('chairs'):
                add(r, 'photos', f'把 {r["chairs"]} 把椅子归成 {r.get("clusters", 1)} 类', once='chairs')
            elif stage == 'reconstruct':
                add(r, 'plan', '形状复杂的物品已由 AI 重建完成')
        elif kind == 'image_generation' and status == 'ok' and r.get('name'):
            add(r, 'photos', f'生成{name(r["name"])}的清晰图', 'image', once='img:' + r['name'],
                img=_object_image(scene, r['name'], made=False), **thing(r['name'], 'image'))
        elif kind == 'object_done' and status == 'ok' and r.get('name'):
            # Objects reconstructed by AI, each at the time its model was written; a resumed run
            # records reused models again with that time, so they read as made then. A model taken
            # over from an earlier reconstruction (provided, or reused from a source) is a shortcut of
            # this run, not part of what the replay shows: it reads as made, once, like any other.
            taken = r.get('method') == 'provided' or (r.get('reused') and r.get('source'))
            say, once = f'做好{name(r["name"])}的模型', f'obj:{r["name"]}:' + ('provided' if taken else str(round(r["t"])))
            add(r, 'plan', say, 'tool', once=once, show=[r['name']], img=_object_image(scene, r['name']), **thing(r['name'], 'model'))
        elif kind == 'classify':
            add(r, 'plan', f'选好做法：{r.get("procedural", 0)} 件用程序建模，{r.get("trellis", 0)} 件交给 AI 重建', 'think')
        elif kind == 'agent_step' and r.get('name'):
            attempt = re.search(r'attempt(\d+)', r.get('step', ''))
            again = attempt and int(attempt[1]) > 1
            if r['name'] in done and not again and not r.get('is_error'):
                continue  # its object_done says it was made
            say = (f'{name(r["name"])}的模型这次没做成' if r.get('is_error')
                   else f'{"重做" if again else "做好"}{name(r["name"])}的模型')
            add(r, 'plan', say, 'error' if r.get('is_error') else 'tool', show=[r['name']], img=_object_image(scene, r['name']),
                **thing(r['name'], None if r.get('is_error') or again else 'model'))
        elif kind == 'chair_qc' and r.get('cluster'):
            add(r, 'plan', f'做好{name(r["cluster"])}，检查形状' + ('，有需要留意的地方' if status == 'warn' else ''), 'result',
                show=[r['cluster']], img=_object_image(scene, r['cluster']), **thing(r['cluster'], None if status == 'warn' else 'shape'))
        elif kind == 'chair_qc_retry' and r.get('cluster'):
            ok = status != 'fail'
            add(r, 'plan', f'重新生成{name(r["cluster"])}（第 {r.get("attempt", 1)} 次），' + ('形状检查通过' if ok else '形状还不对'),
                'result' if ok else 'error', show=[r['cluster']] if ok else None, img=_object_image(scene, r['cluster']),
                **thing(r['cluster']))
        elif kind == 'chair_qc_restored' and r.get('cluster'):
            add(r, 'plan', f'{name(r["cluster"])}重新生成都没通过，沿用原来的模型', 'error')
        elif kind in ('openings_physics', 'procedural_physics'):
            add(r, 'plan', f'物理检查：{r.get("passed", 0)}/{r.get("objects", 0)} 件放得稳、能正常开合', 'result')
        elif kind == 'repair_start':
            add(r, 'review2', '按检查出的问题开始修复房间', 'think')
        elif kind == 'small_objects_start' and inside(r):
            add(r, phase(k, 'assemble'), '逐个看房间里的小物品，挑出需要按照片重做的', 'think')
        elif kind == 'small_object_done' and inside(r):
            # After the repair only what it made the pass do again; the rest was said with the room built.
            if (r.get('method') == 'trellis' and status == 'ok' and r.get('name')
                    and not (repairing[k] and r.get('reused'))):
                small_line(r, phase(k, 'assemble'), f'small:{r.get("run")}:{repairing[k]}:{r["name"]}')
        elif kind == 'small_objects_done' and inside(r):
            closing.append((k, r))
        elif kind == 'articulate_start' and inside(r):
            add(r, phase(k, 'parts'), '找出柜门、抽屉等能开合的部件，开始装转轴和滑轨', 'think')
        elif kind == 'articulate_done' and inside(r):
            if status != 'ok':
                add(r, phase(k, 'parts'), '可开合部件没有装成，房间里不加新的部件', 'error')
        elif kind == 'articulate_start' and not later[k]:
            add(r, 'articulate', '找出柜门、抽屉等能开合的部件，开始装转轴和滑轨', 'think')
        elif kind == 'articulate_done' and r.get('status') != 'ok' and not later[k]:
            add(r, 'articulate', '可开合部件没有装成，使用检查后的房间', 'error')
        elif kind == 'small_objects_start' and k == small_from:
            add(r, 'small_objects', '逐个看房间里的小物品，挑出需要按照片重做的', 'think')
        elif (kind == 'small_object_done' and k > small_from and r.get('method') == 'trellis' and status == 'ok'
              and r.get('name')):
            # One line per rebuilt item (recorded once per run), with its photo; kept and dropped ones only count below.
            small_line(r, 'small_objects', 'small:' + r['name'])
        elif kind == 'small_objects_done' and k > small_from:
            small_done = r

    seed = _model_time(scene, rows, 'seed', SEED, until)
    if seed:
        events.append({'id': 'seed', 't': seed, 'stage': 'plan', 'kind': 'milestone',
                       'say': '物品都做好了，拼成第一版房间', 'model': 'seed'})
    events += review_events(scene, until)
    draft = draft_time(scene, rows, until)
    if draft:
        events.append({'id': draft_key(draft), 't': draft, 'stage': 'assemble', 'kind': 'milestone',
                       'say': '房间在继续搭建，这是目前的样子', 'model': draft_key(draft)})
    final = _model_time(scene, rows, 'final', FINAL, until)
    if final:
        events.append({'id': 'final', 't': final, 'stage': last_review_stage(scene, until), 'kind': 'milestone',
                       'say': '导出最终房间', 'model': 'final'})
    # The author stage's passes close with their rooms; only the last of each shows its model (a repair's
    # passes write the same files again).
    saves = [k for k, r in enumerate(rows) if inside(r) and r.get('kind') == 'model_saved'
             and r.get('model') in ('small_objects', 'articulated')]
    for k, r in closing:
        save = next((j for j in saves if j > k and rows[j]['model'] == 'small_objects' and rows[j].get('run') == r.get('run')), None)
        last = save is not None and save == max(j for j in saves if rows[j]['model'] == 'small_objects')
        shown = last and _model_time(scene, rows, 'small_objects', SMALL_OBJECTS, until)
        events.append({'id': f'small{k}', 't': rows[save]['t'] if save is not None else r['t'], 'stage': phase(k, 'assemble'),
                       'kind': 'milestone', 'say': small_summary(r), **({'model': 'small_objects'} if shown else {})})
    for k in saves:
        if rows[k]['model'] == 'articulated':
            shown = k == max(j for j in saves if rows[j]['model'] == 'articulated') and \
                _model_time(scene, rows, 'articulated', ARTICULATED, until)
            events.append({'id': f'parts{k}', 't': rows[k]['t'], 'stage': phase(k, 'parts'), 'kind': 'milestone',
                           'say': '装好可开合部件', **({'model': 'articulated'} if shown else {})})
    # An older run's small-object pass closes with its room, said with what it did to the items.
    small = (_model_time(scene, rows, 'small_objects', SMALL_OBJECTS, until)
             if saved_at([r for r in rows[small_from + 1:] if not inside(r)], 'small_objects') else None)
    if small or small_done:
        events.append({'id': 'small_objects', 't': small or small_done['t'], 'stage': 'small_objects', 'kind': 'milestone',
                       'say': small_summary(small_done), **({'model': 'small_objects'} if small else {})})
    articulated = (_model_time(scene, rows, 'articulated', ARTICULATED, until)
                   if saved_at([r for r in rows[pass_from + 1:] if not inside(r)], 'articulated') else None)
    if articulated:
        events.append({'id': 'articulated', 't': articulated, 'stage': 'articulate', 'kind': 'milestone',
                       'say': '装好可开合部件，这就是发布的房间', 'model': 'articulated'})
    return events


def inside(row):
    """A record of the passes the author stage ran on its room before the check, or after its repair."""
    kind = row.get('kind')
    return row.get('stage') == 'author' and (
        kind in ('small_objects_start', 'small_object_done', 'small_objects_done', 'articulate_start', 'articulate_done')
        or kind == 'model_saved' and row.get('model') in ('small_objects', 'articulated'))


def small_summary(row):
    """Closing words of the small-object pass, from its counts (numbers or lists of names) when recorded."""
    def n(key):
        value = (row or {}).get(key)
        return len(value) if isinstance(value, list) else value if isinstance(value, int) else 0
    parts = [text.format(n(key)) for key, text in (('rebuilt', '按照片重做 {} 件'), ('dropped', '去掉 {} 件'),
                                                   ('kept', '{} 件保持原样')) if n(key)]
    return '小物品处理好了' + ('：' + '，'.join(parts) if parts else '')


# The room the agent is editing is rebuilt into FINAL many times and is ~100 MB, so a live page takes a
# new copy at most once per this many seconds.
DRAFT_EVERY = 300


def draft_time(scene, rows, until=None):
    """While the room is still being authored or repaired: when its working model was last built.

    None before the first version, once the final model is recorded, and for older runs without saved-model
    records (their FINAL file time already stands for the finished room)."""
    seed = saved_at(rows, 'seed')
    if not seed or saved_at(rows, 'final'):
        return None
    import replay_history
    records = [r for r in rows if r.get('kind') == 'room_built' or
               (r.get('kind') == 'artifact_published' and r.get('path') == FINAL)]
    current = records[-1] if records else None
    if not current or current.get('schema_version', 1) < 2:
        current = None  # no recorded build of this file: keep the file time, as before
    t = replay_history.artifact_evidence(Path(scene) / FINAL, current, legacy=not current)['time']
    return t if t and t > seed and (not until or t <= until) else None


def draft_key(t):
    return f'draft{int(t // DRAFT_EVERY)}'


def _model_time(scene, rows, model, rel, until=None):
    """When a room model was written: its trace record; None if not yet.

    Runs that record saved models are timed only by those records: the final model's file is rewritten
    by every build while the agent works, so its file time would show the room as finished early. Older
    runs without any such record fall back to the file's time."""
    if not model_path(scene, rel).is_file():
        return None
    t = model_evidence(scene, rows, model, rel)['time']
    return t if t and (not until or t <= until) else None


def records_models(rows):
    """Whether the authoring run records its saved room models. Rows that later passes (articulate,
    small objects, a retry's pipeline stages) append to an older run do not count: its models stay
    timed by their files. Callers pass only the rows up to the replayed moment, so records written
    after it never change what an earlier moment shows."""
    return any(r.get('kind') == 'model_saved' and r.get('model') not in PASSES for r in rows)


def model_evidence(scene, rows, model, rel):
    import replay_history
    recorded = [r for r in rows if r.get('kind') == 'model_saved' and r.get('model') == model]
    legacy = model not in PASSES and not records_models(rows)
    return replay_history.artifact_evidence(model_path(scene, rel), recorded[-1] if recorded else None, legacy=legacy)


def _rounds(scene, until=None):
    """Reviewed acceptance rounds in order: (review time, visual_review.json, round model time or None).

    Runs that record review_done / model_saved are timed by those records; older runs by file times."""
    scene = Path(scene)
    rows = trace_rows(scene, until)
    done = [r for r in rows if r.get('kind') == 'review_done' and r.get('reviewed') and r.get('folder')]
    if done:
        import replay_history
        saved = {(r.get('run'), r.get('attempt'), r.get('round')):
                 (replay_history.artifact_evidence(scene / r.get('path', ''), r)['time']
                  if r.get('schema_version', 1) >= 2 else r['t']) for r in rows
                 if r.get('kind') == 'model_saved' and r.get('model') == 'round'}
        rounds = [(r['t'], scene / r['folder'] / 'visual_review.json', saved.get((r.get('run'), r.get('attempt'), r.get('round'))),
                   r.get('run')) for r in sorted(done, key=lambda r: r['t'])]
    else:
        from replay_history import legacy_rounds
        # A new-format run records its rounds; older runs, and their later passes, use file times.
        modern = records_models(r for r in rows if r.get('schema_version', 1) >= 2)
        rounds = [] if modern else legacy_rounds(scene)
    return [x for x in rounds if x[0] and (not until or x[0] <= until)]


def _repairs(scene, until=None):
    return [r for r in trace_rows(scene, until) if r.get('kind') == 'repair_done']


def last_review_stage(scene, until=None):
    rounds = _rounds(scene, until)
    if not rounds:
        return 'review2' if _repairs(scene, until) else 'review'
    if any(r['t'] >= rounds[-1][0] for r in _repairs(scene, until)):  # repaired after the last check
        return 'review2'
    run = rounds[-1][3]
    return ['review', 'review2', 'review3'][min(sum(1 for r in rounds if r[3] == run) - 1, 2)]


def review_events(scene, until=None):
    events, runs = [], []
    for k, (t, path, _, run) in enumerate(_rounds(scene, until)):
        runs.append(run)
        n = runs.count(run)  # checks within this run (a retried job checks its room again)
        try:
            review = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        folder = path.parent
        pair = _first(folder.glob('compare/pairs/pair_*.png'))
        passed = review.get('pass')
        # One check now; older runs checked again after each repair.
        say = ('检查房间' if n == 1 else f'第 {n} 次检查') + ('：通过' if passed else '没通过')
        # Rounds name the text differently (description / defect); plain strings occur too.
        issues = [(i.get('description') or i.get('defect') or i.get('issue') or i.get('text') or '') if isinstance(i, dict) else str(i)
                  for i in review.get('issues', [])]
        issues = [i.strip() for i in issues if str(i).strip()]
        event = {'id': f'r{k}', 't': t, 'stage': ['review', 'review2', 'review3'][min(n - 1, 2)], 'kind': 'review',
                 'say': say, 'passed': bool(passed), 'issues': issues[:4], 'img': _rel(scene, pair)}
        if (folder / 'Room.glb').is_file():
            event['model'] = f'round{k}'
        events.append(event)
    for k, r in enumerate(_repairs(scene, until)):
        fixed = r.get('status') == 'repaired'
        events.append({'id': f'fix{k}', 't': r['t'], 'stage': 'review2', 'kind': 'result' if fixed else 'error',
                       'say': '按检查出的问题修好了房间' if fixed else '修复后的房间生成失败，退回检查时的版本'})
    return events


def models(scene, until=None):
    """URLs (relative to the scene) of the room models available up to `until`."""
    scene = Path(scene)
    rows = trace_rows(scene, until)
    out = {}
    if _model_time(scene, rows, 'seed', SEED, until):
        out['seed'] = SEED
    for k, (_, path, saved, _run) in enumerate(_rounds(scene, until)):
        glb = path.parent / 'Room.glb'
        if glb.is_file() and saved and (not until or saved <= until):
            out[f'round{k}'] = _rel(scene, glb)
    draft = draft_time(scene, rows, until)
    if draft:
        out[draft_key(draft)] = FINAL
    if _model_time(scene, rows, 'final', FINAL, until):
        out['final'] = FINAL
    if _model_time(scene, rows, 'small_objects', SMALL_OBJECTS, until):
        out['small_objects'] = SMALL_OBJECTS
    if _model_time(scene, rows, 'articulated', ARTICULATED, until):
        out['articulated'] = ARTICULATED
    return out


def glb_tree(path):
    """{node name: parent name or None} from a GLB's JSON chunk (no mesh data is read)."""
    try:
        with open(path, 'rb') as f:
            head = f.read(20)
            length = struct.unpack('<I', head[12:16])[0]
            gltf = json.loads(f.read(length))
    except (OSError, ValueError, struct.error):
        return {}
    nodes = gltf.get('nodes', [])
    parent = {}
    for k, node in enumerate(nodes):
        for child in node.get('children', []):
            parent[child] = k
    return {node.get('name'): (nodes[parent[k]].get('name') if k in parent else None)
            for k, node in enumerate(nodes) if node.get('name')}


def build_schedule(scene, until=None):
    """When the modelling agent added each new part of the room.

    No room model is saved while the agent works, so the replay shows the final model with the parts the
    agent added appearing at the time its log first names them (the rest of the room switches to the
    final look when the first of them appears). Parts never named appear when the agent's session ends."""
    scene = Path(scene)
    seed, final = scene / SEED, scene / FINAL
    trace = trace_rows(scene, until)
    if not (_model_time(scene, trace, 'seed', SEED, until) and _model_time(scene, trace, 'final', FINAL, until)):
        return None
    before, after = glb_tree(seed), glb_tree(final)
    added = [n for n, p in after.items() if n not in before and (p is None or p in before)]
    # Runs that record each build of the authored room: a part shows from the first build that has it.
    built = {}
    for r in trace:
        if r.get('kind') == 'room_built':
            for n in r.get('added') or []:
                built.setdefault(n, r['t'])
    rows = []
    for paths in agent_sessions(scene) + agent_sessions(scene, repair=True):  # every session, earlier ones too
        for path in paths:
            rows += [r for r in read_jsonl(path) if isinstance(r.get('t'), (int, float)) and (not until or r['t'] <= until)]
    if not rows or not added:
        return None
    rows.sort(key=lambda r: r['t'])
    texts = [(r['t'], json.dumps(r, ensure_ascii=False)) for r in rows]
    end = rows[-1]['t']

    def first(name):
        if name in built:
            return built[name]
        word = re.compile(r'(?<![A-Za-z0-9_])' + re.escape(name) + r'(?![A-Za-z0-9_])')
        return next((t for t, text in texts if word.search(text)), end)
    reveal = sorted(({'node': n, 't': first(n)} for n in added), key=lambda r: r['t'])
    return {'base': reveal[0]['t'], 'reveal': reveal}


# ---------- the modelling agent's log ----------

# Images the agent looks at that are working material, not pictures for people: wall masks (often all
# black) and texture maps other than colour (roughness, normal, ...).
NOT_PICTURE = re.compile(r'mask|_(?:rough|roughness|normal|nrm|disp|displacement|height|ao|metal|metallic|spec|opacity)(?=[._])', re.I)


def agent_sessions(scene, repair=False):
    """The agent's trace files, one list per session in order: the sessions a later one archived
    (history/authoring_trace.<pass>.run_NNN.jsonl), then the current files together."""
    traces = Path(scene) / TRACES

    def wanted(path):
        return '.raw.' not in path.name and (path.name.split('.')[1] == 'repair') == repair

    def tag(path):  # run_003, or run_003_2 when one id was archived twice
        match = re.search(r'\.run_(\d+)(?:_(\d+))?\.jsonl$', path.name)
        return (int(match[1]), int(match[2] or 1), path.name) if match else None
    archived = sorted((p for p in traces.glob('history/authoring_trace.*.run_*.jsonl') if wanted(p) and tag(p)), key=tag)
    current = [p for p in sorted(traces.glob('authoring_trace.*.jsonl')) if wanted(p)]
    return [[p] for p in archived] + ([current] if current else [])


def agent_records(scene, until=None, repair=False):
    """Compact records of the modelling agent's session(s), for condensing; with `repair`, the repair
    session after a failed check instead (shown in its own stage, not condensed).

    Each session is numbered on from the ones before it (a session's own numbers restart), so a session
    keeps the numbers it had while it was the current one, and with them its cached condensation."""
    out = []
    sessions = [[(path, r) for path in paths for r in read_jsonl(path) if isinstance(r.get('t'), (int, float))]
                for paths in agent_sessions(scene, repair)]
    starts = [min((r['t'] for _, r in rows), default=None) for rows in sessions]
    passes = [{path.name.split('.')[1] for path, _ in rows} for rows in sessions]
    for k, rows in enumerate(sessions):
        session = []
        for path, r in rows:
            t, kind = r.get('t'), r.get('kind')
            if until and t > until:
                continue
            pass_name = path.name.split('.')[1]
            text, imgs = '', []
            if kind == 'think':
                text = r.get('text', '')
            elif kind == 'tool':
                hint = r.get('hint') or ''
                desc = re.search(r'#\s*description:\s*([^\n"\\]+)', hint)
                text = f'{r.get("tool")}: ' + (desc[1].strip() if desc else hint)
            elif kind == 'result':
                if r.get('tool') not in ('critic', 'check_collisions', 'render', 'fetch_material') and not r.get('is_error'):
                    continue
                text = f'{r.get("tool")} result: ' + str(r.get('output', ''))
            elif kind == 'images':
                saved = r.get('saved')
                saved = saved if isinstance(saved, list) else re.findall(r"'([^']+)'", saved or '')
                if not saved:
                    continue
                # Pictures are named by pass and the session's own step number, so the next session of the pass
                # writes over them: one written since that session started is not this session's.
                rewritten = next((starts[j] for j in range(k + 1, len(sessions)) if pass_name in passes[j]), None)
                imgs = [f'{TRACES}/{name}' for name in saved if not NOT_PICTURE.search(name.rsplit('/', 1)[-1])]
                imgs = [img for img in imgs if FILES.fullmatch(img)
                        and not (rewritten and (_mtime(Path(scene) / img) or 0) >= rewritten)]
                text = f'looked at {r.get("n_images", len(saved))} images'
            elif kind in ('session_start', 'session_end'):
                text = kind + (': ' + str(r.get('summary', ''))[:600] if kind == 'session_end' else '')
            else:
                continue
            tag = path.name.split('.')[2] + ':' if path.parent.name == 'history' else ''
            session.append({'key': f'{pass_name}:{tag}{r.get("seq", len(session))}', 't': t, 'kind': kind,
                            'text': re.sub(r'/workspace/\S+/', '', text)[:700],
                            'img': imgs[0] if imgs else None, 'imgs': imgs, 'session': k, 'session_t': starts[k]})
        session.sort(key=lambda r: r['t'])
        for r in session:
            r['seq'] = len(out)
            out.append(r)
    return out


MEDIA = 4  # pictures an agent line keeps (the page shows one or two of a stretch of work)


def seen(records):
    """The pictures the agent looked at in these records, each once, in order."""
    return list(dict.fromkeys(img for r in records for img in r.get('imgs') or []))


# What a stretch of work is about, for the wording used until it is condensed: the objects its records name (by
# id), then what its thoughts talk about; and what its checks were.
OBJECT_KEY = re.compile(r'(?<![A-Za-z0-9_])(Wall\d+_(?:Door|Window)_\d+|ChairCluster\d+|[A-Z][a-z]+\d+)(?![A-Za-z0-9])')
TOPICS = [('floor', '地板'), ('ceiling', '天花板'), ('curtain', '窗帘'), ('window', '窗户'), ('door', '门'),
          ('light|lamp|luminaire', '灯光'), ('shel(?:f|ves)|bookcase', '书架'), ('cabinet', '柜子'), ('chair', '椅子'),
          ('table|desk', '桌子'), ('texture|material', '材质'), ('colou?r', '颜色'), ('wall', '墙面')]
CHECKS = {'critic': '对照照片自查', 'check_collisions': '检查物体穿插', 'render': '生成画面查看效果', 'fetch_material': '找材质'}


def rule_say(group, repair=False, name=None):
    """A plain line for a stretch of work: what it worked on, as far as its records say, and how it checked."""
    things = list(dict.fromkeys(name(key) for r in group if r['kind'] in ('think', 'tool')
                                for key in OBJECT_KEY.findall(r['text']) if name and name(key) != key))
    thoughts = ' '.join(r['text'] for r in group if r['kind'] == 'think')
    found = sorted((match.start(), word) for pattern, word in TOPICS
                   for match in [re.search(rf'\b(?:{pattern})', thoughts, re.I)] if match)
    things += [word for _, word in found if not any(word in thing for thing in things)]
    what = '、'.join(things[:3])
    checks = list(dict.fromkeys(CHECKS[r['text'].split(' result:')[0]] for r in group
                                if r['kind'] == 'result' and r['text'].split(' result:')[0] in CHECKS))
    if any(r['kind'] == 'images' for r in group) and CHECKS['render'] not in checks:
        checks.append('查看画面')
    say = (f'按检查意见修改{what or "房间"}' if repair else f'继续搭建房间，处理{what}' if what else '继续搭建房间')
    return say + ('，' + '、'.join(checks[:2]) if checks else '')


def rule_agent_events(records, window=180, prefix='a', name=None):
    """Plain wording used until a batch is condensed: one line per few minutes of work, saying what it worked on
    (`name` turns object ids into plain names); `prefix` m: the repair agent's."""
    events, group = [], []

    def flush():
        if not group:
            return
        pictures = seen(group)
        events.append({'id': f'{prefix}{group[0]["seq"]}', 't': group[-1]['t'], 'kind': 'tool',
                       'say': rule_say(group, prefix == 'm', name),
                       'img': pictures[-1] if pictures else None, 'media': [{'src': img} for img in pictures[-MEDIA:]],
                       'session': f'{prefix}{group[0]["session"]}', 'rule': True})
        group.clear()

    for r in records:
        if r['kind'] not in ('think', 'tool', 'images', 'result'):
            continue
        if group and r['t'] - group[0]['t'] > window:
            flush()
        group.append(r)
    flush()
    return events


PROMPT = """你在给“房间重建过程回放”网页写左栏说明，读者是普通用户，不懂编程。
下面是{who}一段工作的原始记录（JSON，seq 递增，minute 是距本次重建开始的分钟数）。
请把它们合并概括成 {lo}–{hi} 条中文短句，按时间顺序，每条不超过 30 个汉字，说清楚这一步在做什么、得到了什么。
不要出现命令、文件名、路径、代码、英文术语；没有证据说已经修好的，不要写成已经修好；不要写分数（打分、几分、评分都不写），只写发现了什么问题、改了什么。
这些都是 agent 自己的检查：写“自查”“检查”，不要写“验收”或“验收通过”（验收专指之后独立的验收轮次，结果另行显示）。
每条给出它概括的 seq 范围（from/to，覆盖全部记录、相互不重叠、按顺序），kind 取 think（想法）、tool（操作）、result（结果或检查）、error（出错）之一。
stage 取 {stages} 之一：assemble=搭建完整房间（读资料、看照片、搭初稿、补陈设），adjust=核查并调整（查穿插和外观差异、校准位置、调细节），check=自查并再修改（对照照片自查、按自查继续改、收尾送检）。stage 不能比前一条靠前，第一条不能早于 {current}。
如果这条的 from–to 范围内有记录带 img（列出了它看的图片名），可以在 image_seq 填其中最能说明这一步的那条记录的 seq，否则填 null；不要填范围以外的 seq。
只输出 JSON 数组，例如 [{{"from": 0, "to": 3, "stage": "assemble", "kind": "think", "say": "先看完全部照片，再搭一版初稿", "image_seq": null}}]。

前面已经写好的几条（保持衔接，不要重复）：
{previous}

本段记录：
{records}
"""

WHO = {False: '建模 agent', True: '修复 agent（独立检查没通过后，按检查指出的问题修改房间）'}

REVIEW_PROMPT = """把下面这轮房间验收指出的问题，概括成一句中文（不超过 40 个汉字），给普通用户看，不要英文和术语。只输出这句话。
{issues}"""


def codex_runner(model=None, effort=None, timeout=600):
    """Return a function prompt -> text that runs `codex exec` (same CLI the pipeline uses)."""
    model = model or os.environ.get('LR_REPLAY_MODEL') or os.environ.get('LR_CODEX_MODEL') or 'gpt-6-astra'
    effort = effort or os.environ.get('LR_REPLAY_EFFORT', 'low')

    # The project's own wrapper (Astra key and Codex config, as the pipeline's agent stages use), else PATH.
    home = os.environ.get('ROOMCANVAS_HOME')
    wrapper = Path(home) / 'runtime/bin/codex' if home else None
    binary = os.environ.get('LR_REPLAY_CODEX') or (str(wrapper) if wrapper and wrapper.is_file() else 'codex')

    def run(prompt):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'answer.txt'
            cmd = [binary, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
                   '-c', f'model_reasoning_effort="{effort}"', '-m', model, '--output-last-message', str(out), prompt]
            subprocess.run(cmd, cwd=tmp, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                           timeout=timeout, check=True, start_new_session=True)
            return out.read_text(encoding='utf-8')
    return run


def _json_array(text):
    match = re.search(r'\[.*\]', text, re.S)
    if not match:
        raise ValueError('no JSON array in answer')
    return json.loads(match[0])


class Summary:
    """Condensed wording for one job, cached in <job>/replay/summary.json."""

    def __init__(self, job_dir):
        self.path = Path(job_dir) / 'replay' / 'summary.json'
        try:
            data = json.loads(self.path.read_text())
            self.data = data if data.get('version') == SUMMARY_VERSION else None
        except (OSError, ValueError):
            self.data = None
        if not self.data:
            self.data = {'version': SUMMARY_VERSION, 'numbering': NUMBERING, 'batches': [], 'reviews': {}}

    def save(self):
        self.data['numbering'] = NUMBERING
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.data, ensure_ascii=False))
        tmp.replace(self.path)

    def batches(self, repair=False):
        """The condensed batches of the modelling agent's sessions, or of the repair agent's (numbered on their own)."""
        return self.data.setdefault('repair', []) if repair else self.data['batches']

    def done(self, repair=False):
        batches = self.batches(repair)
        return batches[-1]['to'] if batches else -1

    def align(self, scene):
        """Renumber a cache written before the sessions were numbered on (each session counted from 0 while it
        was the current one): a batch moves to the numbers of the session holding its first line's time (else the
        nearest earlier one). In memory only; returns whether the cache needs saving. Records it left out before
        its last batch stay left out, as they were."""
        if self.data.get('numbering') == NUMBERING:
            return False
        starts = {}  # session -> (its first number, its first time)
        for r in agent_records(scene) if self.data['batches'] else []:
            starts.setdefault(r['session'], (r['seq'], r['t']))
        for batch in self.data['batches']:
            # Sessions do not overlap: the last one begun by then holds that time, or is the nearest earlier one.
            t = batch['items'][0]['t'] if batch['items'] else None
            held = [seq for seq, start in starts.values() if t is not None and start <= t]
            if not held:
                continue
            offset = held[-1]
            batch['from'] += offset
            batch['to'] += offset
            for item in batch['items']:
                item['from'] += offset
                item['to'] += offset
        self.data['numbering'] = NUMBERING
        return True

    def condense(self, records, run, minute0, batch=40, final=False, min_batch=15, quiet_seconds=90, now=None, repair=False):
        """Condense pending agent records (`repair`: the repair agent's). While a job runs, wait for a fuller batch or a pause."""
        changed = False
        while True:
            pending = [r for r in records if r['seq'] > self.done(repair)]
            if not pending:
                break
            settled = (now or time.time()) - pending[-1]['t'] > quiet_seconds
            if not final and len(pending) < min_batch and not settled:
                break
            chunk = [r for r in pending[:batch] if r.get('session') == pending[0].get('session')]  # one session a batch
            items = self._ask(chunk, run, minute0, repair)
            self.batches(repair).append({'from': chunk[0]['seq'], 'to': chunk[-1]['seq'], 'items': items})
            self.save()  # each batch as soon as it is ready: the page shows it, and a later failure keeps it
            changed = True
        return changed

    def _ask(self, chunk, run, minute0, repair=False):
        previous = [i['say'] for b in self.batches(repair)[-1:] for i in b['items']][-4:]
        current = next((i['stage'] for b in reversed(self.batches(repair)) for i in reversed(b['items'])), 'assemble')
        current = current if current in AGENT_STAGES else 'assemble'  # a repair line is in the repair's own stage
        records = [{'seq': r['seq'], 'minute': round((r['t'] - minute0) / 60, 1), 'kind': r['kind'], 'text': r['text'],
                    **({'img': [img.rsplit('/', 1)[-1] for img in r['imgs']]} if r.get('imgs') else {})} for r in chunk]
        prompt = PROMPT.format(who=WHO[repair], lo=max(1, len(chunk) // 12), hi=max(2, len(chunk) // 5), stages='/'.join(AGENT_STAGES),
                               current=current, previous='\n'.join(previous) or '（无）',
                               records=json.dumps(records, ensure_ascii=False))
        by_seq = {r['seq']: r for r in chunk}
        items, order = [], AGENT_STAGES.index(current)
        for item in _json_array(run(prompt)):
            lo, hi = int(item['from']), int(item['to'])
            if lo not in by_seq or hi not in by_seq or hi < lo:
                continue
            stage = item.get('stage') if item.get('stage') in AGENT_STAGES else AGENT_STAGES[order]
            order = max(order, AGENT_STAGES.index(stage))  # never step back
            seq = item.get('image_seq')
            image = by_seq.get(seq) if isinstance(seq, int) and lo <= seq <= hi else None  # a picture of this line's own records
            items.append({'from': lo, 'to': hi, 't': by_seq[hi]['t'], 'stage': 'review2' if repair else AGENT_STAGES[order],
                          'kind': item.get('kind') if item.get('kind') in ('think', 'tool', 'result', 'error') else 'tool',
                          'say': str(item.get('say', '')).strip()[:60], 'img': image.get('img') if image else None})
        if not items:
            raise ValueError('empty condensation')
        return items

    def review(self, key, issues, run):
        issues = [i for i in issues if i and i.strip()]
        if key in self.data['reviews'] or not issues:
            return False
        self.data['reviews'][key] = run(REVIEW_PROMPT.format(issues='\n'.join(issues))).strip().splitlines()[0][:80]
        self.save()
        return True


def agent_stage_fallback(records, t):
    """Without a condensation, split the agent session by time: first quarter, middle, last third."""
    if not records:
        return 'assemble'
    t0, t1 = records[0]['t'], records[-1]['t']
    f = (t - t0) / (t1 - t0) if t1 > t0 else 0
    return 'assemble' if f < 0.25 else 'adjust' if f < 0.67 else 'check'


def timeline(job_dir, status='completed', until=None):
    """Everything the page needs: stages, ordered events, models and whether the job is still live."""
    scene = find_scene(job_dir)
    if not scene:
        return {'live': status in ('queued', 'running', 'preparing'), 'stages': stages_of([]), 'events': [], 'models': {}}
    events = pipeline_events(scene, until)
    records = agent_records(scene, until)
    summary = Summary(job_dir)
    summary.align(scene)  # an older cache, renumbered here and saved by the condensing worker
    name = object_names(scene)

    def condensed(records, repair=False):
        """The condensed lines of these records as events; returns the last record they cover."""
        prefix, by_seq, covered = 'm' if repair else 'a', {r['seq']: r for r in records}, -1
        for batch in summary.batches(repair):
            for item in batch['items']:
                # A line shows only pictures the agent looked at within its own records: the one chosen for it, else
                # the first of them (a cache may name one outside, or none).
                pictures = seen(by_seq[seq] for seq in range(item['from'], item['to'] + 1) if seq in by_seq)
                img = item.get('img') if item.get('img') in pictures else pictures[0] if pictures else None
                events.append({'id': f'{prefix}{item["from"]}', 'stage': item['stage'], 'kind': item['kind'], 't': item['t'],
                               'say': item['say'], 'img': img, 'media': [{'src': src} for src in pictures[:MEDIA]],
                               **({'session': f'{prefix}{by_seq[item["from"]]["session"]}'} if item['from'] in by_seq else {})})
            covered = batch['to']
        return covered

    covered = condensed(records)
    for k in dict.fromkeys(r['session'] for r in records):  # each session worded on its own
        own = [r for r in records if r['session'] == k]
        for event in rule_agent_events([r for r in own if r['seq'] > covered], name=name):
            event['stage'] = agent_stage_fallback(own, event['t'])
            events.append(event)
    repair = agent_records(scene, until, repair=True)
    covered = condensed(repair, repair=True)
    for k in dict.fromkeys(r['session'] for r in repair):
        for event in rule_agent_events([r for r in repair if r['session'] == k and r['seq'] > covered], prefix='m', name=name):
            event['stage'] = 'review2'
            events.append(event)
    for event in events:
        event['stage'] = STAGE_ALIASES.get(event['stage'], event['stage'])
    # A session of the modelling agent on a room already published (follow-up requests) is its own stage, and
    # so is what follows it before the passes: the checks, the repair and the new final room.
    rows = trace_rows(scene, until)
    published = next((r['t'] for r in rows if r.get('kind') == 'model_saved' and r.get('model') == 'final'), None)
    revised = published and next((r['session_t'] for r in records if r['session_t'] > published), None)
    for event in events:
        if revised and event['t'] >= revised and STAGE_IDS.index(event['stage']) < STAGE_IDS.index('revise'):
            event['stage'] = 'revise'
    # The passes before it were made from the room being revised; they run again afterwards.
    if revised:
        events = [e for e in events if e['stage'] not in ('small_objects', 'articulate') or e['t'] >= revised]
    for event in events:
        event.setdefault('source', 'legacy_projection')
        event.setdefault('confidence', 'inferred')
        if event['kind'] == 'review' and event.get('issues'):
            said = summary.data['reviews'].get(event['id'])
            if said:
                event['say'] += '：' + said
    events.sort(key=lambda e: (e['t'], STAGE_IDS.index(e['stage'])))
    # Stages never step back on the timeline (a late-written record keeps the stage it belongs to).
    order = 0
    for event in events:
        order = max(order, STAGE_IDS.index(event['stage']))
        event['stage'] = STAGE_IDS[order]
    start = events[0]['t'] if events else None
    for event in events:
        event['minute'] = round((event['t'] - start) / 60, 3)
        event.pop('issues', None)
        for media in event.get('media') or []:  # when each picture was there to show
            if 't' in media:
                media['minute'] = round((media.pop('t') - start) / 60, 3)
    build = build_schedule(scene, until) if start else None
    if build:
        build = {'base': round((build['base'] - start) / 60, 3),
                 'reveal': [{'node': r['node'], 'minute': round((r['t'] - start) / 60, 3)} for r in build['reveal']]}
    idle = idle_spans(events, [(a, min(b, until) if until else b) for a, b in attempt_spans(scene)
                               if not until or a <= until], start) if start else []
    return {'live': status in ('queued', 'running', 'preparing'), 'status': status, 'start': start,
            'stages': stages_of(events, published_passes(rows)), 'events': events, 'models': models(scene, until),
            'build': build, 'idle': idle,
            'model_evidence': {model: model_evidence(scene, trace_rows(scene, until), model, rel)
                               for model, rel in [('seed', SEED), ('final', FINAL), ('small_objects', SMALL_OBJECTS),
                                                  ('articulated', ARTICULATED)]}}


IDLE_MINUTES = 2  # a pause shorter than this stays on the clock


def attempt_spans(scene):
    """When each launcher attempt of the run worked, as (start, end) epoch seconds: the main run's attempts and
    the passes' (small objects, openable parts). Start: the attempt's run-config.json (written once it has the
    GPU); end: its exit file, or for one still running or killed, its log's last write."""
    run, spans = Path(scene).parents[1], []
    for attempt in [*run.glob('attempt-*'), *run.glob('*/attempt-*')]:
        config = attempt / 'run-config.json'
        if not config.is_file():
            continue
        try:
            import datetime
            begun = datetime.datetime.fromisoformat(json.loads(config.read_text())['started']).timestamp()
        except (OSError, ValueError, KeyError, TypeError):
            begun = config.stat().st_mtime
        ended = _mtime(attempt / 'exit') or _mtime(attempt / 'pipeline.log') or begun
        spans.append((begun, max(begun, ended)))
    return sorted(spans)


def idle_spans(events, spans, start):
    """Stretches of the replayed time in which nothing shown was being worked on, as [from, to] minutes after
    `start`: no attempt ran (waiting for the operator, a stopped machine), or the attempt that ran shows nothing
    (a pass a later one replaced, a session stopped before it did anything). The clock leaves them out, as
    playback already does; a run without attempt records leaves nothing out."""
    if not events or not spans:
        return []
    times = sorted(e['t'] for e in events)
    worked = sorted([a, b] for a, b in spans if any(a <= t <= b for t in times))
    worked += [[t, t] for t in times]  # every shown moment itself
    merged = []
    for a, b in sorted(worked):
        if merged and a <= merged[-1][1] + IDLE_MINUTES * 60:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [[round((b0 - start) / 60, 3), round((a1 - start) / 60, 3)]
            for (_, b0), (a1, _) in zip(merged, merged[1:]) if a1 - b0 > IDLE_MINUTES * 60]


def stages_of(events, late=False):
    """The stages to list: all, but the revision and the small-object pass only for a run that went through them,
    and the openable parts once: before the check, or after publishing for an older run that made them there
    (`late`, see published_passes)."""
    return [s for s in STAGES if (s['id'] not in ('revise', 'small_objects') or any(e['stage'] == s['id'] for e in events))
            and s['id'] != ('parts' if late else 'articulate')]


def published_passes(rows):
    """Whether an older run ran its passes after publishing, on their own (not in the author stage)."""
    return any(r.get('kind') in ('small_objects_start', 'articulate_start') and not inside(r) for r in rows)


# ---------- 3D scaffold: point cloud and layout boxes ----------

_SCAFFOLD_LOCK = threading.Lock()


def scaffold(job_dir):
    """Point cloud (float32 x,y,z in the room model's frame) and layout boxes, cached under replay/."""
    # The page asks for both files at once; build the cache only once.
    with _SCAFFOLD_LOCK:
        return _scaffold(job_dir)


_COLORS_LOCK = threading.Lock()
COLOR_TOLERANCE = 0.06  # metres: a frame sees a point when its depth there agrees this closely


def scaffold_colors(job_dir):
    """RGB (uint8 per point, same order as points.bin) taken from the capture's own photos, cached under
    replay/colors.bin; None when it cannot be made (no frames, or no numpy/OpenCV in this interpreter)."""
    with _COLORS_LOCK:
        cache = Path(job_dir) / 'replay'
        out, none = cache / 'colors.bin', cache / 'colors.none'
        if out.is_file():
            return out
        if none.is_file():
            return None
        files = _scaffold(job_dir)
        scene = find_scene(job_dir)
        colors = _point_colors(scene, files[0]) if files and scene else None
        if colors is None:
            if files:
                none.write_text('')  # tried: no frames to colour from
            return None
        tmp = out.with_suffix('.tmp')
        tmp.write_bytes(colors)
        tmp.replace(out)
        return out


def _frame_index(path):
    return int(re.search(r'(\d+)', path.stem)[1])


def _point_colors(scene, points_path):
    """Each scan point takes the average colour of the photos that see it: in front of the camera, inside the
    picture, and the depth map agreeing there (so a point hidden behind something is not painted with it).
    The depth map decides visibility; the colour comes from the full-size photo. Unseen points stay grey."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    rgbd = _first(Path(scene).glob('scene_init/obj_stage/object_init/input/rgbd/*/extrinsic'))
    if not rgbd:
        return None
    rgbd = rgbd.parent
    points = np.fromfile(points_path, '<f4').reshape(-1, 3).astype(np.float64)
    if not len(points):
        return None
    world = np.c_[points, np.ones(len(points))].T
    total, count = np.zeros((len(points), 3)), np.zeros(len(points))
    for pose_path in sorted((rgbd / 'extrinsic').glob('extrinsic_*.npy'), key=_frame_index):
        i = _frame_index(pose_path)
        try:
            K, pose = np.load(rgbd / 'intrinsic' / f'intrinsic_{i}.npy'), np.load(pose_path)
        except (OSError, ValueError):
            continue
        depth = cv2.imread(str(rgbd / 'depth' / f'frame_{i}.jpg'), cv2.IMREAD_UNCHANGED)
        photo = cv2.imread(str(rgbd / 'image' / f'frame_{i}.jpg'), cv2.IMREAD_COLOR)
        if depth is None or photo is None or depth.ndim != 2:
            continue
        h, w = depth.shape
        cam = np.linalg.inv(pose) @ world
        z = cam[2]
        front = z > 1e-6
        safe = np.where(front, z, 1)
        u, v = K[0, 0] * cam[0] / safe + K[0, 2], K[1, 1] * cam[1] / safe + K[1, 2]  # depth-map pixels
        ui, vi = np.round(u).astype(int), np.round(v).astype(int)
        seen = np.flatnonzero(front & (ui >= 0) & (ui < w) & (vi >= 0) & (vi < h))
        d = depth[vi[seen], ui[seen]].astype(np.float32) / 1000
        seen = seen[(d > 0) & (np.abs(d - z[seen]) < COLOR_TOLERANCE)]
        if not len(seen):
            continue
        ph, pw = photo.shape[:2]
        px = np.clip((u[seen] * pw / w).astype(int), 0, pw - 1)
        py = np.clip((v[seen] * ph / h).astype(int), 0, ph - 1)
        total[seen] += photo[py, px, ::-1]  # BGR -> RGB
        count[seen] += 1
    if not count.any():
        return None
    colors = np.full((len(points), 3), 150, np.uint8)
    lit = count > 0
    colors[lit] = np.clip(total[lit] / count[lit, None], 0, 255).astype(np.uint8)
    return colors.tobytes()


def _scaffold(job_dir):
    scene = find_scene(job_dir)
    cache = Path(job_dir) / 'replay'
    if not scene:
        return None
    points_out, layout_out = cache / 'points.bin', cache / 'layout.json'
    if points_out.is_file() and layout_out.is_file():
        return points_out, layout_out
    geometry = _first(scene.glob('scene_init/obj_stage/object_init/input/scan_geometry/*/scene_points.obj'))
    shell = _first(scene.glob('scene_init/obj_stage/object_init/input/scene_data/*/layout_shell.json'))
    baseline = _first(scene.glob('scene_init/obj_stage/object_init/input/scene_data/*/layout_baseline.json'))
    if not (geometry and shell and baseline):
        return None
    cache.mkdir(parents=True, exist_ok=True)
    buffer = bytearray()
    with open(geometry, encoding='utf-8') as f:
        for line in f:
            if line.startswith('v '):
                # The exported point cloud is already in the room model's y-up frame (the layout boxes are not).
                buffer += struct.pack('<3f', *map(float, line.split()[1:4]))
    sh, base = json.loads(shell.read_text()), json.loads(baseline.read_text())
    boxes = []
    for key, o in sh.get('objects', {}).items():
        x, y, z = o['center']
        sx, sy, sz = o['size']
        boxes.append({'id': key, 'category': o.get('category'), 'center': [x, z, -y], 'size': [sx, sz, sy],
                      'yaw': o.get('yaw', 0) * 3.141592653589793 / 180})
    walls = [{'id': k, 'a': [w['start'][0], -w['start'][1]], 'b': [w['end'][0], -w['end'][1]], 'h': w['height'], 't': w['thickness']}
             for k, w in base.get('shell', {}).get('walls', {}).items()]
    tmp = points_out.with_suffix('.tmp')
    tmp.write_bytes(bytes(buffer))
    tmp.replace(points_out)
    layout_out.write_text(json.dumps({'boxes': boxes, 'walls': walls, 'floor': base.get('shell', {}).get('floor_z', 0),
                                      'points': len(buffer) // 12}))
    return points_out, layout_out


# ---------- register an existing run for replay only ----------

# Besides the served FILES, the replay reads these (logs, review verdicts, point cloud and layout).
READS = ('scene_init/obj_stage/traces/trace.jsonl', 'scene_init/obj_stage/traces/authoring_trace.*.jsonl',
         'scene_init/obj_stage/traces/history/authoring_trace.*.run_*.jsonl',  # earlier sessions (not their raw logs)
         'realism_authoring/acceptance/*/round_*/visual_review.json',
         'scene_init/obj_stage/object_init/input/scan_geometry/*/scene_points.obj',
         'scene_init/obj_stage/object_init/input/scene_data/*/layout_shell.json',
         'scene_init/obj_stage/object_init/input/scene_data/*/layout_baseline.json')


def slim(run, dest):
    """Copy only what the replay needs from a run (hundreds of MB instead of tens of GB), keeping paths and times."""
    import shutil
    run, dest = Path(run).resolve(), Path(dest)
    scenes = [p for p in (run / 'pipeline').glob('*') if (p / 'scene_init' / 'obj_stage').is_dir()]
    if len(scenes) != 1:
        raise SystemExit(f'expected one scene under {run}/pipeline')
    scene, total = scenes[0], 0
    wanted = {p for pattern in READS for p in scene.glob(pattern) if p.parent.name != 'history' or '.raw.' not in p.name}
    for root, _, names in os.walk(scene):
        for name in names:
            path = Path(root) / name
            if path in wanted or FILES.fullmatch(str(path.relative_to(scene))):
                target = dest / 'pipeline' / scene.name / path.relative_to(scene)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)  # the replay orders review rounds by file time
                total += path.stat().st_size
    # The later passes' rooms (the openable-parts one was published), beside the scene, and how each launcher
    # attempt ended (whether a later one was a retry).
    extra = [(model_path(scene, rel), dest / rel) for rel in (ARTICULATED, SMALL_OBJECTS)]
    small = small_folder(scene)
    extra += [(path, dest / 'small-objects' / path.relative_to(small)) for path in small.glob('evidence/*/*.jpg')
              if SMALL_PICTURES.fullmatch('small-objects/' + str(path.relative_to(small)))]
    items = {r['name'] for r in trace_rows(scene) if r.get('kind') == 'small_object_done' and r.get('name')}
    extra += [(small_reference(scene, key), dest / 'small-objects' / 'reference' / f'{key}.png') for key in sorted(items)
              if small_reference(scene, key)]
    extra += [(path, dest / path.relative_to(run)) for pattern in ('attempt-*/exit', 'attempt-*/run-config.json', '*/attempt-*/exit',
                                                                   '*/attempt-*/run-config.json') for path in run.glob(pattern)]
    for path, target in extra:
        if path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            total += path.stat().st_size
    return total


def register(data_dir, run, name, until=None):
    """Add a finished run (its directory holds pipeline/<scene>) as a replay-only job; nothing is copied."""
    import uuid
    run = Path(run).resolve()
    scenes = [p for p in (run / 'pipeline').glob('*') if (p / 'scene_init' / 'obj_stage').is_dir()]
    if len(scenes) != 1:
        raise SystemExit(f'expected one scene under {run}/pipeline')
    scene = scenes[0]
    rows = [r for r in read_jsonl(scene / TRACES / 'trace.jsonl') if isinstance(r.get('t'), (int, float))]
    if until is None:  # the run ends with its last review or final export; later records belong to other work
        ends = [r[0] for r in _rounds(scene)] + [_model_time(scene, rows, m, rel) for m, rel in
                                                 (('final', FINAL), ('small_objects', SMALL_OBJECTS),
                                                  ('articulated', ARTICULATED))]
        until = max(t for t in ends if t) + 120
    identifier = uuid.uuid4().hex
    folder = Path(data_dir) / identifier
    folder.mkdir(parents=True)
    (folder / 'run').symlink_to(run, target_is_directory=True)
    record = {'id': identifier, 'name': name, 'status': 'completed', 'created': rows[0]['t'] if rows else time.time(),
              'updated': until, 'until': until, 'runner': 'server', 'replay_only': True, 'scan': scene.name}
    (folder / 'job.json').write_text(json.dumps(record, ensure_ascii=False))
    return identifier


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Register an existing room run for replay (no copy unless --slim-to).')
    parser.add_argument('--data-dir', type=Path, required=True, help='the room service --data-dir')
    parser.add_argument('--run', type=Path, required=True, help='run directory containing pipeline/<scene>')
    parser.add_argument('--name', required=True)
    parser.add_argument('--until', type=float, help='ignore records after this Unix time (default: last review + 2 min)')
    parser.add_argument('--slim-to', type=Path, help='first copy only the files the replay needs here, and register that copy')
    args = parser.parse_args()
    run = args.run
    if args.slim_to:
        size = slim(run, args.slim_to)
        print(f'copied {size / 2**20:.0f} MB to {args.slim_to}')
        run = args.slim_to
    print(register(args.data_dir, run, args.name, args.until))


if __name__ == '__main__':
    main()
