import json, subprocess, threading, time, select
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROOT=Path(__file__).parent
# H100_DECODER_RECOVERY_20261028
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

class Preview:
    def __init__(self):
        self.cv = threading.Condition()
        self.clients = 0
        self.worker = None
        self.jpeg = None
        self.frames = 0
        self.last_frame = 0
        self.state = 'idle'
        self.error = ''

    def attach(self):
        with self.cv:
            self.clients += 1
            if self.worker is None or not self.worker.is_alive():
                self.worker = threading.Thread(target=self.run, daemon=True)
                self.worker.start()

    def detach(self):
        with self.cv:
            self.clients = max(0, self.clients - 1)
            self.cv.notify_all()

    def status(self):
        with self.cv:
            age = time.time() - self.last_frame if self.last_frame else None
            state, error = self.state, self.error
            if state == 'live' and (age is None or age >= 3):
                state, error = 'reconnecting', 'No fresh camera frame; reconnecting'
            return dict(state=state, error=error, frames=self.frames,
                        age_seconds=age, clients=self.clients, preview_fps=10,
                        source_fps=30, width=640, height=360)

    def run(self):
        while True:
            client = proc = channel = None
            done = threading.Event()
            try:
                with self.cv:
                    if not self.clients:
                        self.worker = None
                        self.state = "idle"
                        self.jpeg = None
                        return
                    self.state = 'connecting'
                    self.error = ''
                    self.jpeg = None
                args = ['/usr/bin/ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
                        '-threads', '2', '-rtsp_transport', 'tcp',
                        '-i', 'rtsp://192.168.144.25:8554/main.264', '-an',
                        '-vf', 'fps=10,scale=640:360', '-threads', '2', '-c:v', 'mjpeg',
                        '-q:v', '7', '-f', 'image2pipe', '-flush_packets', '1', 'pipe:1']
                proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, bufsize=0)
                def watch(decoder=proc):
                    idle_since = None
                    started = time.time()
                    while not done.wait(1):
                        with self.cv:
                            active, last = self.clients > 0, self.last_frame
                        idle_since = None if active else (idle_since or time.time())
                        if (idle_since and time.time() - idle_since > 4) or time.time() - max(started,last) > 20:
                            with self.cv:
                                self.state = 'reconnecting'
                                self.error = 'Video stalled; reconnecting'
                                self.jpeg = None
                                self.cv.notify_all()
                            stop_decoder(decoder)
                            break
                threading.Thread(target=watch, daemon=True).start()
                buf = b''
                while True:
                    chunk = proc.stdout.read(65536)
                    if not chunk: break
                    buf += chunk
                    while True:
                        start = buf.find(b'\xff\xd8')
                        if start < 0:
                            buf = buf[-1:]
                            break
                        end = buf.find(b'\xff\xd9', start + 2)
                        if end < 0:
                            buf = buf[start:]
                            break
                        jpeg, buf = buf[start:end + 2], buf[end + 2:]
                        with self.cv:
                            self.jpeg = jpeg
                            self.frames += 1
                            self.last_frame = time.time()
                            self.state = 'live'
                            self.cv.notify_all()
                with self.cv:
                    if self.clients: self.error = '视频连接中断，正在重连'
            except Exception as exc:
                with self.cv:
                    self.error = str(exc)
                print(type(exc).__name__, str(exc), flush=True)
            finally:
                done.set()
                if channel: channel.close()
                if proc:
                    stop_decoder(proc)
                if client: client.close()
            with self.cv:
                if not self.clients:
                    self.worker = None
                    self.state = "idle"
                    self.jpeg = None
                    return
                self.state = 'reconnecting'
            time.sleep(2)
        with self.cv:
            self.state = 'idle'
            self.jpeg = None
            self.worker = None
            self.cv.notify_all()

preview = Preview()
class Gimbal:
    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None
    def close(self):
        if self.proc:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.terminate()
                self.proc.wait(timeout=2)
            self.proc = None
    def read_reply(self):
        if not select.select([self.proc.stdout], [], [], 2)[0]:
            raise RuntimeError('云台控制服务响应超时')
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError('云台串口被占用或控制服务已退出')
        return json.loads(line)
    def send(self, request):
        with self.lock:
            try:
                if self.proc is None or self.proc.poll() is not None:
                    self.close()
                    self.proc = subprocess.Popen(
                        ['/usr/bin/python3','-u','/home/pi/a8mini/gimbal_bridge.py'],
                        stdin=subprocess.PIPE,stdout=subprocess.PIPE,bufsize=0)
                    if not self.read_reply().get('ready'):
                        raise RuntimeError('云台控制服务未就绪')
                self.proc.stdin.write((json.dumps(request)+'\n').encode())
                return self.read_reply()
            except Exception:
                self.close()
                raise

gimbal = Gimbal()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def data(self, data, kind, code=200):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/':
            return self.data((ROOT / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        if path == '/api/status':
            return self.data(json.dumps(preview.status()).encode(), 'application/json')
        if path == '/snapshot.jpg':
            with preview.cv:
                image = preview.jpeg if time.time() - preview.last_frame < 3 else None
            return self.data(image or b'No live frame', 'image/jpeg' if image else 'text/plain', 200 if image else 503)
        if path != '/stream': return self.data(b'Not found', 'text/plain', 404)
        self.connection.settimeout(10)
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=a8frame')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        preview.attach()
        try:
            seen = -1
            while True:
                with preview.cv:
                    preview.cv.wait_for(lambda: preview.frames != seen and preview.jpeg is not None
                                        and time.time() - preview.last_frame < 3, timeout=5)
                    image = preview.jpeg if time.time() - preview.last_frame < 3 else None
                    count = preview.frames
                if image is None or count == seen:
                    # End a stalled stream: the browser can reconnect without receiving cached frames.
                    return
                seen = count
                self.wfile.write(b'--a8frame\r\nContent-Type: image/jpeg\r\nContent-Length: '
                                 + str(len(image)).encode() + b'\r\n\r\n' + image + b'\r\n')
                self.wfile.flush()
        except (OSError, TimeoutError):
            pass
        finally:
            preview.detach()


    def do_POST(self):
        if self.path != '/api/gimbal': return self.data(b'Not found', 'text/plain', 404)
        if self.headers.get('Origin') not in ('http://192.168.50.3:8870',):
            return self.data(b'Origin rejected', 'text/plain', 403)
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 512: raise ValueError('Invalid body length')
            request = json.loads(self.rfile.read(size))
            if request.get('action') not in ('up', 'down', 'left', 'right', 'stop'):
                raise ValueError('Invalid action')
            token = request.get('press_id', '')
            if not isinstance(token, str) or len(token) > 80: raise ValueError('Invalid press_id')
            if request['action'] != 'stop' and not token: raise ValueError('Missing press_id')
            speed = request.get('speed', 15)
            if type(speed) is not int or not 5 <= speed <= 30: raise ValueError('Invalid speed')
            result = gimbal.send({'action': request['action'], 'press_id': token, 'speed': speed})
            self.data(json.dumps(result).encode(), 'application/json', 200 if result.get('ok') else 502)
        except (ValueError, TypeError) as exc:
            self.data(json.dumps({'ok': False, 'error': str(exc)}).encode(), 'application/json', 400)
        except Exception:
            self.data(json.dumps({'ok': False, 'error': '云台连接中断，请松开按钮后重试'}).encode(), 'application/json', 503)


if __name__ == "__main__":
    ThreadingHTTPServer(("192.168.50.3",8870),Handler).serve_forever()
