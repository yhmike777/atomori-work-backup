"""Continuously drain RTSP video so slower ROS publishers see the latest frame."""
import os
import threading
import time


class LatestRtspCapture:
    def __init__(self, url, reconnect_interval=2.0, warning=lambda _: None):
        self.url = url
        self.reconnect_interval = reconnect_interval
        self.warning = warning
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._frame = None
        self._frame_time = 0.0
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def take_latest(self):
        with self._lock:
            frame, self._frame = self._frame, None
            if time.monotonic() - self._frame_time > 2.0:
                return None
            return frame

    def close(self):
        self._stop.set()
        # FFmpeg open/read timeouts bound worker shutdown, including disconnects.
        self._thread.join(timeout=9.0)

    def _run(self):
        import cv2
        os.environ.setdefault('OPENCV_FFMPEG_CAPTURE_OPTIONS', 'rtsp_transport;tcp')
        cv2.setNumThreads(1)
        while not self._stop.is_set():
            cap = None
            try:
                cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG, [
                    cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000,
                    cv2.CAP_PROP_READ_TIMEOUT_MSEC, 3000,
                ])
                if not cap.isOpened():
                    raise RuntimeError('RTSP connection unavailable')
                failed_reads = 0
                failure_since = None
                while not self._stop.is_set():
                    read_started = time.monotonic()
                    ok, frame = cap.read()
                    now = time.monotonic()
                    if not ok or frame is None:
                        failed_reads += 1
                        if failure_since is None:
                            failure_since = read_started
                        # A corrupt HEVC packet can fail immediately while the
                        # RTSP connection remains healthy. Retry it briefly;
                        # a real read timeout still reconnects immediately.
                        if (now - read_started >= 2.5 or failed_reads >= 3
                                or now - failure_since >= 0.5):
                            raise RuntimeError('RTSP frame unavailable')
                        if self._stop.wait(0.05):
                            break
                        continue
                    failed_reads = 0
                    failure_since = None
                    with self._lock:
                        self._frame = frame
                        self._frame_time = time.monotonic()
            except (RuntimeError, cv2.error) as exc:
                if not self._stop.is_set():
                    self.warning(f'{exc}; retrying RTSP connection')
            finally:
                if cap is not None:
                    cap.release()
                with self._lock:
                    self._frame = None
            self._stop.wait(self.reconnect_interval)
