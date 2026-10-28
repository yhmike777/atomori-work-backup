import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFlightDetails } from '../src/flight-details.js';
import { createUpstreamIntegrations } from '../src/upstream.js';

const sample = (overrides = {}) => ({ value: 0, label: '真实读数', group: '电池', unit: 'A', digits: 2,
  source: '/mavros/battery.current', age_s: 0.1, max_age_s: 3, valid: true, reason: 'VALID', ...overrides });
const rawFlight = () => ({ flight_controller_connected: true, vehicle_state_age_s: 0.1,
  telemetry: { roll_deg: 2, heading_deg: 135 }, telemetry_meta: {
    roll_deg: { unit: 'deg', age_s: 0.1, valid: true }, heading_deg: { unit: 'deg', age_s: 0.1, valid: true }
  } });

test('旧桥未接入扩展与新桥暂无样本分开，不编造 MAVLink 故障或自检', () => {
  const legacy = normalizeFlightDetails({}, 0.2, true), empty = normalizeFlightDetails({ extra_metrics: {}, telemetry_sources: [] }, 0.2, true);
  assert.equal(legacy.metrics.batteryCurrent.reason, 'NOT_CONNECTED');
  assert.equal(empty.metrics.batteryCurrent.reason, 'NO_SAMPLE');
  assert.equal(legacy.extraTelemetryStatus, 'NOT_CONNECTED');
  assert.equal(empty.extraTelemetryStatus, 'CONNECTED');
  assert.equal(legacy.telemetrySourcesStatus, 'NOT_CONNECTED');
  assert.deepEqual(legacy.telemetrySources, []);
  assert.equal(legacy.health, undefined);
  for (const key of ['motionCommand', 'executor', 'velocity']) {
    assert.equal(legacy[key], null);
    assert.equal(legacy[`${key}Status`], 'NOT_CONNECTED');
  }
});

test('动态指标独立校验并保留标签、组、精度和无效原始诊断值', () => {
  const details = normalizeFlightDetails({ extra_metrics: {
    batteryCurrent: sample(), rcInput18: sample({ value: 1500, unit: 'µs', group: '遥控输入', digits: 0 }),
    batteryCell6: sample({ value: null, raw_value: -1, unit: 'V', valid: false, reason: 'SENTINEL_VALUE' }),
    stale: sample({ age_s: 2.95 }), __bad: sample(), constructor: sample()
  } }, 0.1, true);
  assert.equal(details.metrics.batteryCurrent.value, 0);
  assert.equal(details.metrics.batteryCurrent.ageS, 0.2);
  assert.equal(details.metrics.rcInput18.value, 1500);
  assert.equal(details.metrics.rcInput18.group, '遥控输入');
  assert.equal(details.metrics.rcInput18.digits, 0);
  assert.equal(details.metrics.batteryCell6.value, null);
  assert.equal(details.metrics.batteryCell6.rawValue, -1);
  assert.equal(details.metrics.batteryCell6.reason, 'SENTINEL_VALUE');
  assert.equal(details.metrics.stale.reason, 'STALE');
  assert.equal(details.metrics.stale.value, null);
  assert.equal(Object.hasOwn(details.metrics, '__bad'), false);
  assert.equal(Object.hasOwn(details.metrics, 'constructor'), false);
});

test('上游 valid 不能绕过数值、年龄、单位/来源元数据及心跳检查', () => {
  for (const [overrides, reason] of [
    [{ value: '2.1' }, 'NO_VALID_SAMPLE'], [{ value: Infinity }, 'NO_VALID_SAMPLE'], [{ value: NaN }, 'NO_VALID_SAMPLE'],
    [{ age_s: -1 }, 'UNKNOWN_AGE'], [{ age_s: null }, 'UNKNOWN_AGE'], [{ max_age_s: -1 }, 'INVALID_METADATA'],
    [{ max_age_s: Infinity }, 'INVALID_METADATA'], [{ source: '' }, 'INVALID_METADATA'], [{ unit: null }, 'INVALID_METADATA'], [{ unit: 'mA' }, 'INVALID_METADATA'],
    [{ valid: false, reason: 'VALID' }, 'NO_VALID_SAMPLE']
  ]) {
    const result = normalizeFlightDetails({ extra_metrics: { batteryCurrent: sample(overrides) } }, 0.1, true).metrics.batteryCurrent;
    assert.equal(result.valid, false);
    assert.equal(result.value, null);
    assert.equal(result.reason, reason);
  }
  const disconnected = normalizeFlightDetails({ extra_metrics: { batteryCurrent: sample() } }, 0.1, false).metrics.batteryCurrent;
  assert.equal(disconnected.reason, 'FLIGHT_CONTROLLER_DISCONNECTED');
  assert.equal(disconnected.rawValue, 0);
});

test('无效读数保留布尔/字符串原值供诊断，绝不转换成有效数字', () => {
  for (const value of [false, true, 'not-a-number', '0', null]) {
    const item = normalizeFlightDetails({ extra_metrics: { diagnosticValue: sample({ valid: false, value: null, raw_value: value, reason: 'INVALID' }) } }, 0.1, true).metrics.diagnosticValue;
    assert.equal(item.value, null);
    assert.equal(item.valid, false);
    assert.equal(item.rawValue, value);
    assert.equal(item.reason, 'INVALID');
  }
  const booleanFlag = normalizeFlightDetails({ extra_metrics: { batteryPresent: sample({ value: 0, raw_value: false, unit: '' }) } }, 0.1, true).metrics.batteryPresent;
  assert.equal(booleanFlag.value, 0);
  assert.equal(booleanFlag.rawValue, false);
});

test('来源诊断保留原数据并累计 HTTP 年龄，过期行必须明确 STALE', () => {
  const source = { topic: '/mavros/battery', message_type: 'sensor_msgs/BatteryState', count: 4, age_s: 2.95, max_age_s: 3,
    status: 'RECEIVING', data: { current: -1, cell_voltage: [3.2, null] } };
  const details = normalizeFlightDetails({ telemetry_sources: [source, { ...source, topic: '/never', count: 0, age_s: null },
    { ...source, topic: '/invalid', count: -1 }, { ...source, topic: '/unsupported', status: 'UNSUPPORTED_TYPE', count: 0, age_s: null, error: 'ImportError: message type missing' },
    { ...source, topic: '/fresh', age_s: 0.1 }] }, 0.1, true);
  assert.equal(details.telemetrySources[0].status, 'STALE');
  assert.equal(details.telemetrySources[0].valid, false);
  assert.deepEqual(details.telemetrySources[0].data, source.data);
  assert.equal(details.telemetrySources[0].messageType, source.message_type);
  assert.equal(details.telemetrySources[1].status, 'NO_SAMPLE');
  assert.equal(details.telemetrySources[2].status, 'INVALID_METADATA');
  assert.equal(details.telemetrySources[3].status, 'UNSUPPORTED_TYPE');
  assert.equal(details.telemetrySources[3].valid, false);
  assert.equal(details.telemetrySources[3].error, 'ImportError: message type missing');
  assert.equal(details.telemetrySources[4].status, 'RECEIVING');
  assert.equal(details.telemetrySources[4].valid, true);
  assert.equal(source.age_s, 2.95, '不修改输入快照');
});

test('真实健康与告警保持来源并各自加年龄，不把零传感器数据推断为正常', () => {
  const result = normalizeFlightDetails({ health: [{ label: '陀螺仪', state: '未启用', source: 'SYS_STATUS' }, { state: '正常' }], health_age_s: 2.95,
    alerts: [{ severity: 4, text: 'PreArm: GPS unavailable', age_s: 29.95 }, { severity: 999, text: 'invalid', age_s: 0 },
      { severity: 6, text: 'real message', age_s: 0 }] }, 0.1, true);
  assert.equal(result.health.length, 1);
  assert.equal(result.health[0].state, '未启用');
  assert.equal(result.health[0].source, 'SYS_STATUS');
  assert.equal(result.healthValid, false);
  assert.ok(result.healthAgeS > 3);
  assert.equal(result.alerts.length, 2);
  assert.equal(result.alerts[0].valid, false);
  assert.ok(result.alerts[0].ageS > 30);
  assert.equal(result.alerts[1].valid, true);
  assert.equal(normalizeFlightDetails({ health: [], health_age_s: 0 }, 0.1, true).healthValid, false);
});

test('缩短 RC 数组后的无效字段不能保留上一帧通道值', () => {
  const first = normalizeFlightDetails({ extra_metrics: { rcInput3: sample({ value: 1600, raw_value: 1600, unit: 'µs' }) } }, 0.1, true);
  assert.equal(first.metrics.rcInput3.value, 1600);
  const next = normalizeFlightDetails({ extra_metrics: { rcInput3: sample({ value: null, raw_value: null, valid: false, reason: 'INVALID', unit: 'µs' }) } }, 0.1, true);
  assert.equal(next.metrics.rcInput3.value, null);
  assert.equal(next.metrics.rcInput3.rawValue, null);
  assert.equal(next.metrics.rcInput3.valid, false);
});

test('动作、执行器和速度诊断使用自己的年龄，既不复用心跳也不抛弃方向与状态', () => {
  const source = { motion_command: { state: 'READY', source: '/mavros/setpoint_raw/local', age_s: 0.45,
    body_frame: 'FLU', body_velocity_mps: { x: 0, y: 0, z: 0 }, yaw_rate_rad_s: 0 },
    guided_executor_age_s: 0.3, action: 'hold', action_state: 'READY', action_detail: { stage: 'waiting' },
    target_echo_age_s: 0.2, tone_active: false, orphaned_guided_reason: 'none', vehicle_state_age_s: 0,
    velocity_age_s: 0.2, body_velocity_mps: { x: 0, y: -0.2, z: 0 }, body_velocity_frame: 'base_link',
    horizontal_direction: 'STILL', lateral_direction: 'RIGHT', vertical_direction: 'STILL', velocity_deadband_mps: 0.05 };
  const details = normalizeFlightDetails(source, 0.1, true);
  assert.equal(details.motionCommand.status, 'STALE');
  assert.equal(details.motionCommand.data.state, 'READY', '原始状态仅作为明确过期的诊断保留');
  assert.equal(details.executor.ageS, 0.4);
  assert.equal(details.executor.data.tone_active, false);
  assert.equal(details.executor.data.target_echo_age_s, 0.2);
  assert.equal(details.velocity.valid, true);
  assert.equal(details.velocity.data.lateral_direction, 'RIGHT');
  source.velocity_age_s = null;
  assert.equal(normalizeFlightDetails(source, 0.1, true).velocity.status, 'NO_SAMPLE');
});

test('扩展不能覆盖既有姿态/机体坐标门控，并仅累计一次本机请求时间', async () => {
  const raw = rawFlight();
  raw.extra_metrics = { batteryCurrent: sample({ age_s: 2.98 }), roll: sample({ value: 99 }), heading: sample({ value: 99 }),
    velocityX: sample({ value: 99 }), rcOutput1: sample({ value: 1000, unit: 'µs' }) };
  raw.telemetry_sources = [{ topic: '/test', message_type: 'Test', count: 1, age_s: 0.1, max_age_s: 3, status: 'RECEIVING', data: {} }];
  const adapter = createUpstreamIntegrations({ uavFlightUrl: 'http://flight', fetchImpl: async () => {
    await new Promise(resolve => setTimeout(resolve, 45)); return Response.json(raw);
  } });
  const data = await adapter.telemetry('UAV-01', 'flight');
  assert.equal(data.flight.metrics.roll.value, 2);
  assert.equal(Object.hasOwn(data.flight.details.metrics, 'roll'), false);
  assert.equal(data.flight.details.metrics.heading.value, 135);
  assert.equal(data.flight.details.metrics.velocityX.value, null);
  assert.equal(data.flight.details.metrics.batteryCurrent.reason, 'STALE');
  assert.equal(data.flight.details.metrics.rcOutput1.value, 1000);
  assert.ok(Math.abs(data.flight.details.telemetrySources[0].ageS - 0.1 - data.snapshotAgeS) < 0.02);
});
