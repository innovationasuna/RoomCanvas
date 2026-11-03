"""Reconstruction replay: turn a room run directory into a timeline the web page can play.

The pipeline already writes timestamped records while it runs (scene_init/obj_stage/traces/*.jsonl,
the acceptance reviews) and drops models as they are finished (each object, the assembled room,
each acceptance round, the final room). This module reads them, so the same data serves a live view
while the job runs and a replay afterwards.

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
import time
from pathlib import Path

STAGES = [
    {'id': 'scan', 'name': '读取手机扫描', 'desc': '读入手机拍下的照片和测到的房间结构。'},
    {'id': 'layout', 'name': '整理房间布局', 'desc': '确定墙面、门窗和物品的位置与大小。'},
    {'id': 'photos', 'name': '整理物品图片', 'desc': '从照片中裁出物品，生成便于看清外形的图片。'},
    {'id': 'plan', 'name': '制作物品模型', 'desc': '选择合适的做法，制作物品并检查摆放和开合。'},
    {'id': 'assemble', 'name': '搭建完整房间', 'desc': '对照照片搭好房间，核对尺寸并补充陈设细节。'},
    {'id': 'adjust', 'name': '核查并调整', 'desc': '查找摆放和外观差异，核对位置并调整细节。'},
    {'id': 'check', 'name': '自查并再修改', 'desc': '对照照片自查并继续修改，带着剩余问题送验。'},
    {'id': 'review', 'name': '首轮验收', 'desc': '独立对照照片检查房间效果，指出未达标之处。'},
    {'id': 'review2', 'name': '修改后再验收', 'desc': '根据验收意见修改，再次检查。'},
    {'id': 'review3', 'name': '最终验收', 'desc': '再次检查，决定能不能发布。'},
]
STAGE_IDS = [s['id'] for s in STAGES]
AGENT_STAGES = ['assemble', 'adjust', 'check']
SUMMARY_VERSION = 1

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


def find_scene(job_dir):
    """The scene directory of a job (server runner: run/pipeline/<scene>, uv runner: output/<scene>)."""
    job_dir = Path(job_dir)
    for base in (job_dir / 'run' / 'pipeline', job_dir / 'output'):
        scenes = [p for p in base.glob('*') if (p / 'scene_init').is_dir()] if base.is_dir() else []
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


def scene_file(scene, rel):
    """Resolve an allowlisted file inside the scene directory, or None."""
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


def _object_image(scene, name):
    """A picture of an object: its finished model's front view, else its reference, else its photo."""
    for pattern in (f'scene_init/obj_stage/reconstructed_objs/{name}/previews/preview_front.png',
                    f'scene_init/obj_stage/object_init/*_refs/*/{name}/reference_1024.png',
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


def pipeline_events(scene, until=None):
    """Events from the pipeline's own trace, worded with fixed templates."""
    scene = Path(scene)
    rows = [r for r in read_jsonl(scene / TRACES / 'trace.jsonl') if isinstance(r.get('t'), (int, float))]
    if until:
        rows = [r for r in rows if r['t'] <= until]
    events, said = [], set()
    name = object_names(scene)

    def add(row, stage, say, kind='tool', once=None, **extra):
        if once:  # a resumed run repeats its early stages; show them once
            if once in said:
                return
            said.add(once)
        events.append({'id': f'p{len(events)}', 't': row['t'], 'stage': stage, 'kind': kind, 'say': say, **extra})

    for r in rows:
        kind, stage, status = r.get('kind'), r.get('stage'), r.get('status')
        if kind == 'scan_start':
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
            add(r, 'photos', f'生成{name(r["name"])}的清晰图', 'image', once='img:' + r['name'], img=_object_image(scene, r['name']))
        elif kind == 'classify':
            add(r, 'plan', f'选好做法：{r.get("procedural", 0)} 件用程序建模，{r.get("trellis", 0)} 件交给 AI 重建', 'think')
        elif kind == 'agent_step' and r.get('name'):
            attempt = re.search(r'attempt(\d+)', r.get('step', ''))
            again = attempt and int(attempt[1]) > 1
            add(r, 'plan', f'{"重做" if again else "做好"}{name(r["name"])}的模型', 'error' if r.get('is_error') else 'tool',
                show=[r['name']], img=_object_image(scene, r['name']))
        elif kind == 'chair_qc' and r.get('cluster'):
            add(r, 'plan', f'做好{name(r["cluster"])}，检查形状' + ('，有需要留意的地方' if status == 'warn' else ''), 'result',
                show=[r['cluster']], img=_object_image(scene, r['cluster']))
        elif kind in ('openings_physics', 'procedural_physics'):
            add(r, 'plan', f'物理检查：{r.get("passed", 0)}/{r.get("objects", 0)} 件放得稳、能正常开合', 'result')

    seed = scene / SEED
    if _mtime(seed) and (not until or _mtime(seed) <= until):
        events.append({'id': 'seed', 't': _mtime(seed), 'stage': 'plan', 'kind': 'milestone',
                       'say': '物品都做好了，拼成第一版房间', 'model': 'seed'})
    events += review_events(scene, until)
    final = scene / FINAL
    if _mtime(final) and (not until or _mtime(final) <= until):
        events.append({'id': 'final', 't': _mtime(final), 'stage': last_review_stage(scene), 'kind': 'milestone',
                       'say': '导出最终房间', 'model': 'final'})
    return events


def _rounds(scene):
    return sorted(Path(scene).glob('realism_authoring/acceptance/*/round_*/visual_review.json'),
                  key=lambda p: (_mtime(p) or 0, str(p)))


def last_review_stage(scene):
    return ['review', 'review2', 'review3'][min(max(len(_rounds(scene)) - 1, 0), 2)]


def review_events(scene, until=None):
    events = []
    for k, path in enumerate(_rounds(scene)):
        t = _mtime(path)
        if until and t > until:
            continue
        try:
            review = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        folder = path.parent
        pair = _first(folder.glob('compare/pairs/pair_*.png'))
        score = review.get('score')
        passed = review.get('pass')
        say = f'第 {k + 1} 轮验收' + (f' {score:.1f} 分' if isinstance(score, (int, float)) else '') + ('，通过' if passed else '，没通过')
        # Rounds name the text differently (description / defect); plain strings occur too.
        issues = [(i.get('description') or i.get('defect') or i.get('issue') or i.get('text') or '') if isinstance(i, dict) else str(i)
                  for i in review.get('issues', [])]
        issues = [i.strip() for i in issues if str(i).strip()]
        event = {'id': f'r{k}', 't': t, 'stage': ['review', 'review2', 'review3'][min(k, 2)], 'kind': 'review',
                 'say': say, 'score': score, 'passed': bool(passed), 'issues': issues[:4], 'img': _rel(scene, pair)}
        if (folder / 'Room.glb').is_file():
            event['model'] = f'round{k}'
        events.append(event)
    return events


def models(scene, until=None):
    """URLs (relative to the scene) of the room models available up to `until`."""
    scene = Path(scene)
    out = {}
    if _mtime(scene / SEED) and (not until or _mtime(scene / SEED) <= until):
        out['seed'] = SEED
    for k, path in enumerate(_rounds(scene)):
        glb = path.parent / 'Room.glb'
        if glb.is_file() and (not until or _mtime(glb) <= until):
            out[f'round{k}'] = _rel(scene, glb)
    if _mtime(scene / FINAL) and (not until or _mtime(scene / FINAL) <= until):
        out['final'] = FINAL
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
    if not (_mtime(seed) and _mtime(final)) or (until and _mtime(final) > until):
        return None
    before, after = glb_tree(seed), glb_tree(final)
    added = [n for n, p in after.items() if n not in before and (p is None or p in before)]
    rows = []
    for path in sorted((scene / TRACES).glob('authoring_trace.*.jsonl')):
        if '.raw.' not in path.name:
            rows += [r for r in read_jsonl(path) if isinstance(r.get('t'), (int, float)) and (not until or r['t'] <= until)]
    if not rows or not added:
        return None
    rows.sort(key=lambda r: r['t'])
    texts = [(r['t'], json.dumps(r, ensure_ascii=False)) for r in rows]
    end = rows[-1]['t']

    def first(name):
        word = re.compile(r'(?<![A-Za-z0-9_])' + re.escape(name) + r'(?![A-Za-z0-9_])')
        return next((t for t, text in texts if word.search(text)), end)
    reveal = sorted(({'node': n, 't': first(n)} for n in added), key=lambda r: r['t'])
    return {'base': reveal[0]['t'], 'reveal': reveal}


# ---------- the modelling agent's log ----------

def agent_records(scene, until=None):
    """Compact records of the modelling agent's session(s), for condensing."""
    out = []
    for path in sorted((Path(scene) / TRACES).glob('authoring_trace.*.jsonl')):
        if '.raw.' in path.name:
            continue
        pass_name = path.name.split('.')[1]
        for r in read_jsonl(path):
            t, kind = r.get('t'), r.get('kind')
            if not isinstance(t, (int, float)) or (until and t > until):
                continue
            text, img = '', None
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
                img = f'{TRACES}/{saved[0]}'
                text = f'looked at {r.get("n_images", len(saved))} images'
            elif kind in ('session_start', 'session_end'):
                text = kind + (': ' + str(r.get('summary', ''))[:600] if kind == 'session_end' else '')
            else:
                continue
            out.append({'key': f'{pass_name}:{r.get("seq", len(out))}', 't': t, 'kind': kind,
                        'text': re.sub(r'/workspace/\S+/', '', text)[:700], 'img': img if img and FILES.fullmatch(img) else None})
    out.sort(key=lambda r: r['t'])
    for k, r in enumerate(out):
        r['seq'] = k
    return out


def rule_agent_events(records, window=180):
    """Plain wording used until a batch is condensed: one line per few minutes of agent work, no commands."""
    events, group = [], []

    def flush():
        if not group:
            return
        tools = sum(1 for r in group if r['kind'] == 'tool')
        images = [r for r in group if r['kind'] == 'images']
        checks = sum(1 for r in group if r['kind'] == 'result')
        parts = [f'执行了 {tools} 次操作'] if tools else []
        parts += [f'看了 {len(images)} 组图片'] if images else []
        parts += [f'拿到 {checks} 次检查结果'] if checks else []
        say = '建模 agent 继续工作' + ('：' + '，'.join(parts) if parts else '')
        events.append({'id': f'a{group[0]["seq"]}', 't': group[-1]['t'], 'kind': 'tool', 'say': say,
                       'img': images[-1]['img'] if images else None, 'rule': True})
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
下面是建模 agent 一段工作的原始记录（JSON，seq 递增，minute 是距本次重建开始的分钟数）。
请把它们合并概括成 {lo}–{hi} 条中文短句，按时间顺序，每条不超过 30 个汉字，说清楚这一步在做什么、得到了什么。
不要出现命令、文件名、路径、代码、英文术语；没有证据说已经修好的，不要写成已经修好；评分照实写。
每条给出它概括的 seq 范围（from/to，覆盖全部记录、相互不重叠、按顺序），kind 取 think（想法）、tool（操作）、result（结果或检查）、error（出错）之一。
stage 取 {stages} 之一：assemble=搭建完整房间（读资料、看照片、搭初稿、补陈设），adjust=核查并调整（查穿插和外观差异、校准位置、调细节），check=自查并再修改（自评打分、按自评继续改、收尾送验）。stage 不能比前一条靠前，第一条不能早于 {current}。
如果某条对应的记录里有 img，可以在 image_seq 填那条记录的 seq，否则填 null。
只输出 JSON 数组，例如 [{{"from": 0, "to": 3, "stage": "assemble", "kind": "think", "say": "先看完全部照片，再搭一版初稿", "image_seq": null}}]。

前面已经写好的几条（保持衔接，不要重复）：
{previous}

本段记录：
{records}
"""

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
            self.data = {'version': SUMMARY_VERSION, 'batches': [], 'reviews': {}}

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.data, ensure_ascii=False))
        tmp.replace(self.path)

    @property
    def done_to(self):
        return self.data['batches'][-1]['to'] if self.data['batches'] else -1

    def condense(self, records, run, minute0, batch=40, final=False, min_batch=15, quiet_seconds=90, now=None):
        """Condense pending agent records. While a job runs, wait for a fuller batch or a pause."""
        changed = False
        while True:
            pending = [r for r in records if r['seq'] > self.done_to]
            if not pending:
                break
            settled = (now or time.time()) - pending[-1]['t'] > quiet_seconds
            if not final and len(pending) < min_batch and not settled:
                break
            chunk = pending[:batch]
            items = self._ask(chunk, run, minute0)
            self.data['batches'].append({'from': chunk[0]['seq'], 'to': chunk[-1]['seq'], 'items': items})
            self.save()  # each batch as soon as it is ready: the page shows it, and a later failure keeps it
            changed = True
        return changed

    def _ask(self, chunk, run, minute0):
        previous = [i['say'] for b in self.data['batches'][-1:] for i in b['items']][-4:]
        current = next((i['stage'] for b in reversed(self.data['batches']) for i in reversed(b['items'])), 'assemble')
        records = [{'seq': r['seq'], 'minute': round((r['t'] - minute0) / 60, 1), 'kind': r['kind'], 'text': r['text'],
                    **({'img': True} if r.get('img') else {})} for r in chunk]
        prompt = PROMPT.format(lo=max(1, len(chunk) // 12), hi=max(2, len(chunk) // 5), stages='/'.join(AGENT_STAGES),
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
            image = by_seq.get(item.get('image_seq')) if item.get('image_seq') is not None else None
            items.append({'from': lo, 'to': hi, 't': by_seq[hi]['t'], 'stage': AGENT_STAGES[order],
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
        return {'live': status in ('queued', 'running', 'preparing'), 'stages': STAGES, 'events': [], 'models': {}}
    events = pipeline_events(scene, until)
    records = agent_records(scene, until)
    summary = Summary(job_dir)
    covered = -1
    for batch in summary.data['batches']:
        for item in batch['items']:
            events.append({'id': f'a{item["from"]}', 'stage': item['stage'], 'kind': item['kind'], 't': item['t'],
                           'say': item['say'], 'img': item.get('img')})
        covered = batch['to']
    for event in rule_agent_events([r for r in records if r['seq'] > covered]):
        event['stage'] = agent_stage_fallback(records, event['t'])
        events.append(event)
    for event in events:
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
    build = build_schedule(scene, until) if start else None
    if build:
        build = {'base': round((build['base'] - start) / 60, 3),
                 'reveal': [{'node': r['node'], 'minute': round((r['t'] - start) / 60, 3)} for r in build['reveal']]}
    return {'live': status in ('queued', 'running', 'preparing'), 'status': status, 'start': start,
            'stages': STAGES, 'events': events, 'models': models(scene, until), 'build': build}


# ---------- 3D scaffold: point cloud and layout boxes ----------

def scaffold(job_dir):
    """Point cloud (float32 x,y,z in the room model's frame) and layout boxes, cached under replay/."""
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

def register(data_dir, run, name, until=None):
    """Add a finished run (its directory holds pipeline/<scene>) as a replay-only job; nothing is copied."""
    import uuid
    run = Path(run).resolve()
    scenes = [p for p in (run / 'pipeline').glob('*') if (p / 'scene_init').is_dir()]
    if len(scenes) != 1:
        raise SystemExit(f'expected one scene under {run}/pipeline')
    scene = scenes[0]
    rows = [r for r in read_jsonl(scene / TRACES / 'trace.jsonl') if isinstance(r.get('t'), (int, float))]
    if until is None:  # the run ends with its last review or final export; later records belong to other work
        ends = [_mtime(p) for p in _rounds(scene)] + [_mtime(scene / FINAL)]
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
    parser = argparse.ArgumentParser(description='Register an existing room run for replay (no copy).')
    parser.add_argument('--data-dir', type=Path, required=True, help='the room service --data-dir')
    parser.add_argument('--run', type=Path, required=True, help='run directory containing pipeline/<scene>')
    parser.add_argument('--name', required=True)
    parser.add_argument('--until', type=float, help='ignore records after this Unix time (default: last review + 2 min)')
    args = parser.parse_args()
    print(register(args.data_dir, args.run, args.name, args.until))


if __name__ == '__main__':
    main()
