// 实机只读检查：只计流量和 JPEG 帧，不保存视频、不发送控制。
const base = process.env.ATOMORI_CHECK_URL || 'http://127.0.0.1:3000';
const duration = Number(process.env.ATOMORI_CHECK_SECONDS || 90) * 1000;
const clientId = crypto.randomUUID();
const controller = new AbortController();
const start = Date.now();
let bytes = 0, frames = 0, previous = null, lastReport = start;
const response = await fetch(`${base}/api/v1/devices/UAV-01/cameras/ov9281.mjpg?clientId=${clientId}`, { signal: controller.signal });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const timer = setTimeout(() => controller.abort(), duration);
try {
  for await (const chunk of response.body) {
    bytes += chunk.length;
    for (const byte of chunk) { if (previous === 255 && byte === 216) frames++; previous = byte; }
    if (Date.now() - lastReport > 20000) { console.log(JSON.stringify({ elapsedMs: Date.now() - start, bytes, frames })); lastReport = Date.now(); }
  }
  throw new Error('视频流提前结束');
} catch (error) {
  if (!controller.signal.aborted || Date.now() - start < duration || !frames) throw error;
} finally { clearTimeout(timer); }
console.log(JSON.stringify({ result: 'continuous', elapsedMs: Date.now() - start, bytes, frames }));
const telemetry = await fetch(`${base}/api/v1/devices/UAV-01/telemetry`).then(r => r.json());
console.log(JSON.stringify({ flight: telemetry.data?.flight, vision: telemetry.data?.vision }));
const command = await fetch(`${base}/api/v1/commands`, { method: 'POST', body: '{}' });
console.log(JSON.stringify({ commandHttpStatus: command.status }));
if (command.status !== 503) throw new Error('真实控制必须保持关闭');
