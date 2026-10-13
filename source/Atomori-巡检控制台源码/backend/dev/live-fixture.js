// 本地浏览器检查用：模拟既有车端和机载只读 HTTP 契约，不连接设备。
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { RecordStore } from '../src/store.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

async function listen(handler, port = 0) {
  const server = createServer(handler);
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const car = await listen((req, res) => {
  if (req.url === '/api/status') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ server_time_ms: Date.now(), odom: { pose: [1, 2, 0], speed_mps: 0.18 }, topic_ages_s: { odom: 0.1 }, battery_voltage: null, camera: { ready: true, age_s: 0.1 } }));
  }
  res.writeHead(503); res.end();
});
const vision = await listen((req, res) => {
  if (req.url === '/api/status') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ sensor: 'ov9281', mode: 'apriltag', frame_age_ms: 80, found: true, tag_id: 1, flight: { flight_controller_connected: true, armed: false, mode: 'GUIDED', landed_state: 'ON_GROUND', vehicle_state_age_s: 0.1, telemetry: { estimated_altitude_m: 1.25, rangefinder_m: 1.18 } } }));
  }
  res.writeHead(503); res.end();
});
const directory = await mkdtemp(join(tmpdir(), 'atomori-browser-'));
const store = new RecordStore(join(directory, 'records.json'));
await store.init();
const integrations = createUpstreamIntegrations({ carUrl: car.url, uavVisionUrl: vision.url });
const webRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
await listen(createApp({ store, webRoot, integrations }), 3100);
console.log('本地只读模拟页: http://127.0.0.1:3100/');
