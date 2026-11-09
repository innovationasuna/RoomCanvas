"""python3 -m unittest discover -s web/scripts"""
import sys
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import Tunnel as SSHTunnel, forwarded, open_tunnel, room_forwarded, tunnel_command  # noqa: E402


class Forwarding(unittest.TestCase):
    def test_only_the_editor_reads_go_to_viewforge(self):
        run = '20260926_sofa_web_114146_561893'
        for path in ['/viewforge/assets/catalog', f'/viewforge/assets/{run}',
                     f'/viewforge/assets/{run}/result.glb', f'/viewforge/assets/{run}/preview.glb?x=1',
                     f'/viewforge/assets/{run}/result.ply', f'/viewforge/assets/{run}/preview.json',
                     '/viewforge/layouts/catalog', f'/viewforge/layouts/assets/{run}',
                     f'/viewforge/layouts/assets/{run}/result.glb', f'/viewforge/layouts/assets/{run}/preview.glb?x=1']:
            self.assertEqual(forwarded(path), path.split('?')[0])
        for path in ['/web/', '/viewforge/layouts/save', '/viewforge/layouts/viewer', '/viewforge/layouts/rooms/office.glb',
                     '/viewforge/layouts/assets/../secret', f'/viewforge/layouts/assets/{run}/other.glb',
                     '/viewforge/assets/../secret', f'/viewforge/assets/{run}/other.glb', '/gradio_api/file=/etc/passwd']:
            self.assertIsNone(forwarded(path))

    def test_adding_an_object_goes_to_viewforge(self):
        job, chair = 'a' * 32, quote('20261018_我的椅子_web_101010_000001')
        for path in [f'/viewforge/objects/jobs/{job}', f'/viewforge/objects/previews/20261018_101010_ab12cd34/{quote("我的椅子_001")}.png',
                     f'/viewforge/assets/{chair}', f'/viewforge/assets/{chair}/result.glb', f'/viewforge/assets/{chair}/preview.json']:
            self.assertEqual(forwarded(path), path)
        for path in ['/viewforge/objects/create', '/viewforge/objects/capture', '/viewforge/objects/masks', '/viewforge/objects/reconstruct', f'/viewforge/dimensions/{chair}']:
            self.assertEqual(forwarded(path, 'POST'), path)
            self.assertIsNone(forwarded(path))
        for path in ['/viewforge/layouts/save', f'/viewforge/assets/{chair}', '/viewforge/objects/jobs', f'/viewforge/dimensions/{chair}/model.glb',
                     '/viewforge/dimensions/..', '/web/editor/index.html']:
            self.assertIsNone(forwarded(path, 'POST'))
        self.assertIsNone(forwarded('/viewforge/objects/previews/x/%2E%2E%2Fsecret.png'))


class RoomReplay(unittest.TestCase):
    def test_only_a_jobs_replay_reads_go_to_the_room_service(self):
        job = '0123456789abcdef0123456789abcdef'
        for path in [f'/room-reconstruction/jobs/{job}/replay', f'/room-reconstruction/jobs/{job}/replay/scaffold/points.bin',
                     f'/room-reconstruction/jobs/{job}/replay/scaffold/layout.json',
                     f'/room-reconstruction/jobs/{job}/replay/files/scene_init/obj_stage/traces/img/a_1.jpg']:
            self.assertEqual(room_forwarded(path), path)
        for path in [f'/room-reconstruction/jobs/{job}/replay/files/../job.json', f'/room-reconstruction/jobs/{job}/replay/files/a%2e%2e/b',
                     f'/room-reconstruction/jobs/{job}/replay/scaffold/secret', f'/room-reconstruction/jobs/{job}/replay/x',
                     '/room-reconstruction/jobs/xyz/replay']:
            self.assertIsNone(room_forwarded(path), path)
        self.assertIsNone(room_forwarded(f'/room-reconstruction/jobs/{job}/replay', 'POST'))


class Tunnel(unittest.TestCase):
    def test_command_forwards_the_local_port_to_the_remote_service(self):
        command = tunnel_command('gpu-box', [(7865, '172.18.0.2:7862')])
        self.assertEqual(command[0], 'ssh')
        self.assertIn('-N', command)
        self.assertIn('ExitOnForwardFailure=yes', command)
        self.assertIn('ControlPath=none', command)
        self.assertEqual(command[command.index('-L') + 1], '127.0.0.1:7865:172.18.0.2:7862')
        self.assertEqual(command[-1], 'gpu-box')

    def test_one_connection_forwards_objects_and_rooms(self):
        command = tunnel_command('gpu-box', [(7865, '172.18.0.2:7862'), (7866, '127.0.0.1:7866')])
        forwards = [command[i + 1] for i, part in enumerate(command) if part == '-L']
        self.assertEqual(forwards, ['127.0.0.1:7865:172.18.0.2:7862', '127.0.0.1:7866:127.0.0.1:7866'])
        self.assertEqual(command[-1], 'gpu-box')

    def test_cpa_is_forwarded_back_from_the_server(self):
        command = tunnel_command('autodl', [(7865, '127.0.0.1:7870')], [8317])
        self.assertEqual(command[command.index('-R') + 1], '127.0.0.1:8317:127.0.0.1:8317')
        self.assertEqual(command[-1], 'autodl')
        self.assertNotIn('-R', tunnel_command('autodl', [(7865, '127.0.0.1:7870')]))

    def test_a_dropped_tunnel_is_started_again(self):
        import subprocess
        import tempfile
        import time
        with tempfile.TemporaryDirectory() as folder:
            starts = Path(folder) / 'starts'
            # each "ssh" records a start and exits at once, like a connection the gateway drops
            command = [sys.executable, '-c', f'open({str(starts)!r}, "a").write("x")']
            tunnel = SSHTunnel(command, subprocess.Popen(command), check=0.1)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and len(starts.read_text() if starts.exists() else '') < 2:
                time.sleep(0.1)
            tunnel.close()
            self.assertGreaterEqual(len(starts.read_text()), 2)

    def test_remote_must_be_address_and_port(self):
        for remote in ['172.18.0.2', '7862', 'a b:1', 'host:port']:
            with self.assertRaises(ValueError):
                tunnel_command('gpu-box', [(7865, '127.0.0.1:7862'), (7866, remote)])

    def test_a_tunnel_that_exits_stops_the_server_with_a_message(self):
        with self.assertRaises(SystemExit) as stop:
            open_tunnel([sys.executable, '-c', 'raise SystemExit(255)'], [1], wait=5)
        self.assertIn('SSH tunnel failed (exit 255)', str(stop.exception.code))

    def test_a_port_already_in_use_is_refused_before_starting_ssh(self):
        import socket
        with socket.socket() as busy:
            busy.bind(('127.0.0.1', 0))
            busy.listen()
            port = busy.getsockname()[1]
            with self.assertRaises(SystemExit) as stop:
                open_tunnel([sys.executable, '-c', 'raise SystemExit("ssh must not start")'], [1, port], wait=5)
        self.assertIn(f'Port {port} is already in use', str(stop.exception.code))


if __name__ == '__main__':
    unittest.main()
