import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { RecordStore } from '../src/store.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('车端与机载只读接口可映射和代理，控制保持关闭', async () => {
  const car = await listen((req, res) => {
    if (req.url === '/api/status') return res.end(JSON.stringify({ server_time_ms: 1780000000000, odom: { pose: [1, 2, 0.5], speed_mps: 0.2 }, topic_ages_s: { odom: 0.1 }, battery_voltage: null, camera: { ready: true, age_s: 0.1 }, map: { info: { width: 20 }, age_s: 0.2 } }));
    if (req.url === '/api/scan.json') return res.end(JSON.stringify({ age_s: 0.1, points: [[0, 1]] }));
    if (req.url === '/api/camera.jpg') { res.setHeader('content-type', 'image/jpeg'); return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); }
    if (req.url === '/api/map.png' || req.url === '/api/maps/map_20260924_224659.png') { res.setHeader('content-type', 'image/png'); return res.end(Buffer.from([137, 80, 78, 71])); }
    res.writeHead(503); res.end();
  });
  const vision = await listen((req, res) => {
    if (req.url === '/api/status') return res.end(JSON.stringify({ sensor: 'ov9281', mode: 'apriltag', frame_age_ms: 90, found: true, tag_id: 1, distance_m: 1.3, flight: { flight_controller_connected: false, mode: 'DISCONNECTED' } }));
    if (req.url === '/stream.mjpg') { res.setHeader('content-type', 'multipart/x-mixed-replace; boundary=FRAME'); return res.end('--FRAME\r\n'); }
    res.writeHead(404); res.end();
  });
  const flight = await listen((req, res) => {
    if (req.url === '/api/status') return res.end(JSON.stringify({ flight_controller_connected: true, armed: false, mode: 'GUIDED', landed_state: 'ON_GROUND', vehicle_state_age_s: 0.1, telemetry: { estimated_altitude_m: 1.2, rangefinder_m: 1.1 } }));
    res.writeHead(404); res.end();
  });
  const directory = await mkdtemp(join(tmpdir(), 'atomori-upstream-'));
  const store = new RecordStore(join(directory, 'records.json'));
  await store.init();
  const integrations = createUpstreamIntegrations({ carUrl: car.url, uavVisionUrl: vision.url, uavFlightUrl: flight.url });
  const app = await listen(createApp({ store, webRoot: resolve(fileURLToPath(new URL('../../', import.meta.url))), integrations }));
  try {
    const status = await fetch(`${app.url}/api/v1/integrations`).then(r => r.json());
    assert.equal(status.data.mode, 'upstream-readonly');
    assert.equal(status.data.commandsEnabled, false);
    const ugv = (await fetch(`${app.url}/api/v1/devices/UGV-01/telemetry`).then(r => r.json())).data;
    assert.equal(ugv.odom.speedMps, 0.2);
    assert.equal(ugv.batteryVoltage, null);
    const uav = (await fetch(`${app.url}/api/v1/devices/UAV-01/telemetry`).then(r => r.json())).data;
    assert.equal(uav.flight.connected, true);
    assert.equal(uav.flight.source, 'flight-status-http');
    assert.equal(uav.flight.estimatedAltitudeM, 1.2);
    assert.equal(uav.vision.tagId, 1);
    const scan = (await fetch(`${app.url}/api/v1/devices/UGV-01/scan`).then(r => r.json())).data;
    assert.deepEqual(scan.points, [[0, 1]]);
    const image = await fetch(`${app.url}/api/v1/devices/UGV-01/cameras/front.jpg`);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
    const map = await fetch(`${app.url}/api/v1/maps/current.png`);
    assert.equal(map.headers.get('content-type'), 'image/png');
    const savedMap = await fetch(`${app.url}/api/v1/maps/map_20260924_224659.png`);
    assert.equal(savedMap.status, 200);
    assert.equal(savedMap.headers.get('content-type'), 'image/png');
    assert.deepEqual([...new Uint8Array(await savedMap.arrayBuffer())], [137, 80, 78, 71]);
    await assert.rejects(integrations.mapImage('../other'), error => error.code === 'INVALID_MAP_NAME');
    const stream = await fetch(`${app.url}/api/v1/devices/UAV-01/cameras/ov9281.mjpg`);
    assert.match(stream.headers.get('content-type'), /multipart\/x-mixed-replace/);
    await stream.arrayBuffer();
    const command = await fetch(`${app.url}/api/v1/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(command.status, 503);
  } finally {
    for (const item of [app, car, vision, flight]) await new Promise(done => item.server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
