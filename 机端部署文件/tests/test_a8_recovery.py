"""Exercise the archived A8 recovery code without devices, sockets or FFmpeg."""
import ast
import io
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace

path = Path(__file__).resolve().parents[1] / 'home/pi/a8mini/h100-web/server.py'
tree = ast.parse(path.read_text(encoding='utf-8'))
isolated = ast.Module(body=[node for node in tree.body if isinstance(node, ast.Import)
    or isinstance(node, ast.ImportFrom)
    or isinstance(node, ast.FunctionDef) and node.name == 'stop_decoder'
    or isinstance(node, ast.ClassDef) and node.name in ('Preview', 'Handler')], type_ignores=[])
scope = {'__name__': 'isolated_camera_tests'}
exec(compile(isolated, '<isolated-camera-tests>', 'exec'), scope)

events = []
class StuckDecoder:
    killed = False
    def poll(self): return None
    def terminate(self): events.append('terminate')
    def kill(self): events.append('kill'); self.killed = True
    def wait(self, timeout):
        events.append('wait')
        if not self.killed: raise subprocess.TimeoutExpired('fake-decoder', timeout)
        return 0
scope['stop_decoder'](StuckDecoder())
assert events == ['terminate', 'wait', 'kill', 'wait'], events

preview = scope['Preview']()
preview.state, preview.last_frame = 'live', 10
scope['time'] = SimpleNamespace(time=lambda: 100)
assert preview.status()['state'] == 'reconnecting', 'stale frames must not advertise live video'

class FakeThread:
    started = False
    def __init__(self, **kwargs): pass
    def start(self): self.started = True
    def is_alive(self): return self.started
scope['threading'] = SimpleNamespace(Condition=threading.Condition, Thread=FakeThread)
preview.worker = FakeThread()
preview.attach()
assert preview.worker.started and preview.clients == 1, 'a dead worker must restart on attachment'

class Condition:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def wait_for(self, predicate, timeout): return predicate()
class Camera:
    session_id = 'test-session'
    cv = Condition()
    frames = 7
    jpeg = b'\xff\xd8fake-test-frame\xff\xd9'
    last_frame = 10
    clients = 0
    def attach(self): self.clients += 1
    def detach(self): self.clients -= 1
def request_stream(last_frame):
    camera = Camera()
    camera.last_frame = last_frame
    scope['preview'] = camera
    handler = object.__new__(scope['Handler'])
    handler.path = '/stream'
    handler.connection = SimpleNamespace(settimeout=lambda value: None)
    handler.send_response = lambda *args: None
    handler.send_header = lambda *args: None
    handler.end_headers = lambda: None
    handler.wfile = io.BytesIO()
    handler.do_GET()
    assert camera.clients == 0, 'completed streams must detach their client'
    return handler.wfile.getvalue()
assert request_stream(10) == b'', 'stale cached JPEG must not be delivered to a new client'
assert request_stream(100).count(Camera.jpeg) == 1, 'a frame must not be repeated after capture stalls'
print('PASS: 5 A8 recovery checks; no device, network or decoder started.')
