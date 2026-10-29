import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';

const camera = { sensor: 'ov9281', mode: 'apriltag', frame_age_ms: 30, capture_age_ms: 40,
  capture_fps: 10, encoded_fps: 7, found: true, tag_id: 0, quality_passed: true,
  orientation: { valid: true, frame: 'BODY_FRD', source: 'PNP_TAG_TO_PAD_TO_BODY', position_body_frd_m: [0, 1, 2], pad_heading_body_deg: 0 } };

test('independent vision uses the small camera snapshot and preserves complete pose fields', async () => {
  const calls = [];
  const adapter = createUpstreamIntegrations({ uavVisionUrl: 'http://vision', uavFlightUrl: 'http://flight',
    fetchImpl: async url => { calls.push(url); return Response.json(camera); } });
  const data = await adapter.telemetry('UAV-01', 'vision');
  assert.deepEqual(calls, ['http://vision/api/vision']);
  assert.equal(Object.hasOwn(data, 'flight'), false);
  assert.equal(data.vision.relativePose.valid, true);
  assert.equal(data.vision.relativePose.xM, 0);
  assert.equal(data.vision.relativePose.yawDeg, 0);
  assert.equal(data.vision.encodedFps, 7);
});

test('old camera services fall back once on missing endpoint; combined mode retains embedded flight', async () => {
  const calls = [];
  const adapter = createUpstreamIntegrations({ uavVisionUrl: 'http://vision', fetchImpl: async url => {
    calls.push(url);
    return url.endsWith('/api/vision') ? new Response(null, { status: 404 })
      : Response.json({ ...camera, flight: { flight_controller_connected: true, vehicle_state_age_s: .1, mode: 'STABILIZE' } });
  } });
  for (let i = 0; i < 2; i++) assert.equal((await adapter.telemetry('UAV-01', 'vision')).vision.sensor, 'ov9281');
  assert.deepEqual(calls, ['http://vision/api/vision', 'http://vision/api/status', 'http://vision/api/status']);
  const combined = await adapter.telemetry('UAV-01');
  assert.equal(combined.flight.mode, 'STABILIZE');
  assert.equal(combined.vision.sensor, 'ov9281');
});

test('temporary failure never doubles H100 traffic or permanently selects the legacy endpoint', async () => {
  const calls = []; let failed = true;
  const adapter = createUpstreamIntegrations({ uavVisionUrl: 'http://vision', fetchImpl: async url => {
    calls.push(url); return failed ? new Response(null, { status: 503 }) : Response.json(camera);
  } });
  await assert.rejects(adapter.telemetry('UAV-01', 'vision'), error => error.code === 'UPSTREAM_UNAVAILABLE');
  failed = false;
  assert.equal((await adapter.telemetry('UAV-01', 'vision')).vision.sensor, 'ov9281');
  assert.deepEqual(calls, ['http://vision/api/vision', 'http://vision/api/vision']);
});
