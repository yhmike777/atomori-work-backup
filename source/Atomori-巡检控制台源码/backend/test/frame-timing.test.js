import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameObserver, calibratedFrameTiming } from '../src/frame-timing.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

const part = (id, timestamp = 1000, session = 'camera1') => Buffer.concat([
  Buffer.from(`--a8frame\r\nContent-Type: image/jpeg\r\nContent-Length: 5\r\nX-Frame-Id: ${id}\r\nX-Frame-Decoded-At-Ms: ${timestamp}\r\nX-Frame-Session: ${session}\r\n\r\n`),
  Buffer.from([255, 216, 17, 255, 217]), Buffer.from('\r\n')]);

test('帧校验按完整JPEG而不是网络chunk计时，重复帧不刷新时间', () => {
  const health = {}; let now = 1200;
  const observe = createFrameObserver(health, () => now);
  const bytes = part(1);
  for (let i = 0; i < bytes.length - 3; i++) observe(bytes.subarray(i, i + 1));
  assert.equal(health.frameId, undefined);
  observe(bytes.subarray(bytes.length - 3));
  assert.equal(health.frameId, 1);
  assert.equal(health.frameReceivedAtMs, 1200);
  now = 1500; observe(part(1)); assert.equal(health.frameReceivedAtMs, 1200);
  observe(Buffer.concat([part(2), part(3)])); assert.equal(health.frameId, 3);
  observe(part(1, 1400, 'restarted')); assert.equal(health.frameSession, 'restarted');
});

test('缺失时间、坏JPEG和超长帧头不产生可验证样本', () => {
  const health = {}, observe = createFrameObserver(health);
  observe(Buffer.from('x'.repeat(9000)));
  const bad = part(1); bad[bad.length - 3] = 0; observe(bad);
  assert.equal(health.frameId, undefined);
  observe(Buffer.from('--a8frame\r\nContent-Length: 999999999\r\n\r\n'));
  assert.equal(health.frameId, undefined);
  observe(part(3)); assert.equal(health.frameId, 3);
});

test('校正设备时钟偏差并保留误差范围，过期/换机/未校准不显示延迟', () => {
  const health = { active: true, frameSession: 'camera1', frameId: 3, frameDecodedAtMs: 1000, frameReceivedAtMs: 1600 };
  const calibration = { sessionId: 'camera1', offsetMs: 500, uncertaintyMs: 20, measuredAtMs: 1550 };
  const result = calibratedFrameTiming(health, calibration, 1700);
  assert.equal(result.sampledAtMs, 1500); assert.equal(result.delayMs, 100);
  assert.equal(result.exposureTimeVerified, false);
  assert.equal(calibratedFrameTiming(health, null, 1700), null);
  assert.equal(calibratedFrameTiming(health, { ...calibration, sessionId: 'other' }, 1700), null);
  assert.equal(calibratedFrameTiming(health, calibration, 4700), null);
  assert.equal(calibratedFrameTiming({ ...health, active: false }, calibration, 1700), null);
  assert.equal(calibratedFrameTiming(health, { ...calibration, offsetMs: 1000 }, 1700), null);
  assert.equal(calibratedFrameTiming({ ...health, frameReceivedAtMs: 10000 }, { ...calibration, measuredAtMs: 10000 }, 10010), null,
    '刚收到的旧采样不能标为实时帧');
});

test('状态时钟校准失败不影响视频列表，前视为唯一车端相机', async () => {
  const adapter = createUpstreamIntegrations({ carUrl: 'http://car', fetchImpl: async () => { throw new Error('clock offline'); } });
  const uav = await adapter.stream('UAV-01');
  assert.equal(uav.streams[0].id, 'a8'); assert.equal(uav.timingCalibration, null);
  assert.deepEqual((await adapter.stream('UGV-01')).streams.map(item => item.id), ['front']);
});

test('独立H100视频源不依赖车端网关，状态和视频来自同一设备', async () => {
  const calls = [];
  const adapter = createUpstreamIntegrations({ uavVideoUrl: 'http://a8', fetchImpl: async url => {
    calls.push(String(url));
    return String(url).endsWith('/api/status')
      ? Response.json({ server_time_ms: Date.now(), session_id: 'test', frame_time_basis: 'pi_jpeg_decode_complete' })
      : new Response('test', { headers: { 'content-type': 'multipart/x-mixed-replace; boundary=a8frame' } });
  } });
  assert.equal(adapter.status().uavVideoConfigured, true);
  assert.equal(adapter.status().carConfigured, false);
  const data = await adapter.stream('UAV-01');
  assert.equal(data.timingCalibration.sessionId, 'test');
  await (await adapter.media('UAV-01', 'a8.mjpg')).body.cancel();
  assert.deepEqual(calls, ['http://a8/api/status', 'http://a8/stream']);
});
