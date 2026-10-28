import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';

const flight = () => ({ flight_controller_connected: true, vehicle_state_age_s: 0.1, mode: 'GUIDED',
  telemetry: { roll_deg: 0, pitch_deg: -1, rangefinder_m: 1.2 },
  telemetry_meta: { roll_deg: { valid: true, age_s: 0.1, unit: 'deg' }, pitch_deg: { valid: true, age_s: 0.1, unit: 'deg' }, rangefinder_m: { valid: true, age_s: 0.1, unit: 'm' } }
});
const vision = () => ({ sensor: 'ov9281', found: true, tag_id: 1, quality_passed: true, capture_age_ms: 100, frame_age_ms: 100,
  orientation: { frame: 'BODY_FRD', source: 'PNP_TAG_TO_PAD_TO_BODY', valid: true, position_body_frd_m: [0, 0.2, 1.8], pad_heading_body_deg: 0 }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('机载 IMU、航向独立于定位，校验单位、时效、断连且不推断自检正常', async () => {
  const raw = flight();
  raw.vehicle_state_age_s = 1.2;
  for (const [key, value, unit] of [['gyro_x', 0, 'rad/s'], ['gyro_y', -0.002, 'rad/s'], ['accel_z', 9.8, 'm/s²'], ['heading_deg', 306.2, 'deg']]) {
    raw.telemetry[key] = value;
    raw.telemetry_meta[key] = { valid: true, age_s: 0.05, unit, source: '/mavros/imu/data' };
  }
  const adapter = createUpstreamIntegrations({ uavFlightUrl: 'http://flight', fetchImpl: async () => Response.json(raw) });
  let result = (await adapter.telemetry('UAV-01', 'flight')).flight;
  assert.equal(result.details.metrics.gyroX.value, 0);
  assert.equal(result.details.metrics.gyroY.value, -0.002);
  assert.equal(result.details.metrics.accelZ.value, 9.8);
  assert.equal(result.details.metrics.heading.value, 306.2);
  assert.equal(result.metrics.localAltitude.value, null);
  assert.equal(result.details.health, undefined);
  raw.telemetry_meta.gyro_x.age_s = 0.6;
  raw.telemetry_meta.accel_z.unit = 'wrong';
  result = (await adapter.telemetry('UAV-01', 'flight')).flight;
  assert.equal(result.details.metrics.gyroX.value, null);
  assert.equal(result.details.metrics.accelZ.value, null);
  assert.equal(result.details.metrics.gyroY.valid, true);
  raw.flight_controller_connected = false;
  result = (await adapter.telemetry('UAV-01', 'flight')).flight;
  assert.equal(result.details.metrics.heading.value, null);
  assert.equal(result.details.metrics.gyroY.value, null);
});

test('飞控与视觉独立读取：另一源请求挂起或失败不阻塞有效样本', async () => {
  for (const slow of ['vision', 'flight']) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const adapter = createUpstreamIntegrations({ uavFlightUrl: 'http://flight', uavVisionUrl: 'http://vision', fetchImpl: async url => {
      const source = new URL(url).hostname; calls.push(source);
      if (source === slow) { await gate; throw new Error('source offline'); }
      return Response.json(source === 'flight' ? flight() : vision());
    } });
    const blocked = adapter.telemetry('UAV-01', slow);
    const fast = slow === 'flight' ? 'vision' : 'flight';
    try {
      const data = await Promise.race([adapter.telemetry('UAV-01', fast), delay(500).then(() => { throw new Error('另一源阻塞了独立读取'); })]);
      assert.equal(Object.hasOwn(data, slow), false);
      if (fast === 'flight') { assert.equal(data.flight.connected, true); assert.equal(data.flight.metrics.roll.valid, true); }
      else assert.equal(data.vision.relativePose.valid, true);
      assert.deepEqual(calls.sort(), ['flight', 'vision']);
    } finally { release(); }
    await assert.rejects(blocked, error => error.code === 'UPSTREAM_UNAVAILABLE');
  }
});

test('旧组合接口并行读取并将各源请求与等待计入采样年龄，snapshotAgeS 明确可抵扣', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const adapter = createUpstreamIntegrations({ uavFlightUrl: 'http://flight', uavVisionUrl: 'http://vision', fetchImpl: async url => {
    const source = new URL(url).hostname; calls.push(source);
    if (source === 'vision') await gate;
    return Response.json(source === 'flight' ? flight() : vision());
  } });
  const pending = adapter.telemetry('UAV-01');
  assert.deepEqual(calls.sort(), ['flight', 'vision'], '两次请求均在等待视觉完成前发出');
  await delay(45); release();
  const data = await pending;
  assert.equal(data.ageIncludes, 'device-http-and-response-wait');
  assert.ok(data.snapshotAgeS >= 0.04);
  for (const age of [data.flight.stateAgeS, data.flight.metrics.roll.ageS, data.vision.relativePose.ageS, data.vision.frameAgeMs / 1000]) {
    assert.ok(age >= 0.14);
    assert.ok(Math.abs(age - 0.1 - data.snapshotAgeS) < 0.02, '采样年龄只加一次适配器等待时间');
  }
});

test('慢响应不能刷新采样时间：过期姿态与相对位姿仍被有效期门控清空', async () => {
  const adapter = createUpstreamIntegrations({ uavFlightUrl: 'http://flight', uavVisionUrl: 'http://vision', fetchImpl: async url => {
    const raw = new URL(url).hostname === 'flight' ? flight() : vision();
    if (raw.telemetry_meta) raw.telemetry_meta.roll_deg.age_s = 0.48;
    else raw.capture_age_ms = 1980;
    await delay(45);
    return Response.json(raw);
  } });
  const [f, v] = await Promise.all([adapter.telemetry('UAV-01', 'flight'), adapter.telemetry('UAV-01', 'vision')]);
  assert.equal(f.flight.metrics.roll.valid, false);
  assert.equal(f.flight.rollDeg, null);
  assert.equal(f.flight.metrics.pitch.valid, true);
  assert.equal(v.vision.relativePose.valid, false);
  assert.equal(v.vision.relativePose.reason, 'STALE_OR_UNKNOWN_AGE');
  assert.equal(v.vision.relativePose.zM, null);
});

test('仅配置视觉服务时仍可读取真实内嵌飞控，不制造第二个独立来源', async () => {
  const adapter = createUpstreamIntegrations({ uavVisionUrl: 'http://vision', fetchImpl: async () => Response.json({ ...vision(), flight: flight() }) });
  const data = await adapter.telemetry('UAV-01');
  assert.equal(data.flight.source, 'vision-embedded');
  assert.equal(data.flight.connected, true);
  assert.equal(data.vision.relativePose.valid, true);
});
