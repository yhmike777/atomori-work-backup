// Observe complete JPEG parts without changing or delaying the proxied stream.
export function createFrameObserver(health, now = Date.now) {
  let buffer = Buffer.alloc(0), size = null, headers = null;
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      if (size === null) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) { if (buffer.length > 8192) buffer = Buffer.alloc(0); return; }
        headers = buffer.subarray(0, end).toString('ascii');
        buffer = buffer.subarray(end + 4);
        size = Number(headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
        if (!Number.isSafeInteger(size) || size < 4 || size > 4 * 1024 * 1024) {
          buffer = Buffer.alloc(0); size = null; return;
        }
      }
      if (buffer.length < size) return;
      const frame = buffer.subarray(0, size);
      const id = Number(headers.match(/(?:^|\r\n)X-Frame-Id:\s*(\d+)/i)?.[1]);
      const decodedAtMs = Number(headers.match(/(?:^|\r\n)X-Frame-Decoded-At-Ms:\s*([\d.]+)/i)?.[1]);
      const session = headers.match(/(?:^|\r\n)X-Frame-Session:\s*([a-zA-Z0-9-]+)/i)?.[1];
      if (frame[0] === 255 && frame[1] === 216 && frame[size - 2] === 255 && frame[size - 1] === 217
          && Number.isSafeInteger(id) && id >= 0 && Number.isFinite(decodedAtMs) && decodedAtMs > 0 && session
          && (health.frameSession !== session || id > (health.frameId ?? -1))) {
        Object.assign(health, { frameId: id, frameSession: session, frameDecodedAtMs: decodedAtMs, frameReceivedAtMs: now() });
      }
      buffer = buffer.subarray(size); size = null;
    }
  };
}

export function calibratedFrameTiming(health, calibration, now = Date.now()) {
  if (!health.active || !calibration || health.frameSession !== calibration.sessionId
      || ![health.frameDecodedAtMs, health.frameReceivedAtMs, calibration.offsetMs, calibration.uncertaintyMs, calibration.measuredAtMs].every(Number.isFinite)
      || calibration.uncertaintyMs < 0 || calibration.uncertaintyMs > 1000
      || now - calibration.measuredAtMs < 0 || now - calibration.measuredAtMs > 10000
      || now - health.frameReceivedAtMs < 0 || now - health.frameReceivedAtMs > 3000) return null;
  const sampledAtMs = health.frameDecodedAtMs + calibration.offsetMs;
  const delay = health.frameReceivedAtMs - sampledAtMs;
  if (delay < -calibration.uncertaintyMs || now - sampledAtMs + calibration.uncertaintyMs > 3000) return null;
  return { verified: true, frameId: health.frameId, sampledAtMs, receivedAtMs: health.frameReceivedAtMs,
    delayMs: Math.max(0, delay), uncertaintyMs: calibration.uncertaintyMs,
    basis: 'pi_jpeg_decode_to_local_receive', exposureTimeVerified: false };
}
