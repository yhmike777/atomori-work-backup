import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamIntegrations } from '../src/upstream.js';

test('Mission Planner 使用专用来源，未收到数据时不回退到树莓派或演示值', async () => {
  const waiting = { deviceId: 'UAV-01', source: 'mission-planner-mavlink', flight: { connected: false, metrics: {} } };
  const integrations = createUpstreamIntegrations({ missionPlannerUrl: 'http://mirror', fetchImpl: async () => Response.json(waiting) });
  assert.equal(integrations.status().missionPlannerConfigured, true);
  assert.equal(integrations.status().commandsEnabled, false);
  assert.equal(integrations.status().uavFlightSource, 'mission-planner');
  const result = await integrations.missionPlanner();
  assert.equal(result.source, waiting.source);
  assert.equal(result.flight.connected, false);
  assert.equal(result.flight.rollDeg, null);
  await assert.rejects(createUpstreamIntegrations({ uavFlightUrl: 'http://pi' }).missionPlanner(), /尚未配置/);
  const invalid = createUpstreamIntegrations({ missionPlannerUrl: 'http://mirror', fetchImpl: async () => Response.json({ ...waiting, source: 'uav-rpi-deploy' }) });
  await assert.rejects(invalid.missionPlanner(), /响应无效/);
});

const metric = (value, ageS = 0.1, maxAgeS = 1) => ({ value, ageS, maxAgeS, valid: true, reason: 'VALID' });
const sample = overrides => ({ deviceId: 'UAV-01', source: 'mission-planner-mavlink', transport: { acceptedMessages: 42 },
  flight: { connected: true, stateAgeS: 0.1, armed: false, mode: 'STABILIZE', metrics: {
    roll: metric(12), pitch: metric(-3), batteryVoltage: metric(23.8), batteryPercent: metric(0),
    rangefinder: metric(1.2), relativeAltitude: metric(8)
  }, ...overrides } });

test('MP 与树莓派同时配置时明确选择 MP，总览数值保留来源且不冒充离地高度', async () => {
  const integrations = createUpstreamIntegrations({ missionPlannerUrl: 'http://mirror', uavFlightUrl: 'http://pi',
    fetchImpl: async () => Response.json(sample()) });
  assert.equal(integrations.status().uavFlightSource, 'mission-planner');
  const result = await integrations.missionPlanner();
  assert.equal(result.flight.rollDeg, 12);
  assert.equal(result.flight.pitchDeg, -3);
  assert.equal(result.flight.batteryVoltage, 23.8);
  assert.equal(result.flight.batteryPercent, 0);
  assert.equal(result.flight.rangefinderM, null);
  assert.equal(result.flight.metrics.rangefinder.value, 1.2);
  assert.equal(result.transport.acceptedMessages, 42);
  assert.equal(createUpstreamIntegrations({ uavFlightUrl: 'http://pi' }).status().uavFlightSource, 'raspberry-pi');
});

test('MP 未知样本年龄、过期指标与零电压均不成为总览有效数据', async () => {
  const integrations = createUpstreamIntegrations({ missionPlannerUrl: 'http://mirror', fetchImpl: async () => Response.json(sample({ metrics: {
    roll: metric(12, null), pitch: metric(-3, 2), batteryVoltage: metric(0), batteryPercent: metric(0)
  } })) });
  const { flight } = await integrations.missionPlanner();
  assert.equal(flight.connected, true);
  assert.equal(flight.rollDeg, null);
  assert.equal(flight.pitchDeg, null);
  assert.equal(flight.batteryVoltage, null);
  assert.equal(flight.metrics.batteryVoltage.valid, false);
  assert.equal(flight.batteryPercent, 0);
});

test('MP 请求期间心跳超过有效期时清空数据，不从响应完成重新计算年龄', async () => {
  const integrations = createUpstreamIntegrations({ missionPlannerUrl: 'http://mirror', fetchImpl: async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    return Response.json(sample({ stateAgeS: 1.95 }));
  } });
  const result = await integrations.missionPlanner();
  assert.equal(result.ageIncludes, 'device-http-and-response-wait');
  assert.ok(result.snapshotAgeS >= 0.07);
  assert.ok(result.flight.stateAgeS > 2);
  assert.equal(result.flight.connected, false);
  assert.equal(result.flight.mode, 'DISCONNECTED');
  assert.equal(result.flight.armed, null);
  assert.equal(result.flight.rollDeg, null);
});
