import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';
import { LastValidCache, lastValidSample } from '../src/last-valid.js';

const metric = (value, source = '/mavros/battery', unit = 'A') => ({
  value, valid: true, age_s: 0.1, max_age_s: 3, unit, source, age_basis: 'bridge_receive_monotonic'
});
const flight = () => ({ flight_controller_connected: true, vehicle_state_age_s: 0.1,
  armed: false, mode: 'STABILIZE', extended_state_age_s: 0.1, landed_state: 'ON_GROUND',
  telemetry: { roll_deg: 12.5, battery_voltage_v: 12.4 },
  telemetry_meta: { roll_deg: { valid: true, age_s: 0.1, unit: 'deg', source: '/mavros/imu/data' },
    battery_voltage_v: { valid: true, age_s: 0.1, unit: 'V', source: '/mavros/battery' } },
  extra_metrics: { batteryCurrent: metric(-1.09), batteryPresent: metric(1, '/mavros/battery', '') }
});
const car = () => ({ gateway: { uptime_s: 100 }, odom: { speed_mps: 0 }, topic_ages_s: { odom: 0.1 },
  environment: { available: true, stale: false, age_s: 0.1, temperature_c: 25, humidity_percent: 48,
    digital: { mq2: { available: true, stale: false, age_s: 0.1, triggered: false } },
    analog: { available: true, stale: false, age_s: 0.1, reference_v: 3.3,
      channels: { mq2: { raw: 200, adc_voltage_v: 1.2, reference_estimate: { status: 'reference_only', ppm: 38487, calibrated: false } } } } }
});
function rig(options, initial) {
  let time = 0, raw = initial, error = false, delay = 0, calls = 0;
  const api = createUpstreamIntegrations({ ...options, now: () => time,
    fetchImpl: async () => { calls++; time += delay; if (error) throw new Error('offline'); return Response.json(raw); } });
  return { api, set: value => { raw = value; }, fail: value => { error = value; }, delay: value => { delay = value; },
    advance: value => { time += value; }, calls: () => calls };
}

test('HTTP 途中失效的姿态保留最后有效值和完整年龄，实时 0.5 秒门限不变', async () => {
  const r = rig({ uavFlightUrl: 'http://pi' }, flight()); r.delay(700);
  const data = await r.api.telemetry('UAV-01', 'flight'), roll = data.flight.metrics.roll;
  assert.equal(roll.valid, false); assert.equal(roll.value, null); assert.equal(roll.maxAgeS, 0.5);
  assert.equal(roll.lastValid.value, 12.5); assert.ok(Math.abs(roll.lastValid.ageS - 0.8) < 1e-9);
  assert.equal(roll.lastValid.source, '/mavros/imu/data');
  assert.equal(data.flight.details.metrics.batteryCurrent.lastValid.value, -1.09);
});

test('断网时清空实时值和连接，历史年龄跨失败请求累计且恢复后更新', async () => {
  const r = rig({ uavFlightUrl: 'http://pi' }, flight());
  await r.api.telemetry('UAV-01', 'flight'); r.advance(1000); r.fail(true);
  const first = await r.api.telemetry('UAV-01', 'flight');
  assert.equal(first.upstreamAvailable, false); assert.equal(first.transport.available, false);
  assert.equal(first.flight.connected, false); assert.equal(first.flight.armed, null);
  assert.equal(first.flight.metrics.batteryVoltage.value, null);
  assert.equal(first.flight.metrics.batteryVoltage.lastValid.ageS, 1.1);
  r.advance(2000);
  const second = await r.api.telemetry('UAV-01', 'flight');
  assert.equal(second.flight.metrics.roll.lastValid.ageS, 3.1);
  assert.equal(second.flight.stateAgeS, 3.1);
  r.fail(false); const fresh = flight(); fresh.telemetry.roll_deg = 9; r.set(fresh);
  const restored = await r.api.telemetry('UAV-01', 'flight');
  assert.equal(restored.flight.metrics.roll.value, 9); assert.equal(restored.flight.metrics.roll.lastValid.value, 9);
  assert.equal(restored.flight.metrics.roll.lastValid.ageS, 0.1);
});

test('非法、单位不符、源端过期和未知年龄不能首次建立 lastValid', async () => {
  for (const update of [x => { x.telemetry.roll_deg = 900; }, x => { x.telemetry_meta.roll_deg.unit = 'rad'; },
    x => { x.telemetry_meta.roll_deg.age_s = 1; }, x => { x.telemetry_meta.roll_deg.age_s = null; },
    x => { x.telemetry_meta.roll_deg.valid = false; }, x => { x.flight_controller_connected = false; }]) {
    const raw = flight(); update(raw); raw.telemetry_meta.roll_deg.lastValid = { value: 444 };
    const r = rig({ uavFlightUrl: 'http://pi' }, raw);
    assert.equal((await r.api.telemetry('UAV-01', 'flight')).flight.metrics.roll.lastValid, null);
  }
  const raw = flight(); raw.extra_metrics.batteryCurrent = { ...metric(null), valid: false, raw_value: 999, lastValid: { value: 999 } };
  const r = rig({ uavFlightUrl: 'http://pi' }, raw);
  assert.equal((await r.api.telemetry('UAV-01', 'flight')).flight.details.metrics.batteryCurrent.lastValid, null);
});

test('后续无效值不刷新旧样本，缩短通道仍实时失效', async () => {
  const raw = flight(); raw.extra_metrics.rcInput3 = metric(1600, '/mavros/rc/in', 'µs');
  const r = rig({ uavFlightUrl: 'http://pi' }, raw); await r.api.telemetry('UAV-01', 'flight');
  r.advance(2000); raw.extra_metrics.rcInput3 = { ...raw.extra_metrics.rcInput3, valid: false, value: null, raw_value: 0, reason: 'INVALID' }; r.set(raw);
  const item = (await r.api.telemetry('UAV-01', 'flight')).flight.details.metrics.rcInput3;
  assert.equal(item.value, null); assert.equal(item.valid, false);
  assert.equal(item.lastValid.value, 1600); assert.equal(item.lastValid.ageS, 2.1);
});

test('UGV 短断网保留数值/开关/ADC 模型参考值，在线和电池会话门控失效', async () => {
  const r = rig({ carUrl: 'http://car' }, car()); await r.api.telemetry('UGV-01');
  r.advance(100); r.fail(true);
  const data = await r.api.telemetry('UGV-01');
  assert.equal(data.receivedAt, null); assert.equal(data.upstreamAvailable, false);
  assert.equal(data.metrics.speed.value, null); assert.equal(data.odom.speedMps, null);
  assert.equal(data.metrics.speed.lastValid.value, 0); assert.equal(data.metrics.speed.lastValid.ageS, 0.2);
  const smoke = data.environment.sensors.smoke;
  assert.equal(smoke.digital.triggered, null); assert.equal(smoke.digital.lastValid.value, false);
  assert.equal(smoke.analog.voltageV, null); assert.equal(smoke.analog.voltageLastValid.value, 1.2);
  assert.equal(smoke.analog.rawLastValid.value, 200);
  assert.equal(smoke.analog.referenceEstimate.ppm, null); assert.equal(smoke.analog.referenceEstimate.lastValid.value, 38487);
  assert.equal(smoke.analog.referenceEstimate.calibrated, false);
});

test('UGV 源端有效但 HTTP 延迟超过各自窗口，只保留历史值', async () => {
  const r = rig({ carUrl: 'http://car' }, car()); r.delay(2100);
  const data = await r.api.telemetry('UGV-01');
  assert.equal(data.metrics.speed.value, null); assert.equal(data.metrics.speed.lastValid.ageS, 2.2);
  assert.equal(data.environment.digital.mq2.triggered, null);
  assert.equal(data.environment.digital.mq2.lastValid.value, false);
  assert.equal(data.environment.analog.channels.mq2.referenceEstimate.lastValid.ageS, 2.2);
  assert.equal(data.metrics.temperature.valid, true, '15 秒 DHT 窗口保持原状');
});

test('车端重启不借用前一网关会话的历史数值', async () => {
  const r = rig({ carUrl: 'http://car' }, car()); const before = await r.api.telemetry('UGV-01');
  const restarted = car(); restarted.gateway.uptime_s = 1; restarted.topic_ages_s.odom = null; r.set(restarted);
  const after = await r.api.telemetry('UGV-01');
  assert.notEqual(after.sourceIdentity, before.sourceIdentity); assert.equal(after.metrics.speed.lastValid, null);
});

test('Mission Planner 身份按 SYS/COMP/peer 隔离，切源不会串用历史', async () => {
  const mp = () => ({ source: 'mission-planner-mavlink', deviceId: 'UAV-01', transport: { systemId: 1, componentId: 1, peerIp: '192.168.1.7' },
    flight: { connected: true, stateAgeS: 0.1, metrics: { roll: { value: 3, valid: true, ageS: 0.1, maxAgeS: 0.5, unit: 'deg', source: 'ATTITUDE' } } } });
  const r = rig({ missionPlannerUrl: 'http://mp', uavFlightUrl: 'http://pi' }, mp());
  const before = await r.api.missionPlanner();
  for (const change of [{ systemId: 2 }, { componentId: 2 }, { peerIp: '192.168.1.8' }]) {
    const raw = mp(); Object.assign(raw.transport, change); raw.flight.metrics.roll.value = null; raw.flight.metrics.roll.valid = false; r.set(raw);
    const after = await r.api.missionPlanner();
    assert.notEqual(after.sourceIdentity, before.sourceIdentity); assert.equal(after.flight.metrics.roll.lastValid, null);
  }
  r.set(flight()); const pi = await r.api.telemetry('UAV-01', 'flight');
  assert.notEqual(pi.sourceIdentity, before.sourceIdentity); assert.equal(pi.flight.metrics.roll.lastValid.value, 12.5);
});

test('主控和详情同时请求只读取一次源，后加入者保留完整请求时间', async () => {
  let time = 0, calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const api = createUpstreamIntegrations({ uavFlightUrl: 'http://pi', now: () => time,
    fetchImpl: async () => { calls++; await gate; return Response.json(flight()); } });
  const first = api.telemetry('UAV-01', 'flight'); time = 500;
  const second = api.telemetry('UAV-01', 'flight'); time = 700; release();
  const data = await Promise.all([first, second]);
  assert.equal(calls, 1);
  for (const item of data) assert.ok(Math.abs(item.flight.metrics.roll.lastValid.ageS - 0.8) < 1e-9);
  await api.telemetry('UAV-01', 'flight'); assert.equal(calls, 2, '完成后下一轮仍真正查询，不延长新鲜度');
});

test('第一次即失败保持原错误，超出 5 分钟保留期也不伪造快照', async () => {
  const empty = rig({ carUrl: 'http://car' }, car()); empty.fail(true);
  await assert.rejects(empty.api.telemetry('UGV-01'), error => error.code === 'UPSTREAM_UNAVAILABLE');
  const old = rig({ carUrl: 'http://car' }, car()); await old.api.telemetry('UGV-01'); old.advance(301000); old.fail(true);
  await assert.rejects(old.api.telemetry('UGV-01'), error => error.code === 'UPSTREAM_UNAVAILABLE');
});

test('显示缓存容量和保留期有界，不能跨单位或源路径混用', () => {
  let now = 0;
  const cache = new LastValidCache({ now: () => now, maxEntries: 2, retentionS: 5 });
  const sample = source => ({ source, unit: 'V', lastValid: lastValidSample({ value: 0, valid: true, ageS: 0.1, maxAgeS: 1, unit: 'V', source }) });
  for (let i = 0; i < 3; i++) cache.metric('device', `metric${i}`, sample('/source'));
  assert.equal(cache.entries.size, 2);
  const other = sample('/other'); other.lastValid = null; cache.metric('device', 'metric2', other); assert.equal(other.lastValid, null);
  const wrongUnit = { ...sample('/source'), unit: 'A', lastValid: null };
  cache.metric('device', 'metric2', wrongUnit); assert.equal(wrongUnit.lastValid, null);
  now = 6000; const stale = sample('/source'); stale.lastValid = null; cache.metric('device', 'metric2', stale);
  assert.equal(stale.lastValid, null); assert.equal(cache.entries.size, 0);
});
