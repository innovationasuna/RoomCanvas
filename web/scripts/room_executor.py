"""Subprocess lifecycle and job execution. Jobs owns durable status changes."""
import fcntl
import os
import shutil
import signal
import subprocess
import sys
import time
from room_contract import ROOT, ASSETS
from room_status import read_json


def execute(self, args, log):
    process = subprocess.Popen(args, cwd=self.pipeline, stdout=log, stderr=subprocess.STDOUT,
                               stdin=subprocess.DEVNULL, start_new_session=True,
                               env={**os.environ, 'LITEREALITY_JOB_ID': getattr(self, 'active_job', '')},
                               pass_fds=(self.task_lock.fileno(),) if self.task_lock else ())
    try:
        code = process.wait(timeout=self.timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        raise RuntimeError('任务超过运行时限，请检查服务器日志后重试。')
    if code:
        raise RuntimeError(f'重建程序退出（代码 {code}）。请检查服务器 task.log、模型配置和扫描数据后重试。')

def run_one(self, identifier):
    record = self.records[identifier]
    self.active_job = identifier
    execution_started = None
    folder = self.root / identifier
    guard = (folder / 'task.lock').open('a')
    try:
        try:
            fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('上一次重建进程仍在运行，请等它结束后重试。')
        self.task_lock = guard
        with self.lock:
            now = time.time()
            execution_started = time.monotonic()
            queued_at = record.get('queued_at')
            record['timing'] = {'queue_seconds': max(0., now-queued_at) if queued_at is not None else None,
                                'started_at': now}
            record.update(status='running')
            self.save(record)
        with (folder / 'task.log').open('ab') as log:
            if record.get('runner', 'cli') == 'server':
                # Retain this project's runtime configuration, GPU selection/lock and articulation pass.
                execution_error = None
                previous_attempts = set((folder / 'run').glob('attempt-*'))
                try:
                    self.execute([self.python, str(self.pipeline / 'server/run_room.py'), record['capture'],
                                  str(folder / 'run'), '--through', 'publish', '--wait-gpu'], log)
                except RuntimeError as error:
                    execution_error = error
                attempts = sorted(set((folder / 'run').glob('attempt-*')) - previous_attempts)
                if not attempts or not (attempts[-1] / 'exit').is_file() or (attempts[-1] / 'exit').read_text().strip() != '0':
                    if attempts and 'gpu_error' in read_json(attempts[-1] / 'runtime-timing.json'):
                        raise RuntimeError('没有取得可用的 GPU，重建没有开始。请稍后重试；详情见服务器 task.log。')
                    # Say what happened (time limit, exit code) when the launcher itself reported it.
                    raise execution_error or RuntimeError('房间重建或可动部件生成失败，请检查运行目录的 pipeline.log 和 articulate.log 后重试。')
                previews = list((folder / 'run/pipeline').glob('*/realism_authoring/room_preview'))
                if not (attempts[-1] / 'articulate-exit').is_file():
                    # The author stage adds the openable parts before its check; the published room has them
                    # when that pass went through (publish records how each pass ended).
                    if len(previews) != 1:
                        raise RuntimeError('没有唯一可用的已发布房间，请检查服务器日志。')
                    preview = previews[0]
                    ended = read_json(preview / 'acceptance.json').get('passes', {}).get('articulate')
                    record['enhancement'] = {'status': 'completed' if ended in ('ok', 'partial') else 'failed',
                                             'attempt_id': attempts[-1].name}
                elif not execution_error and (attempts[-1] / 'articulate-exit').read_text().strip() == '0':
                    # An older launcher ran the openable parts after publishing, into run/articulate.
                    preview = folder / 'run/articulate/room_preview'
                    record['enhancement'] = {'status': 'completed', 'attempt_id': attempts[-1].name}
                else:
                    if len(previews) != 1:
                        raise RuntimeError('可动部件增强失败，且没有唯一可用的已发布房间。')
                    preview = previews[0]
                    record['enhancement'] = {'status': 'failed', 'attempt_id': attempts[-1].name}
            else:
                self.execute([self.uv, 'run', '--no-sync', 'litereality', 'run', record['capture'],
                              '--output-root', str(folder / 'output'), '--through', 'publish'], log)
                previews = list((folder / 'output').glob('*/realism_authoring/room_preview'))
                if len(previews) != 1:
                    raise RuntimeError('未找到唯一的房间重建结果，请检查服务器日志。')
                preview = previews[0]
            if not all((preview / name).is_file() and (preview / name).stat().st_size
                       for name in ('Room.glb', 'room_layout.json')):
                raise RuntimeError('重建结束但缺少完整房间模型或布局，尚不能进入布置。')
            with self.lock:
                record.update(status='preparing')
                self.save(record)
            self.execute([sys.executable, str(ROOT / 'web/scripts/room_objects.py'), str(preview)], log)
            published = folder / 'assets'
            published.mkdir(exist_ok=True)
            for name in ASSETS:
                if (preview / name).is_file():
                    shutil.copy2(preview / name, published / name)
        with self.lock:
            record['timing']['execution_seconds'] = time.monotonic()-execution_started
            record.update(status='completed')
            self.save(record)
    except Exception as error:
        with self.lock:
            if execution_started is not None:
                record['timing']['execution_seconds'] = time.monotonic()-execution_started
            record.update(status='failed', error=str(error) if isinstance(error, RuntimeError) else '无法运行重建程序，请检查服务器环境及 task.log。')
            self.save(record)
    finally:
        self.task_lock = None
        guard.close()

