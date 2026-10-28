"""Apply and verify a bounded recovery fix for the existing A8 preview service."""
import ast
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

path = Path('/home/pi/a8mini/h100-web/server.py')
original = path.read_bytes()
text = original.decode('utf-8').replace('\r\n', '\n')
marker = '# H100_DECODER_RECOVERY_20261028'
if marker in text:
    print(json.dumps({'alreadyPatched': True, 'sha256': hashlib.sha256(original).hexdigest()}))
    raise SystemExit(0)

helper = '''# H100_DECODER_RECOVERY_20261028
def stop_decoder(decoder):
    if decoder.poll() is not None:
        return
    try:
        decoder.terminate()
    except ProcessLookupError:
        pass
    try:
        decoder.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            decoder.kill()
        except ProcessLookupError:
            pass
        decoder.wait(timeout=2)

'''

def replace_once(before, after):
    global text
    if text.count(before) != 1:
        raise RuntimeError('Source differs from the inspected version; refusing replacement: ' + before[:70])
    text = text.replace(before, after, 1)

replace_once('class Preview:\n', helper + 'class Preview:\n')
replace_once('if self.worker is None:\n', 'if self.worker is None or not self.worker.is_alive():\n')
replace_once("            return dict(state=self.state, error=self.error, frames=self.frames,\n",
'''            state, error = self.state, self.error
            if state == 'live' and (age is None or age >= 3):
                state, error = 'reconnecting', 'No fresh camera frame; reconnecting'
            return dict(state=state, error=error, frames=self.frames,
''')
replace_once('''                            decoder.terminate()
                            break
''', '''                            with self.cv:
                                self.state = 'reconnecting'
                                self.error = 'Video stalled; reconnecting'
                                self.jpeg = None
                                self.cv.notify_all()
                            stop_decoder(decoder)
                            break
''')
replace_once('''                    if proc.poll() is None: proc.terminate()
                    try: proc.wait(timeout=3)
                    except subprocess.TimeoutExpired: proc.kill()
''', '''                    stop_decoder(proc)
''')
replace_once('''                    preview.cv.wait_for(lambda: preview.frames != seen and preview.jpeg is not None, timeout=5)
                    image, count = preview.jpeg, preview.frames
                if image is None:
                    # Sends data to discover a closed browser even during reconnects.
                    self.wfile.write(b'\\r\\n'); self.wfile.flush()
                    continue
                if count == seen: continue
''', '''                    preview.cv.wait_for(lambda: preview.frames != seen and preview.jpeg is not None
                                        and time.time() - preview.last_frame < 3, timeout=5)
                    image = preview.jpeg if time.time() - preview.last_frame < 3 else None
                    count = preview.frames
                if image is None or count == seen:
                    # End a stalled stream: the browser can reconnect without receiving cached frames.
                    return
''')

compile(text, str(path), 'exec')
tree = ast.parse(text)
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

before_hash = hashlib.sha256(original).hexdigest()
if path.read_bytes() != original:
    raise RuntimeError('Camera source changed during validation; refusing to overwrite it')
backup = path.parent / 'backups' / ('server.before-h100-recovery-' + before_hash[:12] + '.py')
backup.parent.mkdir(exist_ok=True)
if not backup.exists(): shutil.copy2(path, backup)
temporary = path.with_name('server.h100-recovery.tmp')
temporary.write_text(text, encoding='utf-8')
temporary.chmod(stat.S_IMODE(path.stat().st_mode))
os.replace(temporary, path)
print(json.dumps({'patched': True, 'tests': 5, 'backup': str(backup),
    'beforeSha256': before_hash, 'afterSha256': hashlib.sha256(path.read_bytes()).hexdigest()}))
