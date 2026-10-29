"""python3 -m unittest discover -s web/scripts"""
import sys
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import forwarded, open_tunnel, tunnel_command  # noqa: E402


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


class Tunnel(unittest.TestCase):
    def test_command_forwards_the_local_port_to_the_remote_service(self):
        command = tunnel_command('gpu-box', '172.18.0.2:7862', 7865)
        self.assertEqual(command[0], 'ssh')
        self.assertIn('-N', command)
        self.assertIn('ExitOnForwardFailure=yes', command)
        self.assertEqual(command[command.index('-L') + 1], '127.0.0.1:7865:172.18.0.2:7862')
        self.assertEqual(command[-1], 'gpu-box')

    def test_remote_must_be_address_and_port(self):
        for remote in ['172.18.0.2', '7862', 'a b:1', 'host:port']:
            with self.assertRaises(ValueError):
                tunnel_command('gpu-box', remote, 7865)

    def test_a_tunnel_that_exits_stops_the_server_with_a_message(self):
        with self.assertRaises(SystemExit) as stop:
            open_tunnel([sys.executable, '-c', 'raise SystemExit(255)'], 1, wait=5)
        self.assertIn('SSH tunnel failed (exit 255)', str(stop.exception.code))

    def test_a_port_already_in_use_is_refused_before_starting_ssh(self):
        import socket
        with socket.socket() as busy:
            busy.bind(('127.0.0.1', 0))
            busy.listen()
            port = busy.getsockname()[1]
            with self.assertRaises(SystemExit) as stop:
                open_tunnel([sys.executable, '-c', 'raise SystemExit("ssh must not start")'], port, wait=5)
        self.assertIn(f'Port {port} is already in use', str(stop.exception.code))


if __name__ == '__main__':
    unittest.main()
