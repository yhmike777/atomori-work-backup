import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';

function fixture() {
  const telemetry = { battery_voltage_v: 23.8, battery_remaining_pct: 0, relative_altitude_m: -0.25, estimated_altitude_m: 9, rangefinder_m: 1.18 };
  const telemetry_meta = Object.fromEntries(Object.keys(telemetry).map(key => [key, { unit: key === 'battery_voltage_v' ? 'V' : key === 'battery_remaining_pct' ? '%' : 'm', age_s: 0.1, valid: true, age_basis: 'bridge_receive_monotonic' }]));
  return { flight_controller_connected: true, vehicle_state_age_s: 0.1, telemetry, telemetry_meta };
}
function adapter(status, visionFails = false) {
  return createUpstreamIntegrations({ uavFlightUrl: 'http://flight', uavVisionUrl: 'http://vision', fetchImpl: async url => {
    if (url.startsWith('http://vision')) { if (visionFails) throw new Error('offline'); return Response.json({ sensor: 'ov9281' }); }
    return Response.json(status);
  } });
}

test('姿态只显示新鲜的真实度数；零角度有效，缺少元数据或错误单位时清空', async () => {
  const status = fixture();
  Object.assign(status.telemetry, { roll_deg: 0, pitch_deg: -8.2 });
  for (const key of ['roll_deg', 'pitch_deg']) status.telemetry_meta[key] = { unit: 'deg', valid: true, age_s: 0.1 };
  let data = await adapter(status, true).telemetry('UAV-01');
  assert.equal(data.flight.rollDeg, 0);
  assert.equal(data.flight.pitchDeg, -8.2);
  for (const change of [{ age_s: 0.6 }, { unit: 'rad' }, { valid: false }]) {
    status.telemetry_meta.roll_deg = { unit: 'deg', valid: true, age_s: 0.1, ...change };
    data = await adapter(status).telemetry('UAV-01');
    assert.equal(data.flight.rollDeg, null);
    assert.equal(data.flight.pitchDeg, -8.2);
    assert.equal(data.flight.rangefinderM, 1.18);
  }
  delete status.telemetry_meta.roll_deg;
  assert.equal((await adapter(status).telemetry('UAV-01')).flight.rollDeg, null);
  status.telemetry.pitch_deg = 91;
  assert.equal((await adapter(status).telemetry('UAV-01')).flight.pitchDeg, null);
});
test('真实字段独立映射，零电量和负相对高度有效，视觉离线不阻断飞控数据', async () => {
  const status = fixture();
  const data = await adapter(status, true).telemetry('UAV-01');
  assert.equal(data.flight.batteryVoltage, 23.8);
  assert.equal(data.flight.batteryPercent, 0);
  assert.equal(data.flight.relativeAltitudeM, -0.25);
  assert.equal(data.flight.estimatedAltitudeM, 9);
  status.telemetry.battery_voltage_v = 0;
  status.telemetry_meta.battery_voltage_v.age_s = 0.1;
  assert.equal((await adapter(status).telemetry('UAV-01')).flight.batteryVoltage, null);
  assert.equal(data.flight.rangefinderM, 1.18);
  assert.equal(data.vision.sensor, 'UNKNOWN');
  assert.equal(data.flight.metrics.batteryPercent.ageBasis, 'bridge_receive_monotonic');
  assert.equal(adapter(fixture()).status().commandsEnabled, false);
});
test('飞控断连或状态过期时真实遥测全部清空', async () => {
  for (const change of [{ flight_controller_connected: false }, { vehicle_state_age_s: 3 }, { vehicle_state_age_s: null }]) {
    const data = await adapter({ ...fixture(), ...change }).telemetry('UAV-01');
    for (const metric of Object.values(data.flight.metrics)) { assert.equal(metric.value, null); assert.equal(metric.valid, false); }
  }
});
test('未上报、越界、单位错误及过期值不显示，也不从其他高度或电压估算', async () => {
  const status = fixture();
  status.telemetry.battery_remaining_pct = 101;
  status.telemetry_meta.battery_voltage_v.age_s = 4;
  status.telemetry_meta.relative_altitude_m.unit = 'mm';
  status.telemetry_meta.rangefinder_m.valid = false;
  const data = await adapter(status).telemetry('UAV-01');
  assert.equal(data.flight.batteryPercent, null);
  assert.equal(data.flight.batteryVoltage, null);
  assert.equal(data.flight.relativeAltitudeM, null);
  assert.equal(data.flight.rangefinderM, null);
  assert.equal(data.flight.estimatedAltitudeM, 9);
  delete status.telemetry_meta;
  const legacy = await adapter(status).telemetry('UAV-01');
  assert.equal(legacy.flight.batteryVoltage, null);
  assert.equal(legacy.flight.relativeAltitudeM, null);
  assert.equal(legacy.flight.estimatedAltitudeM, 9);
});

test('落地时 home 估计 4 米不能当成离地高度；原估计保留，地面状态必须新鲜', async () => {
  const status = fixture();
  Object.assign(status, { landed_state: 'ON_GROUND', extended_state_age_s: 0.1 });
  Object.assign(status.telemetry, { relative_altitude_m: 4.34, rangefinder_m: 0.08 });
  const data = await adapter(status).telemetry('UAV-01');
  assert.equal(data.flight.landedState, 'ON_GROUND');
  assert.equal(data.flight.rangefinderM, 0.08);
  assert.equal(data.flight.relativeAltitudeM, 4.34, '不修改真实原始 home 估计');
  assert.equal(data.flight.heightAboveGroundM, null, '不强制归零或用传感器斜距替代机体高度');
  assert.equal(data.flight.heightAboveGroundStatus, 'NOT_CALIBRATED');
  assert.equal(data.flight.metrics.relativeAltitude.kind, 'estimate');
  assert.equal(data.flight.metrics.relativeAltitude.referenceVerified, false);
  for (const age of [null, -1, 3]) {
    status.extended_state_age_s = age;
    assert.equal((await adapter(status).telemetry('UAV-01')).flight.landedState, 'UNKNOWN');
  }
  status.extended_state_age_s = 0.1;
  status.flight_controller_connected = false;
  assert.equal((await adapter(status).telemetry('UAV-01')).flight.landedState, 'UNKNOWN');
});

test('详情页按桥有效性与机体坐标系显示运动、油门和 RC，断连时清空', async () => {
  const status = fixture();
  Object.assign(status.telemetry, { vertical_speed_mps: 0, motor_throttle_pct: 0, rc3_pwm: 1500, vfr_altitude_msl_m: -1.5 });
  Object.assign(status, { body_velocity_frame: 'base_link', body_velocity_mps: { x: 0, y: -0.2, z: 0.3 }, velocity_age_s: 0.1, system_status: 3 });
  let details = (await adapter(status).telemetry('UAV-01')).flight.details;
  assert.equal(details.metrics.verticalSpeed.value, 0);
  assert.equal(details.metrics.throttle.value, 0);
  assert.equal(details.metrics.rc3.value, 1500);
  assert.equal(details.metrics.altitudeMsl.value, -1.5);
  assert.equal(details.metrics.velocityY.value, -0.2);
  assert.equal(details.systemStatus, 3);
  status.body_velocity_frame = 'map';
  details = (await adapter(status).telemetry('UAV-01')).flight.details;
  assert.equal(details.metrics.velocityX.value, null, '未知机体坐标系不解释为前进速度');
  status.flight_controller_connected = false;
  details = (await adapter(status).telemetry('UAV-01')).flight.details;
  assert.equal(details.systemStatus, null);
  for (const metric of Object.values(details.metrics)) assert.equal(metric.value, null);
  status.flight_controller_connected = true;
  status.vehicle_state_age_s = 1.5;
  assert.equal((await adapter(status).telemetry('UAV-01')).flight.details.metrics.rc3.value, null);
});
