"""Public execution, artifact, quality and optional enhancement outcomes."""
import json


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def describe(folder, record, state):
    stages = state.get('stages', {})
    warnings = [str(warning) for stage in stages.values() for warning in stage.get('warnings', [])]
    failed = next((stage for stage in stages.values() if stage.get('status') == 'failed'), {})
    category = failed.get('error_category') or record.get('error_category')
    available = (record.get('status') == 'completed' and not record.get('replay_only') and
                 all((folder / 'assets' / name).is_file() for name in ('Room.glb', 'room_objects.json')))
    paths = list((folder / 'run/pipeline').glob('*/realism_authoring/room_preview/acceptance.json'))
    paths += list((folder / 'output').glob('*/realism_authoring/room_preview/acceptance.json'))
    quality = read_json(paths[0]) if len(paths) == 1 else {}
    quality_status = ('passed' if quality.get('accepted') is True else
                      'warnings' if quality.get('accepted') is False else 'unknown')
    enhancement = dict(record.get('enhancement', {}))
    # The openable-parts pass of the author stage writes beside the room; an older launcher's into run/.
    summaries = list((folder / 'run/pipeline').glob('*/realism_authoring/articulate/summary.json'))
    summary = read_json(summaries[0] if len(summaries) == 1 else folder / 'run/articulate/summary.json')
    if enhancement.get('attempt_id') and summary.get('attempt_id') == enhancement['attempt_id']:
        enhancement = {**summary, **enhancement}
    if enhancement.get('status') == 'failed':
        warnings.append('可动部件增强未完成，已保留可用的房间模型。')
    timings = sorted((folder / 'run').glob('attempt-*/runtime-timing.json'))
    launch = read_json(timings[-1]) if timings else {}
    return {
        'execution': record['status'], 'artifact_validity': 'valid' if available else 'unavailable',
        'usable': available, 'quality': {'status': quality_status}, 'warnings': warnings,
        'enhancement': enhancement or {'status': 'unknown'},
        'error_category': category,
        # The launcher has no GPU yet: the job is waiting for the card, not reconstructing.
        'gpu_waiting': record['status'] == 'running' and 'gpu_waiting_since' in launch,
        # Stage `retryable` only governs immediate re-runs inside a run. A job can be retried unless
        # its input is known to be at fault, as before; old records have no category.
        'retryable': category != 'input',
    }
