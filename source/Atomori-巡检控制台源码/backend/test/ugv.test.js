import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';

const fixture = () => ({
  server_time_ms: 1791513351230,
  odom: { pose: [0, -1, 0], speed_mps: 0 }, topic_ages_s: { odom: 0.1, ugv_control_mux: 0.1 },
  environment: { available: true, stale: false, age_s: 0.2, temperature_c: 0, humidity_percent: 0,
    digital: Object.fromEntries(['tilt', 'flame', 'mq2'].map(key => [key, { available: true, stale: false, age_s: 0.1, triggered: false }])) },
  ultrasonic: { range: 0, age_s: 0.1 }, battery_voltage: null,
  localization: { active: true, state: 'localized', map_pose: [5, -1, 0.3], age_s: 0.1 },
  camera: { ready: false, age_s: null }, leadscrew: { age_s: 0.1, status: { state: [4, 4] } }
});
const read = status => createUpstreamIntegrations({ carUrl: 'http://127.0.0.1:8765', fetchImpl: async () => new Response(JSON.stringify(status)) }).telemetry('UGV-01');

test('小车实时契约保留零值、位姿和未触发状态，映射现有环境与机构数据', async () => {
  const data = await read(fixture());
  assert.equal(data.metrics.speed.value, 0);
  assert.equal(data.environment.temperatureC, 0);
  assert.equal(data.environment.humidityPercent, 0);
  assert.equal(data.ultrasonic.rangeM, 0);
  assert.deepEqual(data.odom.pose, [0, -1, 0]);
  assert.equal(data.environment.digital.mq2.triggered, false);
  assert.equal(data.environment.digital.mq2.valid, true);
  assert.deepEqual(data.localization.map_pose, [5, -1, 0.3]);
  assert.deepEqual(data.leadscrew.status.state, [4, 4]);
  assert.equal(data.batteryVoltage, null);
  assert.equal(data.observedAt, new Date(1791513351230).toISOString());
});

test('小车传感器独立检查年龄，过期缓存及错误数据不成为实时值', async () => {
  for (const change of [{ age_s: 11 }, { age_s: -1 }, { age_s: null }, { age_s: '0.1' }, { available: false }, { stale: true }, { temperature_c: '23.7', humidity_percent: 101 }]) {
    const status = fixture(); Object.assign(status.environment, change);
    const data = await read(status);
    assert.equal(data.environment.temperatureC, null);
    assert.equal(data.environment.humidityPercent, null);
    assert.equal(data.odom.speedMps, 0, '环境故障不影响有效里程计');
  }
  const status = fixture(); status.topic_ages_s.odom = 3;
  assert.equal((await read(status)).odom.speedMps, null);
  status.topic_ages_s.odom = 0.1; status.odom.speed_mps = null;
  assert.equal((await read(status)).odom.speedMps, null, '缺失速度不能判为驻停');
  for (const change of [{ age_s: 3 }, { triggered: 1 }, { available: false }, { stale: true }]) {
    const status = fixture(); Object.assign(status.environment.digital.tilt, change);
    const data = await read(status);
    assert.equal(data.environment.digital.tilt.triggered, null);
    assert.equal(data.environment.digital.flame.triggered, false, '数字传感器独立失效');
  }
});

test('小车缺失字段、非法位姿与超范围时间戳不导致 API 崩溃', async () => {
  const data = await read({ server_time_ms: 1e100, odom: { pose: [0, '1', 0] } });
  assert.equal(data.observedAt, null);
  assert.equal(data.odom.pose, null);
  assert.equal(data.odom.speedMps, null);
  assert.equal(data.environment.temperatureC, null);
  assert.equal(data.environment.digital.mq2.valid, false);
  assert.equal(data.batteryVoltage, null);
});
